/** Playwright provider for the browser capability seam. @module dsh-browser-playwright */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import Schema from '@deepseek-ai/schemastery';
import { BrowserError, BrowserRuntime, } from '@yeesy369/dsh-browser';
import { createUrlGuard } from './url-guard.js';
import { HIDDEN_WINDOW_ARGS, STEALTH_INIT_SCRIPT, STEALTH_LAUNCH_ARGS, } from './stealth.js';
/**
 * Prefer a locally installed real browser — Microsoft Edge first (the default
 * for this provider), then Chrome; fall back to the bundled Chromium when
 * neither is installed.
 */
function findBrowserChannel() {
    const candidates = [];
    if (process.platform === 'win32') {
        const pf = process.env.PROGRAMFILES;
        const pf86 = process.env['PROGRAMFILES(X86)'];
        const local = process.env.LOCALAPPDATA;
        candidates.push(['msedge', [
                pf86 && `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
                pf && `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
            ].filter((p) => Boolean(p))], ['chrome', [
                pf && `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
                local && `${local}\\Google\\Chrome\\Application\\chrome.exe`,
                pf86 && `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
            ].filter((p) => Boolean(p))]);
    }
    else if (process.platform === 'darwin') {
        candidates.push(['msedge', ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']], ['chrome', ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']]);
    }
    else {
        candidates.push(['msedge', ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']], ['chrome', ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']]);
    }
    for (const [channel, paths] of candidates) {
        for (const path of paths) {
            if (existsSync(path))
                return channel;
        }
    }
    return undefined;
}
function sessionKeyOf(options) {
    return options?.sessionKey || 'default';
}
export const name = 'browser-playwright';
/** Wait for Host settings so `register(..., { expose: 'web' })` actually runs. */
export const inject = ['settings'];
export const Config = Schema.object({
    windowVisibility: Schema.union(['visible', 'hidden', 'headless']).description('窗口模式：visible = 弹出真实浏览器窗口，可直接手动登录、处理验证码（缺点是每次使用都会打扰桌面）；' +
        'hidden = 真浏览器但窗口最小化并移到屏幕外，反爬最强且不打扰桌面（缺点：不能直接看窗口操作，登录需提前在 profile 里完成，且依赖桌面会话）；' +
        'headless = 完全不弹窗，适合服务器/CI（缺点：即使开了 stealth 补丁，强风控仍可能识别，且无法手动登录）。默认 visible。'),
    stealth: Schema.boolean().default(true).description('轻量反检测补丁：抹掉 navigator.webdriver、补全 plugins、伪装 WebGL 厂商等常见自动化指纹。默认开启；极少数站点可能因补丁行为异常，可关闭。'),
    allowFakeIp: Schema.boolean().default(true).description('允许 Clash/Surge 等代理的 fake-ip DNS（198.18.0.0/15）。本机开了 fake-ip 时若不开启，所有公网页都会被 SSRF 守卫误拦。默认开启；10/8、127/8 等真实内网地址仍会拦截。'),
    headless: Schema.boolean().description('已废弃：请改用 windowVisibility: "headless"。'),
    channel: Schema.union(['chrome', 'msedge']),
    profileDir: Schema.string(),
});
export function apply(ctx, config) {
    const settings = ctx.get('settings');
    const scope = settings.register(name, Config, {
        base: config,
        applies: 'restart',
        expose: 'web',
    });
    ctx.plugin(PlaywrightBrowserRuntime, scope.get());
}
class PlaywrightBrowserRuntime extends BrowserRuntime {
    config;
    browser = null;
    context = null;
    sessions = new Map();
    claimed = new WeakSet();
    nextPageId = 0;
    guard;
    constructor(ctx, config = {}) {
        super(ctx);
        this.config = { stealth: true, allowFakeIp: true, ...config };
        this.guard = createUrlGuard({
            allowPrivate: false,
            allowFakeIp: this.config.allowFakeIp !== false,
        });
        ctx.effect(() => () => this.close());
    }
    async newPage(options, _signal) {
        const key = sessionKeyOf(options);
        try {
            await this.ensureBrowser(options);
            return await this.activePage(key);
        }
        catch {
            await this.close();
            await this.ensureBrowser(options);
            return await this.activePage(key);
        }
    }
    async listTabs(sessionKey = 'default') {
        const session = this.sessions.get(sessionKey);
        if (!session)
            return [];
        const out = [];
        for (const [id, wrapper] of session.pages) {
            if (wrapper.isClosed())
                continue;
            out.push({
                id,
                url: wrapper.url(),
                title: await wrapper.title(),
                active: id === session.activeId,
            });
        }
        return out;
    }
    async openTab(options) {
        await this.ensureBrowser(options);
        const key = sessionKeyOf(options);
        const session = this.session(key);
        const page = await this.claimOrCreatePage();
        const wrapper = this.wrap(page, session);
        session.activeId = wrapper.id;
        return wrapper;
    }
    async switchTab(id, sessionKey = 'default') {
        const session = this.sessions.get(sessionKey);
        const wrapper = session?.pages.get(id);
        if (!session || !wrapper || wrapper.isClosed()) {
            throw new BrowserError('BROWSER_TAB_NOT_FOUND', `No open tab ${id} in session ${sessionKey}.`);
        }
        session.activeId = id;
        return wrapper;
    }
    async closeTab(id, sessionKey = 'default') {
        const session = this.sessions.get(sessionKey);
        const wrapper = session?.pages.get(id);
        if (!session || !wrapper)
            return;
        await wrapper.close();
        session.pages.delete(id);
        if (session.activeId === id) {
            const next = [...session.pages.keys()][0] ?? null;
            session.activeId = next;
        }
    }
    async close(_signal) {
        try {
            if (this.browser) {
                await this.browser.close();
            }
            else if (this.context) {
                await this.context.close();
            }
        }
        catch {
            // already closed — nothing to do
        }
        this.browser = null;
        this.context = null;
        this.sessions.clear();
    }
    session(key) {
        let session = this.sessions.get(key);
        if (!session) {
            session = { pages: new Map(), activeId: null };
            this.sessions.set(key, session);
        }
        return session;
    }
    async activePage(key) {
        const session = this.session(key);
        for (const [id, wrapper] of session.pages) {
            if (wrapper.isClosed())
                session.pages.delete(id);
        }
        if (session.activeId && !session.pages.has(session.activeId))
            session.activeId = null;
        if (session.activeId) {
            const existing = session.pages.get(session.activeId);
            if (existing && !existing.isClosed())
                return existing;
        }
        for (const [id, wrapper] of session.pages) {
            if (!wrapper.isClosed()) {
                session.activeId = id;
                return wrapper;
            }
        }
        const page = await this.claimOrCreatePage();
        const wrapper = this.wrap(page, session);
        session.activeId = wrapper.id;
        return wrapper;
    }
    wrap(page, session) {
        const id = `page-${this.nextPageId++}`;
        const wrapper = new PlaywrightBrowserPage(page, this.guard, id);
        session.pages.set(id, wrapper);
        return wrapper;
    }
    /**
     * Reuse an unclaimed launch tab instead of always creating a new one. On
     * launch the browser already opens one (about:blank) tab — creating another
     * one leaves a blank tab behind every time the browser (re)starts.
     */
    async claimOrCreatePage() {
        const existing = this.context.pages().find((p) => !p.isClosed() && !this.claimed.has(p));
        if (existing) {
            this.claimed.add(existing);
            return existing;
        }
        const page = await this.context.newPage();
        this.claimed.add(page);
        return page;
    }
    async ensureBrowser(options) {
        if (this.context && (!this.browser || this.browser.isConnected()))
            return;
        const visibility = options?.windowVisibility
            ?? this.config.windowVisibility
            ?? (this.config.headless ? 'headless' : 'visible');
        const headless = visibility === 'headless';
        const channel = options?.channel ?? this.config.channel ?? findBrowserChannel();
        const profileDir = options?.profileDir ?? this.config.profileDir ?? join(homedir(), '.dsh', 'edge-profile');
        const args = [
            ...(this.config.stealth ? STEALTH_LAUNCH_ARGS : []),
            ...(visibility === 'hidden' ? HIDDEN_WINDOW_ARGS : []),
        ];
        const launchOptions = {
            headless,
            args,
            ...(channel ? { channel } : {}),
        };
        try {
            this.context = await chromium.launchPersistentContext(profileDir, {
                viewport: options?.viewport,
                ...launchOptions,
            });
            if (this.config.stealth) {
                await this.context.addInitScript(STEALTH_INIT_SCRIPT);
            }
        }
        catch (cause) {
            throw new BrowserError('BROWSER_LAUNCH_FAILED', 'Failed to launch a browser. Install Microsoft Edge (or Chrome), or run `pnpm playwright install chromium`.', { cause });
        }
    }
}
class PlaywrightBrowserPage {
    page;
    guard;
    id;
    lastRefs = [];
    constructor(page, guard, id) {
        this.page = page;
        this.guard = guard;
        this.id = id;
    }
    isClosed() {
        return this.page.isClosed();
    }
    url() {
        return this.page.url() || null;
    }
    async title() {
        return (await this.page.title()) || null;
    }
    async navigate(raw, _signal) {
        const url = await this.guard.assertPublicHttpUrl(raw);
        const response = await this.page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
        return {
            url: this.page.url(),
            statusCode: response?.status() ?? null,
            title: (await this.page.title()) || null,
        };
    }
    async snapshot(_signal) {
        const text = await this.readSnapshot();
        this.lastRefs = extractAriaRefs(text);
        return { url: this.page.url(), text, refs: this.lastRefs };
    }
    async screenshot(_signal) {
        const data = await this.page.screenshot({ type: 'png', fullPage: false });
        const viewport = this.page.viewportSize();
        return {
            mediaType: 'image/png',
            data: new Uint8Array(data),
            width: viewport?.width ?? 0,
            height: viewport?.height ?? 0,
        };
    }
    async click(ref, _signal) {
        await this.locatorFor(ref).click({ timeout: 30_000 });
        return { url: this.page.url(), ok: true };
    }
    async type(text, _signal) {
        await this.page.keyboard.type(text);
        return { url: this.page.url(), ok: true };
    }
    async fill(ref, value, _signal) {
        await this.locatorFor(ref).fill(value, { timeout: 30_000 });
        return { url: this.page.url(), ok: true };
    }
    async press(key, ref, _signal) {
        if (ref)
            await this.locatorFor(ref).press(key, { timeout: 30_000 });
        else
            await this.page.keyboard.press(key);
        return { url: this.page.url(), ok: true };
    }
    async scroll(options, _signal) {
        const direction = options?.direction ?? 'down';
        const amount = options?.amount ?? 800;
        const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
        const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
        const before = await this.page.evaluate('({ x: window.scrollX, y: window.scrollY })');
        await this.page.evaluate(`window.scrollBy(${deltaX}, ${deltaY})`);
        await this.page.evaluate('new Promise((resolve) => requestAnimationFrame(() => resolve()))');
        const after = await this.page.evaluate('({ x: window.scrollX, y: window.scrollY })');
        const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
        return {
            url: this.page.url(),
            ok: true,
            scrollX: after.x,
            scrollY: after.y,
            atBoundary: moved < Math.abs(deltaX) + Math.abs(deltaY),
        };
    }
    async wait(options, signal) {
        const ms = Math.max(0, Math.min(options?.ms ?? 1000, 60_000));
        await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(signal.reason);
            }, { once: true });
        });
        if (options?.load) {
            await this.page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
        }
        return { url: this.page.url(), ok: true };
    }
    async evaluate(script, _signal) {
        return (await this.page.evaluate(script));
    }
    async back(_signal) {
        await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 60_000 });
        return { url: this.page.url(), statusCode: null, title: (await this.page.title()) || null };
    }
    async forward(_signal) {
        await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: 60_000 });
        return { url: this.page.url(), statusCode: null, title: (await this.page.title()) || null };
    }
    async close(_signal) {
        if (!this.page.isClosed())
            await this.page.close();
    }
    locatorFor(ref) {
        const useAriaRef = this.lastRefs.includes(ref) || isAriaRefFormat(ref);
        return useAriaRef ? this.page.locator(`aria-ref=${ref}`) : this.page.locator(ref);
    }
    async readSnapshot() {
        try {
            const aria = await this.page.locator('body').ariaSnapshot({ mode: 'ai' });
            if (aria && aria.trim())
                return aria;
        }
        catch {
            // fall through to innerText
        }
        const text = (await this.page.evaluate('document.body?.innerText ?? ""'));
        return text || '';
    }
}
/** Collect the actionable `ref` ids Playwright embeds in an aria snapshot. */
export function extractAriaRefs(text) {
    const refs = new Set();
    const re = /\[ref=([^\]]+)\]/g;
    let match;
    while ((match = re.exec(text)) !== null)
        refs.add(match[1]);
    return [...refs];
}
/**
 * Whether a string looks like an aria-snapshot ref (letter prefix + digits,
 * e.g. `e1` on older Playwright builds, `f29e86` on newer ones) as opposed
 * to a CSS selector such as `text=Save` or `input[name=q]`.
 */
export function isAriaRefFormat(ref) {
    return /^[a-z][a-z0-9]*\d+[a-z0-9]*$/i.test(ref);
}
export { PlaywrightBrowserRuntime };
//# sourceMappingURL=index.js.map