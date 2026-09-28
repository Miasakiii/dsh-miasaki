import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { crc32, deflateSync } from "node:zlib";
//#region lib/types/capture-exclude.js
/**
* Capture-interval overlay window ids.
* {@link wrapDesktopBackend} stores the ids. macOS overlay-exclude ScreenCaptureKit and the Windows foreground walk both read them.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/capture-exclude
*/
const captureExclude = new AsyncLocalStorage();
/**
* Overlay window ids to exclude from the current capture, or `[]` outside a cloak.
* macOS values are CGWindowIDs. Windows values are HWNDs.
* @returns window ids from the active `withCapture` session.
*/
function activeCaptureExcludeWindowIds() {
	return captureExclude.getStore() ?? [];
}
/**
* Run `fn` with overlay window ids visible to {@link activeCaptureExcludeWindowIds}.
* @param excludeWindowIds - overlay window ids the active capture must omit.
* @param fn - capture implementation.
* @returns the value `fn` returns.
*/
function runWithCaptureExcludeWindowIds(excludeWindowIds, fn) {
	return captureExclude.run(excludeWindowIds, fn);
}
//#endregion
//#region lib/types/coordinates.js
/**
* Screenshot-fraction mapping, millifraction/pixel validation, click-modifier allowlist, and screenshot-hotkey rejection.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/coordinates
*/
/** Inclusive upper bound of the millifraction click space on each axis. */
const COORDINATE_SPACE = 1e3;
const META_KEYS = /* @__PURE__ */ new Set([
	"cmd",
	"command",
	"meta",
	"win",
	"windows",
	"super"
]);
const SHIFT_KEYS = /* @__PURE__ */ new Set(["shift"]);
const SCREENSHOT_KEYS = /* @__PURE__ */ new Set([
	"3",
	"4",
	"5"
]);
const CLICK_MODIFIER_KIND = {
	shift: "shift",
	cmd: "cmd",
	command: "cmd",
	meta: "cmd",
	win: "cmd",
	windows: "cmd",
	super: "cmd",
	option: "option",
	alt: "option",
	control: "control",
	ctrl: "control"
};
/**
* Normalize one hotkey token for comparison.
* @param key - model-supplied key name.
* @returns the trimmed lowercase token.
*/
function normalizeHotkeyKey(key) {
	return key.trim().toLowerCase();
}
/**
* Whether a chord is a system screenshot shortcut (Cmd/Win+Shift+3/4/5).
* @param keys - model-supplied hotkey tokens.
* @returns true when the chord must be rejected.
*/
function isForbiddenScreenshotHotkey(keys) {
	const normalized = keys.map(normalizeHotkeyKey).filter((key) => key.length > 0);
	const hasMeta = normalized.some((key) => META_KEYS.has(key));
	const hasShift = normalized.some((key) => SHIFT_KEYS.has(key));
	const hasShot = normalized.some((key) => SCREENSHOT_KEYS.has(key));
	return hasMeta && hasShift && hasShot;
}
/**
* Reject a screenshot chord before any desktop input is posted.
* @param keys - model-supplied hotkey tokens.
* @throws when the chord is a forbidden system screenshot shortcut.
*/
function assertAllowedHotkey(keys) {
	if (isForbiddenScreenshotHotkey(keys)) throw new Error("computer-use: system screenshot shortcuts are forbidden");
}
/**
* Accept omitted or empty `modifiers`, or a list of shift/cmd/option/control tokens.
* Duplicate families keep the first token. Unknown keys, including letters and `fn`, are rejected.
* @param modifiers - model-supplied click modifier tokens.
* @returns normalized tokens to hold for this click, or `undefined` for a plain click.
* @throws when a token is not a click modifier.
*/
function requireClickModifiers(modifiers) {
	if (modifiers === void 0 || modifiers.length === 0) return void 0;
	const seen = /* @__PURE__ */ new Set();
	const accepted = [];
	for (const token of modifiers) {
		const key = normalizeHotkeyKey(token);
		const kind = CLICK_MODIFIER_KIND[key];
		if (kind === void 0) throw new Error(`computer-use: click modifiers must be shift, cmd, option, or control; got ${JSON.stringify(token)}`);
		if (seen.has(kind)) continue;
		seen.add(kind);
		accepted.push(key);
	}
	return accepted;
}
/**
* Map a 0–1 screenshot fraction onto one observation surface's logical global coordinates.
* @param fraction - `[x, y]` each in `[0, 1]`, already divided by 1000 or attached size.
* @param screen - observation whose logical bounds receive the mapping.
* @returns global logical coordinates in the same space as `screen.bounds`.
*/
function mapFractionToGlobal(fraction, screen) {
	const [fx, fy] = fraction;
	return {
		x: screen.bounds.x + fx * screen.bounds.width,
		y: screen.bounds.y + fy * screen.bounds.height
	};
}
/**
* Map a 0–1000 position onto one observation surface's logical global coordinates.
* @param position - `[x, y]` in the 0–1000 space of `screen`.
* @param screen - observation whose logical bounds receive the mapping.
* @returns global logical coordinates in the same space as `screen.bounds`.
*/
function mapNormalizedToGlobal(position, screen) {
	const [nx, ny] = position;
	return mapFractionToGlobal([nx / COORDINATE_SPACE, ny / COORDINATE_SPACE], screen);
}
/**
* Require a two-number 0–1000 position.
* @param position - tool argument array.
* @returns the validated `[x, y]` pair.
* @throws when the array is not two finite coordinates in 0–1000.
*/
function requireNormalizedPosition(position) {
	if (position.length !== 2) throw new Error("position must be [x, y] with exactly two coordinates in the 0–1000 space");
	const x = position[0];
	const y = position[1];
	if (x === void 0 || y === void 0 || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1e3 || y < 0 || y > 1e3) throw new Error("position coordinates must be finite numbers in the 0–1000 space");
	return [x, y];
}
/**
* Require a two-number pixel position inside an attached raster, inclusive of the far edge.
* @param position - tool argument array.
* @param attached - width/height of the observation the model is looking at.
* @returns the validated `[x, y]` pair.
* @throws when the array is not two finite coordinates in that raster.
*/
function requirePixelPosition(position, attached) {
	if (position.length !== 2) throw new Error(`position must be [x, y] with exactly two coordinates in the attached ${String(attached.width)}x${String(attached.height)} pixel space`);
	const x = position[0];
	const y = position[1];
	if (x === void 0 || y === void 0 || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > attached.width || y < 0 || y > attached.height) throw new Error(`position coordinates must be finite numbers in the attached ${String(attached.width)}x${String(attached.height)} pixel space`);
	return [x, y];
}
/**
* Validate a model `position` for this session's encoding and convert it to HID millifraction.
* Pixel mode divides by the attached raster; millifraction keeps 0–1000. HID still posts 0–1000.
* @param position - tool argument array.
* @param mode - session contract.
* @param attached - required when `mode` is pixel.
* @returns `[x, y]` in the 0–1000 space `mapNormalizedToGlobal` consumes.
* @throws when the encoding is pixel and no raster is attached, or the pair is out of range.
*/
function modelPositionToHid(position, mode, attached) {
	if (mode === "millifraction") return requireNormalizedPosition(position);
	if (attached === void 0) throw new Error("computer-use: pixel coordinates require an attached screenshot raster");
	const [x, y] = requirePixelPosition(position, attached);
	return [x / attached.width * COORDINATE_SPACE, y / attached.height * COORDINATE_SPACE];
}
//#endregion
//#region lib/types/macos.js
/**
* macOS desktop capture (`screencapture`) and HID input (JXA `CGEvent`).
* JXA stringifies CoreGraphics enum constants and cannot pass a `UniChar *`,
* so mouse/hotkey/scroll use numeric event types with a retained event source
* and intra-event sleeps, and `input_text` pastes via NSPasteboard + Cmd+V.
* Tests inject a {@link CommandRunner}; production uses `/usr/bin/osascript`
* and `/usr/sbin/screencapture` plus `sips` crop of the frontmost-app window union,
* or the ScreenCaptureKit overlay-exclude path when overlay window ids are active
* (`screencapture -R` fails on this OS). Desktop Host calls `captureExcludedRegion`
* so ScreenCaptureKit runs in the Electron process; CLI still spawns `macos-sck-capture`.
* Foreground inspect uses
* CGWindowList (skip overlay ids only) plus Finder AppleScript for the current
* folder. JXA does not bridge `CGWindowListCopyWindowInfo` to `NSArray` unless
* `ObjC.bindFunction` declares the return type as `id`; without that bind,
* `ObjC.deepUnwrap` is a non-array and the walk finds no window. `list_apps` /
* `open_app` use NSWorkspace. `open_in_browser` and
* `open_in_finder` use `/usr/bin/open`. `screenshot` writes Desktop files in Node
* and copies the image through NSPasteboard.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/macos
*/
const execFileAsync = promisify(execFile);
const SCREENCAPTURE = "/usr/sbin/screencapture";
const OSASCRIPT = "/usr/bin/osascript";
const OPEN = "/usr/bin/open";
const SIPS = "/usr/bin/sips";
/**
* Absolute path of the Darwin ScreenCaptureKit overlay-exclude helper.
* The binary sits in `lib/` next to the bundled plugin; source tests resolve the same file.
* @returns the helper executable path.
*/
function macosSckCaptureHelperPath() {
	return fileURLToPath(new URL("../lib/macos-sck-capture", import.meta.url));
}
/** JXA that lists localized names of running regular applications. */
const LIST_APPS_SCRIPT = `ObjC.import('AppKit')
const apps = $.NSWorkspace.sharedWorkspace.runningApplications.js
const names = []
const seen = {}
for (var i = 0; i < apps.length; i++) {
  var app = apps[i]
  if (app.activationPolicy !== 0) continue
  var name = ObjC.unwrap(app.localizedName)
  if (typeof name !== 'string') continue
  name = name.trim()
  if (name.length === 0 || seen[name]) continue
  seen[name] = true
  names.push(name)
}
JSON.stringify(names)
`;
/** AppleScript that returns Finder's front-window folder POSIX path, or empty. */
const FINDER_FOLDER_SCRIPT = `tell application "Finder"
    try
        return POSIX path of (target of front window as alias)
    on error
        return ""
    end try
end tell
`;
/** JXA that prints the default https handler bundle id, or null. */
const DEFAULT_BROWSER_SCRIPT = `ObjC.import('AppKit')
const url = $.NSURL.URLWithString('https:')
const appUrl = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(url)
if (!appUrl) {
  JSON.stringify(null)
} else {
  const id = $.NSBundle.bundleWithURL(appUrl).bundleIdentifier
  const unwrapped = id ? ObjC.unwrap(id) : ''
  JSON.stringify(typeof unwrapped === 'string' && unwrapped.length > 0 ? unwrapped : null)
}
`;
/**
* Keep only positive integers so interpolated JXA cannot carry hostile tokens.
* @param excludeWindowIds - overlay CGWindowIDs from the active capture cloak.
* @returns ids safe to embed as JXA object keys.
*/
function sanitizeExcludeWindowIds(excludeWindowIds) {
	return excludeWindowIds.filter((id) => Number.isInteger(id) && id > 0);
}
/**
* Popup-menu layer included from an unrelated PID when it intersects the owner window.
* 101 is `kCGPopUpMenuWindowLevel` (NSPopUpButton / NSMenu on this host).
*/
const CROSS_PID_TRANSIENT_LAYERS = [101];
/** Dock and menu-bar layers omitted from observation. Status-item layer 25 is not chrome. */
const CHROME_WINDOW_LAYERS = [20, 24];
/** Owner names that are never menus of the frontmost app. */
const CHROME_WINDOW_OWNERS = [
	"Dock",
	"程序坞",
	"Control Center",
	"控制中心",
	"Notification Center",
	"Notification Centre",
	"通知中心",
	"Wallpaper",
	"墙纸"
];
function jxaKeySet(keys) {
	return `{ ${keys.map((key) => `${JSON.stringify(key)}: true`).join(", ")} }`;
}
/**
* JXA that reports the first on-screen layer-0 window after skipping overlay ids.
* Binds `CGWindowListCopyWindowInfo` as returning `id` so `ObjC.deepUnwrap` is an array.
* Skips remaining windows with an edge below {@link MIN_LAYER0_WINDOW_EDGE}.
* Then unions every same-screen window of that app family into `x`/`y`/`width`/`height`.
* Family PIDs come from NSWorkspace: same process, related localized names, or bundle-id prefix.
* Unrelated PIDs join only at layer 101 when they intersect the owner.
* @param excludeWindowIds - overlay CGWindowIDs omitted from the remaining z-order.
* @returns a script that prints window JSON or `null`.
*/
function inspectForegroundScript(excludeWindowIds) {
	const ids = sanitizeExcludeWindowIds(excludeWindowIds);
	return `ObjC.import('AppKit')
ObjC.import('CoreGraphics')
ObjC.bindFunction('CGWindowListCopyWindowInfo', ['@', ['I', 'I']])
const exclude = ${ids.length === 0 ? "{}" : `{ ${ids.map((id) => `${String(id)}: true`).join(", ")} }`}
const crossPidLayers = ${jxaKeySet(CROSS_PID_TRANSIENT_LAYERS)}
const chromeLayers = ${jxaKeySet(CHROME_WINDOW_LAYERS)}
const chromeOwners = ${jxaKeySet(CHROME_WINDOW_OWNERS)}
const pad = ${String(48)}
const windows = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1, 0)) || []
const primary = $.NSScreen.screens.objectAtIndex(0).frame
const primaryHeight = primary.size.height
function screenIndex(x, y, w, h) {
  var cx = x + w / 2
  var cy = y + h / 2
  var screens = $.NSScreen.screens.js
  for (var i = 0; i < screens.length; i++) {
    var f = screens[i].frame
    var sx = f.origin.x
    var sy = primaryHeight - f.origin.y - f.size.height
    if (cx >= sx && cx < sx + f.size.width && cy >= sy && cy < sy + f.size.height) {
      return i
    }
  }
  return -1
}
function screenScale(x, y, w, h) {
  var index = screenIndex(x, y, w, h)
  if (index >= 0) return Number($.NSScreen.screens.js[index].backingScaleFactor)
  var main = $.NSScreen.mainScreen
  var fallback = main ? Number(main.backingScaleFactor) : 1
  return fallback > 0 ? fallback : 1
}
function overlaps(ax, ay, aw, ah, bx, by, bw, bh, extra) {
  return ax - extra < bx + bw && ax + aw + extra > bx
    && ay - extra < by + bh && ay + ah + extra > by
}
function relatedOwner(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false
  if (a === b) return true
  return b.indexOf(a + ' ') === 0 || a.indexOf(b + ' ') === 0
}
function relatedBundle(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false
  if (a === b) return true
  return b.indexOf(a + '.') === 0 || a.indexOf(b + '.') === 0
}
function familyPids(ownerPid) {
  var pids = {}
  pids[ownerPid] = true
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications.js
  var loc = ''
  var bundle = ''
  for (var i = 0; i < apps.length; i++) {
    if (Number(apps[i].processIdentifier) === ownerPid) {
      loc = ObjC.unwrap(apps[i].localizedName)
      bundle = ObjC.unwrap(apps[i].bundleIdentifier)
      break
    }
  }
  if (typeof loc !== 'string') loc = ''
  if (typeof bundle !== 'string') bundle = ''
  for (var j = 0; j < apps.length; j++) {
    var app = apps[j]
    var pid = Number(app.processIdentifier)
    if (!(pid > 0) || pids[pid]) continue
    var n = ObjC.unwrap(app.localizedName)
    var b = ObjC.unwrap(app.bundleIdentifier)
    if (relatedOwner(loc, n) || relatedBundle(bundle, b)) pids[pid] = true
  }
  return pids
}
var found = null
var ownerPid = 0
var ownerScreen = -1
var minEdge = ${String(64)}
for (var i = 0; i < windows.length; i++) {
  var w = windows[i]
  if (!w) continue
  var id = Number(w.kCGWindowNumber)
  if (!(id > 0) || exclude[id]) continue
  if (Number(w.kCGWindowLayer) !== 0) continue
  var name = w.kCGWindowOwnerName
  if (typeof name !== 'string' || name.length === 0) continue
  var b = w.kCGWindowBounds
  var x = b ? Number(b.X) : NaN
  var y = b ? Number(b.Y) : NaN
  var width = b ? Number(b.Width) : NaN
  var height = b ? Number(b.Height) : NaN
  var scale = screenScale(x, y, width, height)
  if (!(width >= minEdge) || !(height >= minEdge) || !(scale > 0)) continue
  ownerPid = Number(w.kCGWindowOwnerPID)
  ownerScreen = screenIndex(x, y, width, height)
  found = {
    appName: name,
    windowId: id,
    x: x,
    y: y,
    width: width,
    height: height,
    scale: scale,
  }
  var title = w.kCGWindowName
  if (typeof title === 'string' && title.trim().length > 0) found.windowTitle = title.trim()
  break
}
if (found) {
  var family = familyPids(ownerPid)
  var transients = []
  var minX = found.x
  var minY = found.y
  var maxX = found.x + found.width
  var maxY = found.y + found.height
  for (var j = 0; j < windows.length; j++) {
    var t = windows[j]
    if (!t) continue
    var tid = Number(t.kCGWindowNumber)
    if (!(tid > 0) || exclude[tid] || tid === found.windowId) continue
    var tLayer = Number(t.kCGWindowLayer)
    if (chromeLayers[tLayer] || tLayer < 0) continue
    var tOwner = t.kCGWindowOwnerName
    if (typeof tOwner === 'string' && chromeOwners[tOwner]) continue
    var tb = t.kCGWindowBounds
    var tx = tb ? Number(tb.X) : NaN
    var ty = tb ? Number(tb.Y) : NaN
    var tw = tb ? Number(tb.Width) : NaN
    var th = tb ? Number(tb.Height) : NaN
    if (!(tw > 0) || !(th > 0) || Number(t.kCGWindowAlpha) === 0) continue
    if (screenIndex(tx, ty, tw, th) !== ownerScreen) continue
    var tPid = Number(t.kCGWindowOwnerPID)
    var inFamily = family[tPid] || relatedOwner(found.appName, tOwner)
    if (!inFamily) {
      if (!crossPidLayers[tLayer]) continue
      if (!overlaps(found.x, found.y, found.width, found.height, tx, ty, tw, th, pad)) continue
    }
    transients.push(tid)
    if (tx < minX) minX = tx
    if (ty < minY) minY = ty
    if (tx + tw > maxX) maxX = tx + tw
    if (ty + th > maxY) maxY = ty + th
  }
  found.x = minX
  found.y = minY
  found.width = maxX - minX
  found.height = maxY - minY
  if (transients.length > 0) found.transients = transients
}
JSON.stringify(found)
`;
}
/**
* JXA that activates a running regular app by display name or bundle id, or reports launch.
* @param name - localized name or bundle identifier.
* @returns a script that prints `{ kind, name }` or `{ kind: 'ambiguous', names }`.
*/
function openAppScript(name) {
	return `ObjC.import('AppKit')
const needle = ${JSON.stringify(name)}
const needleLower = needle.toLowerCase()
const apps = $.NSWorkspace.sharedWorkspace.runningApplications.js
const matches = []
const seen = {}
for (var i = 0; i < apps.length; i++) {
  var app = apps[i]
  if (app.activationPolicy !== 0) continue
  var localized = ObjC.unwrap(app.localizedName)
  var bundle = ObjC.unwrap(app.bundleIdentifier)
  var nameOk = typeof localized === 'string' && localized.trim().toLowerCase() === needleLower
  var bundleOk = typeof bundle === 'string' && bundle.trim().toLowerCase() === needleLower
  if (!nameOk && !bundleOk) continue
  var key = typeof bundle === 'string' && bundle.length > 0 ? bundle : ('name:' + String(localized))
  if (seen[key]) continue
  seen[key] = true
  matches.push({
    app: app,
    name: typeof localized === 'string' && localized.trim().length > 0 ? localized.trim() : needle,
  })
}
if (matches.length > 1) {
  JSON.stringify({ kind: 'ambiguous', names: matches.map(function (m) { return m.name }) })
} else if (matches.length === 1) {
  matches[0].app.activateWithOptions_(2)
  JSON.stringify({ kind: 'activated', name: matches[0].name })
} else {
  JSON.stringify({ kind: 'launch', name: needle })
}
`;
}
/**
* Whether a CGWindow owner name is Finder (English or 访达).
* @param appName - `kCGWindowOwnerName` after overlay skip.
* @returns true when Finder folder lookup should run.
*/
function isFinderApp(appName) {
	const name = appName.trim();
	return name === "Finder" || name === "访达";
}
const KEY_CODES = {
	a: 0,
	s: 1,
	d: 2,
	f: 3,
	h: 4,
	g: 5,
	z: 6,
	x: 7,
	c: 8,
	v: 9,
	b: 11,
	q: 12,
	w: 13,
	e: 14,
	r: 15,
	y: 16,
	t: 17,
	"1": 18,
	"2": 19,
	"3": 20,
	"4": 21,
	"6": 22,
	"5": 23,
	equal: 24,
	"=": 24,
	"9": 25,
	"7": 26,
	minus: 27,
	"-": 27,
	"8": 28,
	"0": 29,
	"]": 30,
	o: 31,
	u: 32,
	"[": 33,
	i: 34,
	p: 35,
	enter: 36,
	return: 36,
	l: 37,
	j: 38,
	quote: 39,
	"'": 39,
	k: 40,
	";": 41,
	"\\": 42,
	",": 43,
	"/": 44,
	n: 45,
	m: 46,
	".": 47,
	tab: 48,
	space: 49,
	"`": 50,
	backspace: 51,
	delete: 51,
	escape: 53,
	esc: 53,
	cmd: 55,
	command: 55,
	meta: 55,
	win: 55,
	windows: 55,
	super: 55,
	shift: 56,
	capslock: 57,
	option: 58,
	alt: 58,
	control: 59,
	ctrl: 59,
	fn: 63,
	f17: 64,
	f18: 79,
	f19: 80,
	f20: 90,
	f5: 96,
	f6: 97,
	f7: 98,
	f3: 99,
	f8: 100,
	f9: 101,
	f11: 103,
	f13: 105,
	f16: 106,
	f14: 107,
	f10: 109,
	f12: 111,
	f15: 113,
	home: 115,
	pageup: 116,
	end: 119,
	f2: 120,
	pagedown: 121,
	f1: 122,
	left: 123,
	right: 124,
	down: 125,
	up: 126
};
/**
* Run a host binary and surface stderr on failure.
* @param file - absolute executable path.
* @param args - argv after the executable.
* @param options - optional abort signal.
* @returns captured utf8 streams.
*/
async function runCommand(file, args, options = {}) {
	try {
		const result = await execFileAsync(file, [...args], {
			encoding: "utf8",
			signal: options.signal,
			timeout: 3e4,
			maxBuffer: 10485760
		});
		return {
			stdout: result.stdout,
			stderr: result.stderr
		};
	} catch (error) {
		throw new Error(`computer-use: ${file} failed: ${errorDetail(error)}`);
	}
}
function errorDetail(error) {
	return error instanceof Error ? error.message : String(error);
}
function mediaTypeOf(data) {
	if (data.length >= 8 && data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) return "image/png";
	if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
	throw new Error("computer-use: capture produced an unsupported image");
}
function parseTransientIds(value) {
	if (!Array.isArray(value)) return void 0;
	const ids = [];
	for (const entry of value) {
		const id = Number(entry);
		if (!Number.isInteger(id) || id < 1) continue;
		ids.push(id);
	}
	return ids.length === 0 ? void 0 : ids;
}
function parseFrontmost(stdout) {
	const trimmed = stdout.trim();
	if (trimmed === "" || trimmed === "null") return void 0;
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null) return void 0;
		const row = parsed;
		if (typeof row.appName !== "string") return void 0;
		const appName = row.appName.trim();
		if (appName === "") return void 0;
		const windowTitle = typeof row.windowTitle === "string" ? row.windowTitle.trim() : "";
		const windowId = Number(row.windowId);
		const x = Number(row.x);
		const y = Number(row.y);
		const width = Number(row.width);
		const height = Number(row.height);
		const scale = Number(row.scale);
		const transientWindowIds = parseTransientIds(row.transients);
		const hasSurface = Number.isInteger(windowId) && windowId > 0 && [
			x,
			y,
			width,
			height,
			scale
		].every(Number.isFinite) && width > 0 && height > 0 && scale > 0;
		return {
			appName,
			...windowTitle === "" ? {} : { windowTitle },
			...hasSurface ? {
				windowId,
				bounds: {
					x,
					y,
					width,
					height
				},
				scale,
				...transientWindowIds === void 0 ? {} : { transientWindowIds }
			} : {}
		};
	} catch {
		return;
	}
}
function screenFromFrontmost(parsed) {
	if (parsed.windowId === void 0 || parsed.bounds === void 0 || parsed.scale === void 0) return;
	return {
		index: 0,
		bounds: parsed.bounds,
		scale: parsed.scale,
		windowId: parsed.windowId,
		...parsed.transientWindowIds === void 0 ? {} : { transientWindowIds: parsed.transientWindowIds }
	};
}
function foregroundFromFrontmost(parsed) {
	return {
		appName: parsed.appName,
		...parsed.windowTitle === void 0 ? {} : { windowTitle: parsed.windowTitle }
	};
}
function parseFinderFolder(stdout) {
	const path = stdout.trim();
	if (path === "" || !path.startsWith("/")) return void 0;
	return path;
}
function parseDefaultBrowserBundle(stdout) {
	const trimmed = stdout.trim();
	if (trimmed === "") return void 0;
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed !== "string") return void 0;
		const bundle = parsed.trim();
		return bundle === "" ? void 0 : bundle;
	} catch {
		return;
	}
}
function isAbortError(error, signal) {
	if (signal?.aborted) return true;
	return error instanceof Error && error.name === "AbortError";
}
function parseAppNames(stdout) {
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error("computer-use: failed to list apps");
	}
	if (!Array.isArray(parsed)) throw new Error("computer-use: failed to list apps");
	const names = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of parsed) {
		if (typeof entry !== "string") throw new Error("computer-use: failed to list apps");
		const name = entry.trim();
		if (name === "" || seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	return names;
}
function looksLikeBundleId(name) {
	return /^[A-Za-z0-9-]+\.[A-Za-z0-9.-]+$/u.test(name);
}
function parseOpenAppDecision(stdout) {
	let parsed;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		throw new Error("computer-use: open_app failed: unreadable activate result");
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error("computer-use: open_app failed: unreadable activate result");
	const row = parsed;
	if (row.kind === "ambiguous") return {
		kind: "ambiguous",
		names: Array.isArray(row.names) ? row.names.filter((entry) => typeof entry === "string" && entry.trim() !== "") : []
	};
	if ((row.kind === "activated" || row.kind === "launch") && typeof row.name === "string" && row.name.trim() !== "") return {
		kind: row.kind,
		name: row.name.trim()
	};
	throw new Error("computer-use: open_app failed: unreadable activate result");
}
function regionCaptureSpec(bounds) {
	const x = Math.round(bounds.x);
	const y = Math.round(bounds.y);
	const width = Math.max(1, Math.round(bounds.width));
	const height = Math.max(1, Math.round(bounds.height));
	return `${String(x)},${String(y)},${String(width)},${String(height)}`;
}
function regionCropPixels(screen) {
	const scale = screen.scale;
	return {
		x: Math.max(0, Math.round(screen.bounds.x * scale)),
		y: Math.max(0, Math.round(screen.bounds.y * scale)),
		width: Math.max(1, Math.round(screen.bounds.width * scale)),
		height: Math.max(1, Math.round(screen.bounds.height * scale))
	};
}
function keyCode(token) {
	const key = token.trim().toLowerCase();
	const code = KEY_CODES[key];
	if (code === void 0) throw new Error(`computer-use: unknown key "${token}"`);
	return code;
}
function jxa(script) {
	return [
		"-l",
		"JavaScript",
		"-e",
		script
	];
}
/**
* Shared JXA posted for every HID action.
* Numeric CGEvent types: JXA exposes kCG* enums as strings.
* Drag posts LeftMouseDragged (6), not MouseMoved (5): the latter relocates the
* cursor without delivering mouseDragged: to AppKit and Electron.
* Click modifiers hold keys, set the same flags on mouse events, then release
* in that script.
* `input_text` pastes: JXA cannot pass a UniChar buffer to CGEventKeyboardSetUnicodeString,
* and virtual keycode 0 is the "a" key, so a failed unicode override types "a".
*/
const HID_RUNTIME = `
ObjC.import('Cocoa')
const HID = 0
const SRC = $.CGEventSourceCreate(1)
const LEFT_DOWN = 1
const LEFT_UP = 2
const RIGHT_DOWN = 3
const RIGHT_UP = 4
const MOVE = 5
const LEFT_DRAGGED = 6
const LEFT = 0
const RIGHT = 1
const CLICK_STATE = 1
const FLAG_SHIFT = 0x00020000
const FLAG_CTRL = 0x00040000
const FLAG_ALT = 0x00080000
const FLAG_CMD = 0x00100000
const FLAG_FN = 0x00008000
const KEY_CMD = 55
const KEY_SHIFT = 56
const KEY_OPTION = 58
const KEY_CONTROL = 59
const KEY_FN = 63
const KEY_A = 0
const KEY_V = 9
const KEY_ENTER = 36
function sleep(ms) {
  $.NSThread.sleepForTimeInterval(ms / 1000)
}
function postMouse(type, x, y, button, clickState, flags) {
  const event = $.CGEventCreateMouseEvent(SRC, type, $.CGPointMake(x, y), button)
  if (clickState) $.CGEventSetIntegerValueField(event, CLICK_STATE, clickState)
  if (flags) $.CGEventSetFlags(event, flags)
  $.CGEventPost(HID, event)
}
function clickAt(x, y, button, count, flags) {
  flags = flags || 0
  const down = button === RIGHT ? RIGHT_DOWN : LEFT_DOWN
  const up = button === RIGHT ? RIGHT_UP : LEFT_UP
  postMouse(MOVE, x, y, button, 0, flags)
  sleep(80)
  for (var i = 1; i <= count; i++) {
    postMouse(down, x, y, button, i, flags)
    sleep(50)
    postMouse(up, x, y, button, i, flags)
    if (i < count) sleep(100)
  }
}
function clickWithModifiers(x, y, button, count, codes) {
  var flags = 0
  var mods = []
  for (var i = 0; i < codes.length; i++) {
    var code = codes[i]
    if (code === KEY_CMD) { flags |= FLAG_CMD; mods.push(code) }
    else if (code === KEY_SHIFT) { flags |= FLAG_SHIFT; mods.push(code) }
    else if (code === KEY_OPTION) { flags |= FLAG_ALT; mods.push(code) }
    else if (code === KEY_CONTROL) { flags |= FLAG_CTRL; mods.push(code) }
  }
  for (var m = 0; m < mods.length; m++) postKey(mods[m], true, flags)
  sleep(20)
  clickAt(x, y, button, count, flags)
  for (var r = mods.length - 1; r >= 0; r--) postKey(mods[r], false, 0)
  sleep(20)
}
function postKey(code, down, flags) {
  const event = $.CGEventCreateKeyboardEvent(SRC, code, down)
  $.CGEventSetFlags(event, flags)
  $.CGEventPost(HID, event)
}
function tapKey(code, flags) {
  postKey(code, true, flags)
  sleep(20)
  postKey(code, false, flags)
  sleep(15)
}
function chord(codes) {
  var flags = 0
  var mods = []
  var keys = []
  for (var i = 0; i < codes.length; i++) {
    var code = codes[i]
    if (code === KEY_CMD) { flags |= FLAG_CMD; mods.push(code) }
    else if (code === KEY_SHIFT) { flags |= FLAG_SHIFT; mods.push(code) }
    else if (code === KEY_OPTION) { flags |= FLAG_ALT; mods.push(code) }
    else if (code === KEY_CONTROL) { flags |= FLAG_CTRL; mods.push(code) }
    else if (code === KEY_FN) { flags |= FLAG_FN; mods.push(code) }
    else keys.push(code)
  }
  for (var m = 0; m < mods.length; m++) postKey(mods[m], true, flags)
  sleep(20)
  if (keys.length === 0) {
    for (var t = mods.length - 1; t >= 0; t--) postKey(mods[t], false, 0)
    return
  }
  for (var k = 0; k < keys.length; k++) tapKey(keys[k], flags)
  for (var r = mods.length - 1; r >= 0; r--) postKey(mods[r], false, 0)
  sleep(20)
}
function clipboardString() {
  var value = $.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString)
  if (!value) return ''
  try {
    var unwrapped = ObjC.unwrap(value)
    return typeof unwrapped === 'string' ? unwrapped : ''
  } catch (error) {
    // Nil NSPasteboard string unwraps by throwing in JXA; treat as empty.
    return ''
  }
}
function clearPasteboard(pb) {
  // JXA invokes no-arg ObjC methods on property access; calling this as a JS
  // function would invoke the NSInteger return value.
  var discarded = pb.clearContents
}
function pasteText(text) {
  var pb = $.NSPasteboard.generalPasteboard
  var previous = clipboardString()
  clearPasteboard(pb)
  pb.setStringForType($.NSString.stringWithString(text), $.NSPasteboardTypeString)
  chord([KEY_CMD, KEY_V])
  sleep(80)
  clearPasteboard(pb)
  pb.setStringForType($.NSString.stringWithString(previous), $.NSPasteboardTypeString)
}
function selectAll() {
  chord([KEY_CMD, KEY_A])
}
function pressEnter() {
  tapKey(KEY_ENTER, 0)
}
function scrollAt(x, y, dy) {
  postMouse(MOVE, x, y, LEFT, 0)
  sleep(40)
  var step = dy < 0 ? -1 : 1
  var n = Math.abs(dy)
  if (n < 1) n = 1
  for (var i = 0; i < n; i++) {
    var event = $.CGEventCreateScrollWheelEvent2(SRC, 1, 1, step, 0, 0)
    $.CGEventSetLocation(event, $.CGPointMake(x, y))
    $.CGEventPost(HID, event)
    sleep(20)
  }
}
function longPressAt(x, y, durationMs) {
  postMouse(MOVE, x, y, LEFT, 0)
  sleep(80)
  postMouse(LEFT_DOWN, x, y, LEFT, 1)
  sleep(durationMs)
  postMouse(LEFT_UP, x, y, LEFT, 1)
}
function dragFromTo(x1, y1, x2, y2) {
  postMouse(MOVE, x1, y1, LEFT, 0)
  sleep(80)
  postMouse(LEFT_DOWN, x1, y1, LEFT, 1)
  sleep(50)
  var steps = 10
  for (var i = 1; i <= steps; i++) {
    var t = i / steps
    postMouse(LEFT_DRAGGED, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, LEFT, 1)
    sleep(20)
  }
  postMouse(LEFT_UP, x2, y2, LEFT, 1)
}
`.trim();
function hidScript(body) {
	return `${HID_RUNTIME}\n${body}\n`;
}
const PASTEBOARD_TYPE = {
	"image/png": "public.png",
	"image/jpeg": "public.jpeg",
	"image/gif": "com.compuserve.gif",
	"image/webp": "org.webmproject.webp"
};
function copyImageScript(input) {
	return `ObjC.import('AppKit')
var pb = $.NSPasteboard.generalPasteboard
var discarded = pb.clearContents
var data = $.NSData.dataWithContentsOfFile($.NSString.stringWithString(${JSON.stringify(input.path)}))
if (!data) throw new Error('clipboard image file is missing')
pb.setDataForType(data, $.NSString.stringWithString(${JSON.stringify(PASTEBOARD_TYPE[input.mediaType])}))
`;
}
function roundedPoint(position, screen) {
	const point = mapNormalizedToGlobal(position, screen);
	return {
		x: Math.round(point.x),
		y: Math.round(point.y)
	};
}
async function runHidScript(run, script, signal) {
	const dir = await mkdtemp(join(tmpdir(), "dsh-computer-use-hid-"));
	const file = join(dir, "hid.js");
	try {
		await writeFile(file, script, "utf8");
		await run(OSASCRIPT, [
			"-l",
			"JavaScript",
			file
		], { signal });
	} finally {
		await rm(dir, {
			recursive: true,
			force: true
		});
	}
}
/**
* Construct the production macOS backend, optionally with a test command runner.
* @param run - subprocess runner; omitted uses {@link runCommand}.
* @param excludedRegionCapture - Desktop overlay-exclude capture; omitted spawns the CLI helper.
* @returns capture and HID input against the host desktop.
*/
function createMacosDesktopBackend(run = runCommand, excludedRegionCapture) {
	const hid = async (body, signal) => {
		await runHidScript(run, hidScript(body), signal);
	};
	return {
		withGuiTurn: (run) => run(),
		async listScreens(signal) {
			const parsed = parseFrontmost((await run(OSASCRIPT, jxa(inspectForegroundScript(activeCaptureExcludeWindowIds())), { signal })).stdout);
			if (parsed === void 0) return [];
			const screen = screenFromFrontmost(parsed);
			return screen === void 0 ? [] : [screen];
		},
		async capture(screen, signal) {
			const dir = await mkdtemp(join(tmpdir(), "dsh-computer-use-"));
			const file = join(dir, "screen.jpg");
			const excludeWindowIds = activeCaptureExcludeWindowIds();
			const overlayCapture = async (region, ids) => {
				try {
					if (excludedRegionCapture !== void 0) {
						await excludedRegionCapture({
							region,
							excludeWindowIds: ids,
							output: file,
							...signal === void 0 ? {} : { signal }
						});
						return;
					}
					await run(macosSckCaptureHelperPath(), [
						`--region=${region}`,
						`--exclude=${ids.join(",")}`,
						`--out=${file}`
					], { signal });
				} catch (error) {
					throw new Error(`computer-use: overlay-exclude capture failed: ${errorDetail(error)}`);
				}
			};
			try {
				const region = regionCaptureSpec(screen.bounds);
				if (excludeWindowIds.length === 0) {
					const full = join(dir, "full.jpg");
					await run(SCREENCAPTURE, [
						"-x",
						"-t",
						"jpg",
						full
					], { signal });
					const crop = regionCropPixels(screen);
					await run(SIPS, [
						"--cropOffset",
						String(crop.y),
						String(crop.x),
						"-c",
						String(crop.height),
						String(crop.width),
						full,
						"--out",
						file
					], { signal });
				} else await overlayCapture(region, excludeWindowIds);
				const data = await readFile(file);
				return {
					data,
					mediaType: mediaTypeOf(data)
				};
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("computer-use: overlay-exclude capture failed:")) throw error;
				throw new Error(`computer-use: screen capture failed (Screen Recording permission is required): ${errorDetail(error)}`);
			} finally {
				await rm(dir, {
					recursive: true,
					force: true
				});
			}
		},
		async inspectForeground(signal) {
			try {
				const parsed = parseFrontmost((await run(OSASCRIPT, jxa(inspectForegroundScript(activeCaptureExcludeWindowIds())), { signal })).stdout);
				if (parsed === void 0) return FOCUS_FALLBACK_FOREGROUND;
				const foreground = foregroundFromFrontmost(parsed);
				if (!isFinderApp(parsed.appName)) return foreground;
				try {
					const finderFolder = parseFinderFolder((await run(OSASCRIPT, ["-e", FINDER_FOLDER_SCRIPT], { signal })).stdout);
					return finderFolder === void 0 ? foreground : {
						...foreground,
						finderFolder
					};
				} catch (error) {
					if (isAbortError(error, signal)) throw error;
					return foreground;
				}
			} catch (error) {
				if (isAbortError(error, signal)) throw error;
				return FOCUS_FALLBACK_FOREGROUND;
			}
		},
		async listApps(signal) {
			return parseAppNames((await run(OSASCRIPT, jxa(LIST_APPS_SCRIPT), { signal })).stdout.trim());
		},
		async openApp(input, signal) {
			const name = input.name.trim();
			if (name === "") throw new Error("computer-use: open_app requires a name");
			try {
				const decision = parseOpenAppDecision((await run(OSASCRIPT, jxa(openAppScript(name)), { signal })).stdout);
				if (decision.kind === "ambiguous") {
					const listed = decision.names.length === 0 ? name : decision.names.join(", ");
					throw new Error(`computer-use: app name "${name}" matches multiple applications: ${listed}`);
				}
				if (decision.kind === "activated") return {
					kind: "activated",
					name: decision.name
				};
				await run(OPEN, looksLikeBundleId(name) ? ["-b", name] : ["-a", name], { signal });
				return {
					kind: "launched",
					name
				};
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("computer-use:")) throw error;
				throw new Error(`computer-use: open_app failed for ${name}: ${errorDetail(error)}`);
			}
		},
		async click(input, signal) {
			const point = roundedPoint(input.position, input.screen);
			const button = input.button === "right" ? 1 : 0;
			const modifiers = input.modifiers ?? [];
			const body = modifiers.length === 0 ? `clickAt(${point.x}, ${point.y}, ${button}, ${input.count})` : `clickWithModifiers(${point.x}, ${point.y}, ${button}, ${input.count}, ${JSON.stringify(modifiers.map(keyCode))})`;
			try {
				await hid(body, signal);
			} catch (error) {
				throw new Error(`computer-use: pointer input failed (Accessibility permission is required): ${errorDetail(error)}`);
			}
		},
		async typeText(input, signal) {
			const point = roundedPoint(input.position, input.screen);
			const lines = [`clickAt(${point.x}, ${point.y}, 0, 1)`, "sleep(120)"];
			if (input.replace) lines.push("selectAll()", "sleep(40)");
			if (input.text.length > 0) lines.push(`pasteText(${JSON.stringify(input.text)})`);
			if (input.submit) lines.push("pressEnter()");
			try {
				await hid(lines.join("\n"), signal);
			} catch (error) {
				throw new Error(`computer-use: keyboard input failed (Accessibility permission is required): ${errorDetail(error)}`);
			}
		},
		async scroll(input, signal) {
			const point = roundedPoint(input.position, input.screen);
			const dy = input.direction === "up" ? input.scrollLevel : -input.scrollLevel;
			try {
				await hid(`scrollAt(${point.x}, ${point.y}, ${dy})`, signal);
			} catch (error) {
				throw new Error(`computer-use: scroll input failed (Accessibility permission is required): ${errorDetail(error)}`);
			}
		},
		async hotkey(input, signal) {
			try {
				const codes = input.keys.map(keyCode);
				await hid(`chord(${JSON.stringify(codes)})`, signal);
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("computer-use: unknown key")) throw error;
				throw new Error(`computer-use: hotkey input failed (Accessibility permission is required): ${errorDetail(error)}`);
			}
		},
		async longPress(input, signal) {
			const point = roundedPoint(input.position, input.screen);
			const durationMs = Math.round(input.durationSeconds * 1e3);
			try {
				await hid(`longPressAt(${point.x}, ${point.y}, ${String(durationMs)})`, signal);
			} catch (error) {
				throw new Error(`computer-use: pointer input failed (Accessibility permission is required): ${errorDetail(error)}`);
			}
		},
		async drag(input, signal) {
			const start = roundedPoint(input.startPosition, input.startScreen);
			const end = roundedPoint(input.endPosition, input.endScreen);
			try {
				await hid(`dragFromTo(${start.x}, ${start.y}, ${end.x}, ${end.y})`, signal);
			} catch (error) {
				throw new Error(`computer-use: pointer input failed (Accessibility permission is required): ${errorDetail(error)}`);
			}
		},
		async openInBrowser(input, signal) {
			try {
				if (input.url !== void 0) {
					await run(OPEN, [input.url], { signal });
					return;
				}
				const bundle = parseDefaultBrowserBundle((await run(OSASCRIPT, jxa(DEFAULT_BROWSER_SCRIPT), { signal })).stdout);
				if (bundle === void 0) throw new Error("could not resolve the default browser");
				await run(OPEN, ["-b", bundle], { signal });
			} catch (error) {
				const target = input.url === void 0 ? "the default browser" : input.url;
				throw new Error(`computer-use: open failed for ${target}: ${errorDetail(error)}`);
			}
		},
		async openInFinder(input, signal) {
			try {
				await run(OPEN, input.revealOnly ? ["-R", input.path] : [input.path], { signal });
			} catch (error) {
				throw new Error(`computer-use: open failed for ${input.path}: ${errorDetail(error)}`);
			}
		},
		async copyImageToClipboard(input, signal) {
			try {
				await runHidScript(run, copyImageScript(input), signal);
			} catch (error) {
				throw new Error(`computer-use: clipboard copy failed: ${errorDetail(error)}`);
			}
		}
	};
}
//#endregion
//#region lib/types/unsupported.js
/**
* Desktop backend used when Computer Use is loaded off macOS and Windows.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/unsupported
*/
/** Fixed execute-time error for hosts other than macOS and Windows. */
const UNSUPPORTED_DESKTOP_MESSAGE = "computer-use: desktop control is implemented only on macOS and Windows";
/**
* Construct a backend whose methods fail at execute time so Linux CI can still load the plugin.
* @returns a backend that throws {@link UNSUPPORTED_DESKTOP_MESSAGE} from every method.
*/
function createUnsupportedDesktopBackend() {
	const fail = () => Promise.reject(/* @__PURE__ */ new Error(UNSUPPORTED_DESKTOP_MESSAGE));
	return {
		listScreens: fail,
		capture: fail,
		inspectForeground: fail,
		listApps: fail,
		openApp: fail,
		click: fail,
		typeText: fail,
		scroll: fail,
		hotkey: fail,
		longPress: fail,
		drag: fail,
		openInBrowser: fail,
		openInFinder: fail,
		copyImageToClipboard: fail,
		withGuiTurn: (run) => run()
	};
}
//#endregion
//#region lib/types/wait.js
/**
* Abortable delay used after GUI actions and by the wait and long_wait tools.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/wait
*/
/**
* Pause until `ms` elapses or `signal` aborts.
* @param ms - delay in milliseconds; non-positive values return after an abort check.
* @param signal - cooperative cancellation for the owning tool or pre-step.
* @returns after the delay, or rejects with the abort reason.
*/
async function delay(ms, signal) {
	if (ms <= 0) {
		signal.throwIfAborted();
		return;
	}
	await new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			const reason = signal.reason;
			reject(reason instanceof Error ? reason : /* @__PURE__ */ new Error("computer-use: wait aborted"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		if (signal.aborted) {
			clearTimeout(timer);
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
//#endregion
//#region lib/types/windows-foreground.js
/**
* Choose the Windows observation window from a z-order snapshot.
* Native code supplies physical-pixel facts. This module does not call Win32.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/windows-foreground
*/
/** Top-level classes that are the shell, not an operable app. Taskbar, secondary taskbar, and the desktop. */
const SHELL_CLASSES = /* @__PURE__ */ new Set([
	"Shell_TrayWnd",
	"Shell_SecondaryTrayWnd",
	"Progman",
	"WorkerW"
]);
/**
* Top-level classes merged from another process when they intersect the owner.
* `#32768` is the system menu. `ComboLBox` is the combo dropdown.
*/
const CROSS_PID_TRANSIENT_CLASSES = /* @__PURE__ */ new Set(["#32768", "ComboLBox"]);
function excludeSet(ids) {
	const exclude = /* @__PURE__ */ new Set();
	for (const id of ids) if (Number.isInteger(id) && id > 0) exclude.add(id);
	return exclude;
}
function sameMonitor(left, right) {
	return left.monitor.x === right.monitor.x && left.monitor.y === right.monitor.y && left.monitor.width === right.monitor.width && left.monitor.height === right.monitor.height;
}
function intersects(left, right, pad) {
	return left.x - pad < right.x + right.width && left.x + left.width + pad > right.x && left.y - pad < right.y + right.height && left.y + left.height + pad > right.y;
}
function positiveFrame(frame) {
	return frame.width > 0 && frame.height > 0;
}
/**
* Whether `candidate`'s owner chain reaches `ownerHwnd`.
* A cycle or a missing owner stops the walk.
* @param byHwnd - facts indexed by hwnd.
* @param candidate - window whose `GW_OWNER` chain is walked.
* @param ownerHwnd - observation owner hwnd.
* @returns true when an owner in the chain is `ownerHwnd`.
*/
function ownedBy(byHwnd, candidate, ownerHwnd) {
	let current = candidate.ownerHwnd;
	const seen = /* @__PURE__ */ new Set();
	while (current !== 0 && !seen.has(current)) {
		if (current === ownerHwnd) return true;
		seen.add(current);
		current = byHwnd.get(current)?.ownerHwnd ?? 0;
	}
	return false;
}
function eligibleOwner(window, exclude) {
	if (exclude.has(window.hwnd)) return false;
	if (!window.visible || window.iconic || window.cloaked || window.toolWindow) return false;
	if (SHELL_CLASSES.has(window.className) || CROSS_PID_TRANSIENT_CLASSES.has(window.className)) return false;
	if (window.frame.width < 64 || window.frame.height < 64) return false;
	return true;
}
function includeTransient(candidate, owner, byHwnd) {
	const samePid = candidate.pid === owner.pid;
	if (samePid && ownedBy(byHwnd, candidate, owner.hwnd)) return true;
	const hits = intersects(owner.frame, candidate.frame, 48);
	if (samePid && candidate.popup && hits) return true;
	return !samePid && CROSS_PID_TRANSIENT_CLASSES.has(candidate.className) && hits;
}
/**
* Pick the foreground window, or the next eligible top-level window, and union same-monitor transients.
* Overlay hwnds in `excludeWindowIds` are skipped. Shell classes and system menus are not owners.
* Same-process windows join when they are owned by that window or are an intersecting popup.
* Another process joins only for an intersecting system menu or combo dropdown.
* `focused` is true only when the foreground hwnd is the owner or one of those transients.
* @param snapshot - physical-pixel z-order snapshot.
* @param excludeWindowIds - overlay hwnds from the capture cloak. Non-positive and non-integer ids are ignored.
* @returns the observation, or undefined when no operable window remains.
*/
function selectWindowsObservation(snapshot, excludeWindowIds) {
	const exclude = excludeSet(excludeWindowIds);
	const foreground = snapshot.windows.find((window) => window.hwnd === snapshot.foregroundHwnd);
	const owner = foreground !== void 0 && eligibleOwner(foreground, exclude) ? foreground : snapshot.windows.find((window) => eligibleOwner(window, exclude));
	if (owner === void 0) return void 0;
	const byHwnd = new Map(snapshot.windows.map((window) => [window.hwnd, window]));
	let minX = owner.frame.x;
	let minY = owner.frame.y;
	let maxX = owner.frame.x + owner.frame.width;
	let maxY = owner.frame.y + owner.frame.height;
	const transientWindowIds = [];
	for (const candidate of snapshot.windows) {
		if (candidate.hwnd === owner.hwnd || exclude.has(candidate.hwnd)) continue;
		if (!candidate.visible || candidate.iconic || candidate.cloaked) continue;
		if (SHELL_CLASSES.has(candidate.className) || !positiveFrame(candidate.frame)) continue;
		if (!sameMonitor(candidate, owner)) continue;
		if (!includeTransient(candidate, owner, byHwnd)) continue;
		transientWindowIds.push(candidate.hwnd);
		if (candidate.frame.x < minX) minX = candidate.frame.x;
		if (candidate.frame.y < minY) minY = candidate.frame.y;
		if (candidate.frame.x + candidate.frame.width > maxX) maxX = candidate.frame.x + candidate.frame.width;
		if (candidate.frame.y + candidate.frame.height > maxY) maxY = candidate.frame.y + candidate.frame.height;
	}
	return {
		appName: owner.appName,
		windowTitle: owner.title.trim(),
		bounds: {
			x: minX,
			y: minY,
			width: maxX - minX,
			height: maxY - minY
		},
		scale: owner.monitorDpi > 0 ? owner.monitorDpi / 96 : 1,
		windowId: owner.hwnd,
		transientWindowIds,
		focused: snapshot.foregroundHwnd === owner.hwnd || transientWindowIds.includes(snapshot.foregroundHwnd)
	};
}
//#endregion
//#region lib/types/windows.js
/**
* Windows desktop capture (GDI) and HID input (`SendInput`).
* Observation bounds, capture, and pointer input share physical pixels.
* Production loads `user32` / `gdi32` through koffi on the first call.
* Tests inject {@link WindowsDesktopOps} and never post real input.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/windows
*/
const ELEVATED_WINDOW = "computer-use: the foreground window is running elevated, so this process cannot click or type into it";
const KEY_NAMES = {
	ctrl: 17,
	control: 17,
	alt: 18,
	option: 18,
	shift: 16,
	win: 91,
	windows: 91,
	meta: 91,
	cmd: 91,
	command: 91,
	super: 91,
	enter: 13,
	return: 13,
	tab: 9,
	escape: 27,
	esc: 27,
	space: 32,
	backspace: 8,
	delete: 46,
	del: 46,
	up: 38,
	down: 40,
	left: 37,
	right: 39,
	home: 36,
	end: 35,
	pageup: 33,
	pagedown: 34,
	insert: 45
};
/** Navigation keys whose scan code is the extended set. Numpad names are not in this map. */
const EXTENDED_KEY_NAMES = /* @__PURE__ */ new Set([
	"up",
	"down",
	"left",
	"right",
	"home",
	"end",
	"pageup",
	"pagedown",
	"insert",
	"delete",
	"del"
]);
const MODIFIER_VKS = /* @__PURE__ */ new Set([
	16,
	17,
	18,
	91,
	92
]);
/** Same settle the macOS HID script uses after a move, before the button goes down. */
const POINTER_MOVE_SETTLE_MS = 80;
const BUTTON_HOLD_MS = 50;
const DOUBLE_CLICK_GAP_MS = 100;
const DRAG_STEPS = 10;
const DRAG_STEP_MS = 20;
const SCROLL_NOTCH = 120;
const SCROLL_STEP_MS = 20;
const MODIFIER_GAP_MS = 20;
const CLIPBOARD_SETTLE_MS = 30;
/** Wait after Ctrl+V before restoring the clipboard, so the target reads the pasted text. */
const PASTE_SETTLE_MS = 80;
/**
* Map one hotkey token to a Win32 virtual-key code.
* @param key - model-supplied key name.
* @returns the virtual-key code.
* @throws when the token is not a known key, letter, digit, or function key.
*/
function windowsVirtualKey(key) {
	const token = key.trim().toLowerCase();
	const named = KEY_NAMES[token];
	if (named !== void 0) return named;
	if (/^[a-z]$/u.test(token)) return token.toUpperCase().charCodeAt(0);
	if (/^[0-9]$/u.test(token)) return token.charCodeAt(0);
	const fn = /^f([1-9]|1[0-2])$/u.exec(token);
	if (fn !== null) return 112 + Number(fn[1]) - 1;
	throw new Error(`computer-use: unknown key ${JSON.stringify(key)}`);
}
/**
* Whether a hotkey token needs `KEYEVENTF_EXTENDEDKEY`.
* @param key - model-supplied key name.
* @returns true for arrows, editing, and navigation keys. Letters and digits return false.
*/
function windowsKeyIsExtended(key) {
	return EXTENDED_KEY_NAMES.has(key.trim().toLowerCase());
}
function postedKey(key) {
	return {
		vk: windowsVirtualKey(key),
		extended: windowsKeyIsExtended(key)
	};
}
function postedVk(vk) {
	return {
		vk,
		extended: false
	};
}
/**
* Encode a 32-bit BGRA buffer as a PNG.
* @param width - pixel width.
* @param height - pixel height.
* @param bgra - tightly packed BGRA pixels, one row after another.
* @param bottomUp - true when the first row in `bgra` is the bottom of the image.
* @returns PNG bytes.
*/
function encodeBgraPng(width, height, bgra, bottomUp) {
	const rowBytes = width * 4;
	const raw = Buffer.alloc((rowBytes + 1) * height);
	for (let y = 0; y < height; y += 1) {
		const sourceY = bottomUp ? height - 1 - y : y;
		const dest = y * (rowBytes + 1);
		raw[dest] = 0;
		for (let x = 0; x < width; x += 1) {
			const source = sourceY * rowBytes + x * 4;
			const pixel = dest + 1 + x * 4;
			raw[pixel] = bgra[source + 2] ?? 0;
			raw[pixel + 1] = bgra[source + 1] ?? 0;
			raw[pixel + 2] = bgra[source] ?? 0;
			raw[pixel + 3] = 255;
		}
	}
	const signature = Buffer.from([
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10
	]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([
		signature,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0))
	]);
}
function pngChunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const name = Buffer.from(type);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
	return Buffer.concat([
		length,
		name,
		data,
		crc
	]);
}
function liveSignal(signal) {
	return signal ?? new AbortController().signal;
}
function pointOf(position, screen) {
	const mapped = mapNormalizedToGlobal(position, screen);
	return {
		x: Math.round(mapped.x),
		y: Math.round(mapped.y)
	};
}
function assertInput(ops) {
	if (ops.targetBlocksInput()) throw new Error(ELEVATED_WINDOW);
}
/**
* Move keyboard focus to the last `listScreens` window when it is not already foreground.
* No-op when this backend has not listed a window, or when the foreground hwnd is that window or one of its transients.
* @param host - Win32 operations.
* @param observed - selection from the latest `listScreens`, if any.
* @throws when the window cannot become foreground. No keys are posted after that throw.
*/
function restoreObservedFocus(host, observed) {
	if (observed === void 0) return;
	const foreground = host.foregroundWindowId();
	if (foreground === observed.windowId || observed.transientWindowIds.includes(foreground)) return;
	if (host.focusWindow(observed.windowId)) return;
	throw new Error(`computer-use: keyboard focus could not be moved to ${observed.appName}; click inside the window, then retry hotkey`);
}
async function clickAt(ops, button, count, point, signal) {
	ops.movePointer(point.x, point.y);
	await delay(POINTER_MOVE_SETTLE_MS, signal);
	for (let index = 0; index < count; index += 1) {
		ops.mouseButton(button, true);
		await delay(BUTTON_HOLD_MS, signal);
		ops.mouseButton(button, false);
		if (index + 1 < count) await delay(DOUBLE_CLICK_GAP_MS, signal);
	}
}
async function chord(ops, keys, signal) {
	const modifiers = keys.filter((key) => MODIFIER_VKS.has(key.vk));
	const rest = keys.filter((key) => !MODIFIER_VKS.has(key.vk));
	for (const key of modifiers) ops.key(key.vk, true, key.extended);
	if (modifiers.length > 0) await delay(MODIFIER_GAP_MS, signal);
	for (const key of rest) ops.key(key.vk, true, key.extended);
	for (const key of [...rest].reverse()) ops.key(key.vk, false, key.extended);
	for (const key of [...modifiers].reverse()) ops.key(key.vk, false, key.extended);
}
function observationOf(ops) {
	return selectWindowsObservation(ops.listWindows(), activeCaptureExcludeWindowIds());
}
function screenFromObservation(selected) {
	return {
		index: 0,
		bounds: selected.bounds,
		scale: selected.scale,
		windowId: selected.windowId,
		...selected.transientWindowIds.length === 0 ? {} : { transientWindowIds: selected.transientWindowIds }
	};
}
let productionOps;
async function production() {
	productionOps ??= (await import("./windows-native-DKfJct5g.js")).createProductionWindowsOps();
	return productionOps;
}
/**
* Construct the Windows backend.
* @param ops - injected host operations. Omit to use Win32 on the first call.
* @returns capture and HID input against the host desktop.
*/
function createWindowsDesktopBackend(ops) {
	const use = async () => ops ?? await production();
	let observed;
	return {
		withGuiTurn: (run) => run(),
		async listScreens(signal) {
			signal?.throwIfAborted();
			const selected = observationOf(await use());
			observed = selected;
			if (selected === void 0) return [];
			return [screenFromObservation(selected)];
		},
		async capture(screen, signal) {
			signal?.throwIfAborted();
			try {
				return {
					data: (await use()).capturePng(screen.bounds),
					mediaType: "image/png"
				};
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("computer-use:")) throw error;
				throw new Error(`computer-use: screen capture failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
		async inspectForeground(signal) {
			signal?.throwIfAborted();
			const host = await use();
			const selected = observationOf(host);
			if (selected === void 0) return FOCUS_FALLBACK_FOREGROUND;
			const folder = selected.appName.toLowerCase() === "explorer" ? host.explorerFolder(selected.windowId) : void 0;
			return {
				appName: selected.appName,
				...selected.windowTitle === "" ? {} : { windowTitle: selected.windowTitle },
				...folder === void 0 ? {} : { finderFolder: folder },
				...selected.focused ? {} : { focusNote: UNFOCUSED_WINDOW_NOTE }
			};
		},
		async listApps(signal) {
			signal?.throwIfAborted();
			return (await use()).listWindowApps();
		},
		async openApp(input, signal) {
			signal?.throwIfAborted();
			const host = await use();
			if (host.activateApp(input.name)) return {
				kind: "activated",
				name: input.name
			};
			host.launch(input.name);
			return {
				kind: "launched",
				name: input.name
			};
		},
		async click(input, signal) {
			const host = await use();
			assertInput(host);
			await clickAt(host, input.button, input.count, pointOf(input.position, input.screen), liveSignal(signal));
		},
		async typeText(input, signal) {
			const host = await use();
			assertInput(host);
			const abort = liveSignal(signal);
			await clickAt(host, "left", 1, pointOf(input.position, input.screen), abort);
			if (input.replace) await chord(host, [postedVk(17), postedVk(65)], abort);
			const previous = host.readClipboardText();
			try {
				host.setClipboardText(input.text);
				await delay(CLIPBOARD_SETTLE_MS, abort);
				await chord(host, [postedVk(17), postedVk(86)], abort);
				await delay(PASTE_SETTLE_MS, abort);
				if (input.submit) {
					await delay(CLIPBOARD_SETTLE_MS, abort);
					await chord(host, [postedVk(13)], abort);
				}
			} finally {
				host.setClipboardText(previous);
			}
		},
		async scroll(input, signal) {
			const host = await use();
			assertInput(host);
			const point = pointOf(input.position, input.screen);
			const abort = liveSignal(signal);
			const step = (input.direction === "up" ? 1 : -1) * SCROLL_NOTCH;
			for (let index = 0; index < input.scrollLevel; index += 1) {
				host.scrollWheel(point.x, point.y, step);
				await delay(SCROLL_STEP_MS, abort);
			}
		},
		async hotkey(input, signal) {
			signal?.throwIfAborted();
			const host = await use();
			restoreObservedFocus(host, observed);
			assertInput(host);
			await chord(host, input.keys.map(postedKey), liveSignal(signal));
		},
		async longPress(input, signal) {
			const host = await use();
			assertInput(host);
			const point = pointOf(input.position, input.screen);
			const abort = liveSignal(signal);
			host.movePointer(point.x, point.y);
			await delay(POINTER_MOVE_SETTLE_MS, abort);
			host.mouseButton("left", true);
			try {
				await delay(Math.round(input.durationSeconds * 1e3), abort);
			} finally {
				host.mouseButton("left", false);
			}
		},
		async drag(input, signal) {
			const host = await use();
			assertInput(host);
			const start = pointOf(input.startPosition, input.startScreen);
			const end = pointOf(input.endPosition, input.endScreen);
			const abort = liveSignal(signal);
			host.movePointer(start.x, start.y);
			await delay(POINTER_MOVE_SETTLE_MS, abort);
			host.mouseButton("left", true);
			await delay(BUTTON_HOLD_MS, abort);
			for (let step = 1; step <= DRAG_STEPS; step += 1) {
				const t = step / DRAG_STEPS;
				host.movePointer(Math.round(start.x + (end.x - start.x) * t), Math.round(start.y + (end.y - start.y) * t));
				await delay(DRAG_STEP_MS, abort);
			}
			host.mouseButton("left", false);
		},
		async openInBrowser(input, signal) {
			signal?.throwIfAborted();
			(await use()).launch(input.url ?? "https://");
		},
		async openInFinder(input, signal) {
			signal?.throwIfAborted();
			const host = await use();
			if (input.revealOnly) host.launch("explorer.exe", `/select,"${input.path}"`);
			else host.launch(input.path);
		},
		async copyImageToClipboard(input, signal) {
			signal?.throwIfAborted();
			(await use()).copyImageFile(input.path);
		}
	};
}
//#endregion
//#region lib/types/backend.js
/**
* Desktop capture and input used by Computer Use tools.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/backend
*/
/** Model-facing copy when inspect finds no remaining window after overlay skip. */
const FOCUS_NOTE = "Keyboard focus is not on an operable app. Click the target window first if the next step needs focus.";
/**
* Model-facing copy when the reported Windows window is not the keyboard foreground.
* `hotkey` brings that window forward before posting keys.
*/
const UNFOCUSED_WINDOW_NOTE = "Keyboard focus is on another window. hotkey brings this window forward first; click inside it if focus must land on a specific control.";
/** Observation payload for {@link FOCUS_NOTE}. */
const FOCUS_FALLBACK_FOREGROUND = {
	appName: "none",
	focusNote: FOCUS_NOTE
};
/**
* Construct the backend for a host platform.
* @param platform - Node `process.platform` value; tests pass an explicit id.
* @param excludedRegionCapture - Desktop overlay-exclude capture; CLI omits it and spawns the helper.
* @returns macOS capture/input on Darwin, Windows capture/input on Win32, otherwise a backend whose methods throw.
*/
function createPlatformBackend(platform = process.platform, excludedRegionCapture) {
	if (platform === "darwin") return createMacosDesktopBackend(void 0, excludedRegionCapture);
	if (platform === "win32") return createWindowsDesktopBackend();
	return createUnsupportedDesktopBackend();
}
//#endregion
export { encodeBgraPng as a, modelPositionToHid as c, requirePixelPosition as d, runWithCaptureExcludeWindowIds as f, createPlatformBackend as i, requireClickModifiers as l, FOCUS_NOTE as n, delay as o, UNFOCUSED_WINDOW_NOTE as r, assertAllowedHotkey as s, FOCUS_FALLBACK_FOREGROUND as t, requireNormalizedPosition as u };
