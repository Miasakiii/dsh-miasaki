import { c as modelPositionToHid, d as requirePixelPosition, f as runWithCaptureExcludeWindowIds, i as createPlatformBackend, l as requireClickModifiers, n as FOCUS_NOTE, o as delay, r as UNFOCUSED_WINDOW_NOTE, s as assertAllowedHotkey, t as FOCUS_FALLBACK_FOREGROUND, u as requireNormalizedPosition } from "./backend-DNT4VCU7.js";
import * as fs from "node:fs/promises";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { z as z$1 } from "zod";
import { AttachmentId } from "@deepseek-ai/dsh-attachment";
//#region lib/types/config.js
/**
* Validated Computer Use tunables from cordis.yml.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/config
*/
/** Loader schema for the Computer Use plugin. */
const Config = z.object({ postActionWaitMs: z.number().default(600) });
function requireFiniteNonNegative(value, name) {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite number ≥ 0`);
	return value;
}
/**
* Apply defaults and reject invalid tunables at load.
* @param config - plugin config, possibly partial.
* @returns resolved tunables.
*/
function resolveComputerUseConfig(config = {}) {
	return { postActionWaitMs: requireFiniteNonNegative(config.postActionWaitMs ?? 600, "postActionWaitMs") };
}
//#endregion
//#region lib/types/overlay-guard.js
/**
* Optional overlay cloak around Computer Use capture and HID.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/overlay-guard
*/
/**
* Overlay window ids from one `withCapture` session.
* When the host omits the session, capture runs with an empty id list.
* @param session - begin-ack payload, or `undefined` when the host omitted it.
* @returns ids to omit, or `[]`.
*/
function captureExcludeIds(session) {
	return session?.excludeWindowIds ?? [];
}
/**
* Wrap a desktop backend so capture, foreground inspect, listScreens, HID, openApp, and withGuiTurn run inside overlay-guard intervals.
* After `listScreens`, the wrapper waits for `setObservationFrame` so the next capture exclude list includes the ribbon.
* When the listing signal is already aborted, the wrapper hides (`null`) without that signal instead of showing bounds.
* `openApp` and `withGuiTurn` use `withInput` so the overlay yields key status before activate and stays click-through through recapture.
* Desktop Host refcounts nested cloak calls so one turn sends one input begin/end.
* `listApps`, `openInBrowser`, `openInFinder`, and `copyImageToClipboard` are unwrapped because
* they do not capture pixels, inspect windows, post HID, or steal key status.
* @param inner - platform or fake backend.
* @param guard - host overlay cloak.
* @returns a backend that cloaks around capture, inspect, listScreens, HID, openApp, and withGuiTurn.
*/
function wrapDesktopBackend(inner, guard) {
	return {
		withGuiTurn: (run, signal) => guard.withInput(() => inner.withGuiTurn(run, signal), signal),
		listScreens: (signal) => guard.withCapture((session) => runWithCaptureExcludeWindowIds(captureExcludeIds(session), async () => {
			const screens = await inner.listScreens(signal);
			if (signal?.aborted) {
				try {
					await guard.setObservationFrame(null);
				} catch {}
				signal.throwIfAborted();
			}
			await guard.setObservationFrame(screens[0]?.bounds ?? null, signal);
			return screens;
		}), signal),
		capture: (screen, signal) => guard.withCapture((session) => runWithCaptureExcludeWindowIds(captureExcludeIds(session), () => inner.capture(screen, signal)), signal),
		inspectForeground: (signal) => guard.withCapture((session) => runWithCaptureExcludeWindowIds(captureExcludeIds(session), () => inner.inspectForeground(signal)), signal),
		listApps: (signal) => inner.listApps(signal),
		openApp: (input, signal) => guard.withInput(() => inner.openApp(input, signal), signal),
		click: (input, signal) => guard.withInput(() => inner.click(input, signal), signal),
		typeText: (input, signal) => guard.withInput(() => inner.typeText(input, signal), signal),
		scroll: (input, signal) => guard.withInput(() => inner.scroll(input, signal), signal),
		hotkey: (input, signal) => guard.withInput(() => inner.hotkey(input, signal), signal),
		longPress: (input, signal) => guard.withInput(() => inner.longPress(input, signal), signal),
		drag: (input, signal) => guard.withInput(() => inner.drag(input, signal), signal),
		openInBrowser: (input, signal) => inner.openInBrowser(input, signal),
		openInFinder: (input, signal) => inner.openInFinder(input, signal),
		copyImageToClipboard: (input, signal) => inner.copyImageToClipboard(input, signal)
	};
}
/** Projection unit folding `'computer-use/coordinate-mode'` to the last logged encoding. */
const coordinateModeProjection = {
	key: "computerUseCoordinateMode",
	stateVersion: 1,
	stateSchema: z$1.object({ mode: z$1.enum(["millifraction", "pixel"]) }).strict(),
	init: () => ({ mode: "millifraction" }),
	apply: (state, event) => {
		if (event.type !== "computer-use/coordinate-mode") return state;
		if (event.data.mode === state.mode) return state;
		return { mode: event.data.mode };
	}
};
const observationCache = /* @__PURE__ */ new WeakMap();
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
/**
* Last image raster in a content tree (observation envelopes, nested tool-result blocks).
* @param value - message content or a nested block.
* @returns the last image width/height, when any.
*/
function lastRasterIn(value) {
	if (Array.isArray(value)) {
		let found;
		for (const entry of value) {
			const raster = lastRasterIn(entry);
			if (raster !== void 0) found = raster;
		}
		return found;
	}
	if (!isRecord(value)) return void 0;
	if (value.type === "image" && isRecord(value.attachment)) {
		const width = value.attachment.width;
		const height = value.attachment.height;
		if (typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return {
			width,
			height
		};
	}
	let found;
	for (const nested of Object.values(value)) {
		const raster = lastRasterIn(nested);
		if (raster !== void 0) found = raster;
	}
	return found;
}
/**
* Reconstruct the last Computer Use observation raster from the session log.
* @param session - session whose events may include first-frame notices or GUI results.
* @returns attached width/height, or undefined when no CU image remains.
*/
function reconstructFromLog(session) {
	const events = session.snapshotEvents();
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event === void 0) continue;
		if (event.type === "user/message") {
			const source = event.data.source;
			if (source.kind !== "computer-use" || source.form !== "notice") continue;
			const raster = lastRasterIn(event.data.content);
			if (raster !== void 0) return raster;
		}
		if (event.type === "tool/result") {
			const raster = lastRasterIn(event.data.message.content);
			if (raster !== void 0) return raster;
		}
	}
}
/**
* Logged encoding when a `'computer-use/coordinate-mode'` event exists.
* @param session - session to scan, or a test stub.
* @returns the last logged mode, or undefined when the log has none.
*/
function loggedCoordinateMode(session) {
	const events = session?.snapshotEvents?.();
	if (events === void 0) return void 0;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type === "computer-use/coordinate-mode") return event.data.mode;
	}
}
/**
* Click encoding in force for a request. Missing event, missing session, and
* Headless/Web logs without a stamp all read as millifraction.
* @param session - the session being assembled or executed.
* @returns millifraction or pixel.
*/
function coordinateModeOf(session) {
	return loggedCoordinateMode(session) ?? "millifraction";
}
/**
* Remember the attached raster from an observation so the next pixel click can divide by it.
* @param session - session that received the observation; omitted on stubs without identity.
* @param screens - captured screens; empty clears the raster (fail closed).
*/
function rememberObservation(session, screens) {
	if (session === void 0) return;
	const first = screens[0]?.image;
	observationCache.set(session, first === void 0 ? false : {
		width: first.width,
		height: first.height
	});
}
/**
* Attached raster the model is looking at: live cache, else last CU image in the log.
* @param session - session whose last observation is needed.
* @returns width/height, or undefined when pixel mapping must fail.
*/
function lastAttachedRaster(session) {
	if (session === void 0) return void 0;
	const cached = observationCache.get(session);
	if (cached === false) return void 0;
	if (cached !== void 0) return cached;
	if (typeof session.snapshotEvents !== "function") return void 0;
	const reconstructed = reconstructFromLog(session);
	observationCache.set(session, reconstructed === void 0 ? false : reconstructed);
	return reconstructed;
}
/**
* Canonical coordinate fields stored on a GUI tool result.
* @param session - calling session.
* @param screens - recapture screens; pixel mode names the first attached raster.
* @returns coordinateMode plus optional attachedWidth/Height.
*/
function coordinateOutcome(session, screens) {
	const mode = coordinateModeOf(session);
	const first = screens[0]?.image;
	if (mode === "pixel" && first !== void 0) return {
		coordinateMode: mode,
		attachedWidth: first.width,
		attachedHeight: first.height
	};
	return { coordinateMode: mode };
}
/**
* Model-facing sentence that the next click still uses this session's encoding.
* @param outcome - canonical result fields.
* @returns millifraction or pixel remain-copy.
*/
function coordinatesRemain(outcome) {
	if (outcome.coordinateMode === "pixel") {
		if (outcome.attachedWidth !== void 0 && outcome.attachedHeight !== void 0) return `Coordinates remain pixels of the attached ${String(outcome.attachedWidth)}x${String(outcome.attachedHeight)} screenshot.`;
		return "Coordinates remain pixels of the attached screenshot.";
	}
	return "Coordinates remain 0–1000.";
}
/**
* First-frame plugin notice that names this session's click space.
* @param mode - session contract.
* @returns millifraction or pixel notice text.
*/
function firstFrameNotice(mode) {
	if (mode === "pixel") return "Current frontmost window. Coordinates are pixel columns and rows of this screenshot ([0, 0] top-left). Use attached_size on the observation envelope. Do not send 0–1000 fractions.";
	return "Current frontmost window. Coordinates are 0–1000 fractions of this screenshot ([0, 0] top-left, [1000, 1000] bottom-right). Center x is 500, not a pixel x.";
}
const PIXEL_POSITION = "[x, y] as pixel columns and rows of the attached screenshot named on that observation, not a 0–1000 fraction.";
const PIXEL_TOOLS = {
	click: {
		description: "Click at a pixel position on the attached frontmost-window screenshot, then return the post-action screenshot. Use left (default) or right button; count 2 is a double-click. Optional modifiers (shift, cmd, option, control) are held only for this click.",
		parameters: { position: PIXEL_POSITION }
	},
	input_text: {
		description: "Click to focus a pixel position on the attached frontmost-window screenshot, type text, optionally replace existing content and press Enter, then return the post-action screenshot.",
		parameters: { position: `${PIXEL_POSITION} The click focuses the field.` }
	},
	scroll: {
		description: "Scroll up or down at a pixel position on the attached frontmost-window screenshot, then return the post-action screenshot. scroll_level is 1–10.",
		parameters: { position: PIXEL_POSITION }
	},
	long_press: {
		description: "Press and hold the left button at a pixel position on the attached frontmost-window screenshot, then return the post-action screenshot. duration_seconds defaults to 3 and must be 1–10.",
		parameters: { position: PIXEL_POSITION }
	},
	drag: {
		description: "Drag from a start pixel position to an end pixel position on the attached frontmost-window screenshot, then return the post-action screenshot.",
		parameters: {
			start_position: "[x, y] start as pixel columns and rows of the attached screenshot named on that observation, not a 0–1000 fraction.",
			end_position: "[x, y] end as pixel columns and rows of the attached screenshot named on that observation, not a 0–1000 fraction."
		}
	}
};
function rewritePixelTool(tool) {
	const copy = PIXEL_TOOLS[tool.name];
	if (copy === void 0) return tool;
	const parameters = structuredClone(tool.parameters);
	const properties = parameters.properties;
	if (isRecord(properties)) for (const [name, description] of Object.entries(copy.parameters)) {
		const field = properties[name];
		if (isRecord(field)) field.description = description;
	}
	return {
		...tool,
		description: copy.description,
		parameters
	};
}
/**
* Rewrite assembled `position` tool schemas for a pixel-mode session.
* Millifraction assemblies keep the registered 0–1000 copy.
* @param tools - assembled tool schemas.
* @param mode - session contract.
* @returns tools with pixel `position` copy when `mode` is pixel.
*/
function toolsForCoordinateMode(tools, mode) {
	if (mode === "millifraction") return [...tools];
	return tools.map(rewritePixelTool);
}
function hasCoordinateModeEvent(session) {
	return session.snapshotEvents().some((event) => event.type === "computer-use/coordinate-mode");
}
function hasEndSeed(session) {
	return session.snapshotEvents().some((event) => event.type === "session/end-seed");
}
/**
* Stamp a blank overlay create with the Desktop default encoding.
* History adopt / resume (an `session/end-seed` is already in the log) and a
* log that already has `'computer-use/coordinate-mode'` are left unchanged.
* Headless/Web omit `orbCoordinateMode` and do not write the event.
* @param ctx - plugin context; optional `orbCoordinateMode` is Desktop-only.
* @param session - newly created Computer Use session.
*/
function stampCoordinateMode(ctx, session) {
	if (hasCoordinateModeEvent(session) || hasEndSeed(session)) return;
	const service = ctx.get("orbCoordinateMode");
	if (service === void 0) return;
	session.append("computer-use/coordinate-mode", { mode: service.currentMode() });
}
/**
* Register the coordinate-mode projection when the host composes session-projection,
* and stamp blank Computer Use agents at `agent/created`.
* @param ctx - Computer Use standing mount.
*/
function installCoordinateMode(ctx) {
	const projections = ctx.get("sessionProjections");
	if (projections !== void 0) projections.register(coordinateModeProjection);
	else ctx.inject(["sessionProjections"], (scoped) => {
		scoped.sessionProjections.register(coordinateModeProjection);
	});
	ctx.on("agent/created", ({ agent }) => {
		stampCoordinateMode(ctx, agent.session);
	});
}
const PATH_BLACKLIST = [
	"/System",
	"/private",
	"/etc",
	"/var",
	"/usr",
	"/sbin",
	"/bin",
	"/dev",
	"/proc",
	"/sys"
];
/** UTF-8 multi-byte percent-encoding such as `%E5%88%98`; sparse ASCII like `%20` is allowed. */
const MULTIBYTE_UTF8_PERCENT = /%(?:[Cc][2-9A-Fa-f]|[Dd][0-9A-Fa-f]|[Ee][0-9A-Fa-f]|[Ff][0-7])(?:%[0-9A-Fa-f]{2})+/u;
/**
* Whether `resolved` is a blocked system prefix.
* @param resolved - absolute realpath.
* @returns true when Finder/open must refuse the path.
*/
function isForbiddenOpenPath(resolved) {
	return PATH_BLACKLIST.some((prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`));
}
/**
* Require `duration_seconds` in 1–10, defaulting to 3.
* @param value - model-supplied duration, or undefined.
* @returns the validated duration in seconds.
* @throws when the value is not a finite number in 1–10.
*/
function requireLongPressDuration(value) {
	const duration = value ?? 3;
	if (!Number.isFinite(duration) || duration < 1 || duration > 10) throw new Error("duration_seconds must be a number from 1 to 10");
	return duration;
}
/**
* Path and query of a URL string without decoding percent-encoding.
* @param rawUrl - trimmed URL, with or without a scheme.
* @returns the substring from the first `/` or `?` after the host, or the whole string.
*/
function urlPathAndQuery(rawUrl) {
	const afterScheme = (/^https?:\/\//iu.test(rawUrl) ? rawUrl : `https://${rawUrl}`).replace(/^https?:\/\//iu, "");
	const pathStart = afterScheme.search(/[/?#]/u);
	return pathStart < 0 ? "" : afterScheme.slice(pathStart);
}
/**
* Whether path or query contains CJK-style multi-byte percent-encoding.
* @param rawUrl - model-supplied URL, with or without a scheme.
* @returns true when the model must send plain CJK instead.
*/
function browserUrlHasCjkPercentEncoding(rawUrl) {
	const trimmed = rawUrl.trim();
	if (trimmed === "") return false;
	return MULTIBYTE_UTF8_PERCENT.test(urlPathAndQuery(trimmed));
}
/**
* Require an http(s) URL, adding `https://` when the scheme is missing.
* @param rawUrl - model-supplied URL.
* @returns the scheme-normalized URL with CJK left as plain text.
* @throws when the URL is empty, not http(s), includes userinfo, or uses CJK percent-encoding.
*/
function requireBrowserUrl(rawUrl) {
	const trimmed = rawUrl.trim();
	if (trimmed === "") throw new Error("url must be a non-empty http(s) URL when provided");
	if (browserUrlHasCjkPercentEncoding(trimmed)) throw new Error("url path and query must use plain CJK text, not percent-encoding such as %E5... / %E8...");
	const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(trimmed)?.[1]?.toLowerCase();
	if (scheme !== void 0 && scheme !== "http" && scheme !== "https") throw new Error("url must be an http(s) URL");
	const withScheme = scheme === void 0 ? `https://${trimmed}` : trimmed;
	let parsed;
	try {
		parsed = new URL(withScheme);
	} catch {
		throw new Error("url must be a valid http(s) URL");
	}
	if (parsed.username !== "" || parsed.password !== "") throw new Error("url must not include userinfo");
	return withScheme;
}
/**
* Resolve `open_in_finder` arguments to an absolute realpath.
* @param path - model-supplied path; omitted opens the user's Desktop.
* @param revealOnly - reveal a file in Finder instead of opening it.
* @param home - home directory used when `path` is omitted; default `os.homedir()`.
* @returns the resolved path and reveal flag.
* @throws when the path is missing, blacklisted, or cannot be resolved.
*/
async function resolveFinderOpen(path, revealOnly, home = homedir()) {
	const trimmed = path === void 0 ? "" : path.trim();
	const expanded = trimmed === "" || trimmed === "~" ? join(home, "Desktop") : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed;
	let resolved;
	try {
		resolved = await realpath(expanded);
	} catch (error) {
		throw new Error(`computer-use: path does not exist: ${expanded} (${String(error)})`);
	}
	if (isForbiddenOpenPath(resolved)) throw new Error(`computer-use: opening a system path is forbidden: ${resolved}`);
	return {
		path: resolved,
		revealOnly
	};
}
//#endregion
//#region lib/types/observe.js
/**
* Capture the frontmost window, persist it, and build model-facing image content.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/observe
*/
const IMAGE_NAME_PREFIX = "desktop-screen";
function isObservationAbort(error, signal) {
	if (signal.aborted) return true;
	return error instanceof Error && error.name === "AbortError";
}
function optionalImageFields(image) {
	return {
		...image.name === void 0 ? {} : { name: image.name },
		...image.originalDimensions === void 0 ? {} : { originalDimensions: { ...image.originalDimensions } }
	};
}
/**
* Re-brand stored image metadata into the attachment reference an `ImageBlock` carries.
* @param image - canonical image metadata.
* @returns the branded attachment reference.
*/
function imageRefFromObserved(image) {
	return {
		attachmentId: AttachmentId(image.attachmentId),
		mediaType: image.mediaType,
		bytes: image.bytes,
		width: image.width,
		height: image.height,
		...optionalImageFields(image)
	};
}
function envelopeValue(value) {
	return value.replace(/[\r\n]+/g, " ").trim();
}
/**
* Format OS foreground metadata as one observation-level envelope.
* Empty folder, title, and note fields are omitted. Screenshot filesystem paths are never included.
* @param foreground - inspect result after overlay-window skip.
* @returns model-facing tags for app name, optional window title, optional Finder folder, or focus fallback.
*/
function formatForegroundEnvelope(foreground) {
	const lines = [`<frontmost_app>${envelopeValue(foreground.appName) || "none"}</frontmost_app>`];
	if (foreground.windowTitle !== void 0) {
		const title = envelopeValue(foreground.windowTitle);
		if (title !== "") lines.push(`<frontmost_window>${title}</frontmost_window>`);
	}
	if (foreground.focusNote !== void 0) {
		const note = envelopeValue(foreground.focusNote);
		if (note !== "") lines.push(`<focus_note>${note}</focus_note>`);
		return lines.join("\n");
	}
	if (foreground.finderFolder !== void 0) {
		const folder = envelopeValue(foreground.finderFolder);
		if (folder !== "") lines.push(`<frontmost_folder>${folder}</frontmost_folder>`);
	}
	return lines.join("\n");
}
/**
* Copy foreground fields that schema validation accepts (`undefined` keys omitted).
* @param foreground - inspect result stored on the observation.
* @returns a tool-output object with only defined optional fields.
*/
function compactForeground(foreground) {
	return {
		appName: foreground.appName,
		...foreground.windowTitle === void 0 ? {} : { windowTitle: foreground.windowTitle },
		...foreground.finderFolder === void 0 ? {} : { finderFolder: foreground.finderFolder },
		...foreground.focusNote === void 0 ? {} : { focusNote: foreground.focusNote }
	};
}
/**
* Format one screen as model-facing envelope text.
* Millifraction names only the 0–1000 space. Pixel mode names that attachment's WxH,
* which is the same pair execute divides by. Paths and other pixel sizes stay omitted.
* @param screen - captured display and attached image.
* @param mode - session click encoding; millifraction when omitted.
* @returns envelope text naming index and the click space.
*/
function formatScreenEnvelope(screen, mode = "millifraction") {
	if (mode === "pixel") return `<screen_index>${String(screen.screenIndex)}</screen_index>
<coordinate_space>pixels</coordinate_space>
<attached_size>${String(screen.image.width)}x${String(screen.image.height)}</attached_size>`;
	return `<screen_index>${String(screen.screenIndex)}</screen_index>
<coordinate_space>0-1000</coordinate_space>`;
}
/**
* Project captured screens into alternating envelope text and image blocks.
* @param screens - captured displays in index order.
* @param mode - session click encoding; millifraction when omitted.
* @returns model-facing content with no filesystem path.
*/
function observationBlocks(screens, mode = "millifraction") {
	const blocks = [];
	for (const screen of screens) {
		blocks.push({
			type: "text",
			text: formatScreenEnvelope(screen, mode)
		});
		blocks.push({
			type: "image",
			attachment: imageRefFromObserved(screen.image)
		});
	}
	return blocks;
}
/**
* Observation content: one foreground block, then per-screen envelopes and images.
* @param screens - captured displays in index order.
* @param foreground - OS metadata from {@link DesktopBackend.inspectForeground}.
* @param mode - session click encoding; millifraction when omitted.
* @returns model-facing content with no screenshot filesystem path.
*/
function observationContent(screens, foreground, mode = "millifraction") {
	return [{
		type: "text",
		text: formatForegroundEnvelope(foreground)
	}, ...observationBlocks(screens, mode)];
}
/**
* Capture the overlay-skipped frontmost window, persist the image, and build content blocks.
* When no operable window remains, returns focus tags with no screenshot.
* @param ctx - plugin context with `attachments`.
* @param backend - desktop capture implementation.
* @param signal - cooperative cancellation.
* @param options - optional settle wait, session click encoding, and persist filter.
* @returns canonical screens, foreground metadata, and model-facing blocks.
*/
async function observeDesktop(ctx, backend, signal, options = {}) {
	signal.throwIfAborted();
	const settleMs = options.settleMs ?? 0;
	if (settleMs > 0) await delay(settleMs, signal);
	const selected = (await backend.listScreens(signal)).slice(0, 1);
	let foreground = FOCUS_FALLBACK_FOREGROUND;
	try {
		foreground = await backend.inspectForeground(signal);
	} catch (error) {
		if (isObservationAbort(error, signal)) throw error;
	}
	const screens = [];
	const captures = [];
	const persistCapture = options.persistCapture;
	for (const screen of selected) {
		signal.throwIfAborted();
		const captured = await backend.capture(screen, signal);
		captures.push(captured);
		if (persistCapture !== void 0 && !persistCapture(captured)) continue;
		const saved = await ctx.attachments.saveImage({
			data: captured.data,
			mediaType: captured.mediaType,
			name: `${IMAGE_NAME_PREFIX}-${String(screen.index)}`
		});
		screens.push({
			screenIndex: screen.index,
			logicalWidth: screen.bounds.width,
			logicalHeight: screen.bounds.height,
			scale: screen.scale,
			image: {
				attachmentId: saved.attachmentId,
				mediaType: saved.mediaType,
				bytes: saved.bytes,
				width: saved.width,
				height: saved.height,
				...optionalImageFields(saved)
			}
		});
	}
	return {
		screens,
		foreground,
		blocks: observationContent(screens, foreground, options.coordinateMode ?? "millifraction"),
		captures
	};
}
/**
* Resolve a screen_index against the current observation surface list.
* @param screens - backend surface list.
* @param screenIndex - model-supplied index.
* @returns the matching screen.
* @throws when the index is missing.
*/
function requireScreen(screens, screenIndex) {
	const screen = screens.find((candidate) => candidate.index === screenIndex);
	if (screen === void 0) {
		const last = screens.at(-1);
		const range = last === void 0 ? "none" : `0..${String(last.index)}`;
		throw new Error(`computer-use: screen_index ${String(screenIndex)} is out of range (${range})`);
	}
	return screen;
}
const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
function viewOf(data) {
	return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
function pngSize(data) {
	if (data.length < 24) return void 0;
	for (let i = 0; i < PNG_SIGNATURE.length; i += 1) if (data[i] !== PNG_SIGNATURE[i]) return void 0;
	if (data[12] !== 73 || data[13] !== 72 || data[14] !== 68 || data[15] !== 82) return void 0;
	const view = viewOf(data);
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	if (width < 1 || height < 1) return void 0;
	return {
		width,
		height
	};
}
function isStartOfFrame(marker) {
	if (marker < 192 || marker > 207) return false;
	return marker !== 196 && marker !== 200 && marker !== 204;
}
function jpegSize(data) {
	if (data.length < 4 || data[0] !== 255 || data[1] !== 216) return void 0;
	const view = viewOf(data);
	let index = 2;
	while (index + 1 < data.length) {
		if (data[index] !== 255) return void 0;
		while (index < data.length && data[index] === 255) index += 1;
		if (index >= data.length) return void 0;
		const marker = view.getUint8(index);
		index += 1;
		if (marker === 217 || marker === 218) return void 0;
		if (marker === 216 || marker >= 208 && marker <= 215 || marker === 1) continue;
		if (index + 1 >= data.length) return void 0;
		const length = view.getUint16(index);
		if (length < 2 || index + length > data.length) return void 0;
		if (isStartOfFrame(marker)) {
			if (length < 7) return void 0;
			const height = view.getUint16(index + 3);
			const width = view.getUint16(index + 5);
			if (width < 1 || height < 1) return void 0;
			return {
				width,
				height
			};
		}
		index += length;
	}
}
/**
* Read intrinsic pixel size from a PNG or JPEG header without decoding pixels.
* @param data - encoded capture bytes.
* @returns width and height, or `undefined` when the bytes are not a PNG or JPEG with a valid size.
*/
function observationRasterSize(data) {
	return pngSize(data) ?? jpegSize(data);
}
/**
* Whether `screenshot` may persist this capture to Desktop, clipboard, and attachments.
* @param data - encoded capture bytes.
* @returns false when the header is unreadable or either edge is below {@link MIN_USABLE_OBSERVATION_EDGE}.
*/
function isUsableObservationRaster(data) {
	const size = observationRasterSize(data);
	return size !== void 0 && size.width >= 2 && size.height >= 2;
}
//#endregion
//#region lib/types/policy.js
/**
* Model-facing Computer Use guidance registered as one system-prompt section.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/policy
*/
const POLICY_BEFORE_COORDINATES = `Computer Use lets you see the current frontmost application window and operate the GUI.

See: trust only the attached screenshot of the frontmost application on this display for windows, buttons, and on-screen text. The image includes that app's open menus, popovers, and panels. It does not include the Dock, menu bar, other applications (except where they overlap this app's windows), or other displays. Do not assume UI that is not visible in the latest image. You may use observation tags <frontmost_app>, <frontmost_window>, <frontmost_folder>, and <focus_note> as OS metadata.

`;
const MILLIFRACTION_COORDINATES = "Coordinates: the attached screenshot uses a 0–1000 space of that window. [0, 0] is the top-left of that image and [1000, 1000] is the bottom-right. x and y scale independently; do not treat the space as a square overlay. Pass position as [x, y] in that space together with screen_index 0. Encode x and y as fractions of this screenshot × 1000 (center x is 500, not a pixel x). Ignore pixel widths and any other image-handle dimensions. Do not send raw pixel coordinates.";
const PIXEL_COORDINATES = "Coordinates: the attached screenshot uses pixel columns and rows of that image. [0, 0] is the top-left pixel. Pass position as [x, y] in that pixel space together with screen_index 0. Read attached_size on the latest observation envelope as width×height of this screenshot; x runs 0 to that width and y runs 0 to that height. Do not send 0–1000 fractions. Ignore image-handle dimensions that are not on the Computer Use envelope.";
const POLICY_AFTER_COORDINATES = `

Step: you may emit several GUI tool calls in one step when every target is already visible in the latest screenshot and later calls do not need UI that earlier calls create. The host runs those calls in order. Each result includes its own post-action screenshot; after the step, use the last image for any action that depends on what changed. Do not batch a click, type, or hotkey whose target appears only after an earlier action in the same step (menu, dialog, new page, loader).

Do not click or type into a target you cannot see. Do not OCR file paths from the screenshot. When a file or folder path is known, call open_in_finder with that path; do not click Desktop icons to open it. When <frontmost_folder> is present, copy that path; otherwise use bash with real paths. When <focus_note> is present, call open_app to bring the target application forward if the next step needs a window. Do not click chrome that is not in the image.

If <frontmost_app> or the screenshot is not the application the user asked for, call list_apps or open_app. Do not click the Dock; it is not in the screenshot.

Observation is not a tool. After bash, search, or web_fetch, screenshot may refresh the frontmost window. After click, type, wait, or open, do not call screenshot again — those results already attach a window. Call screenshot when the user asked for a screenshot file or needs the image on the clipboard to paste.

This session drives the real unsandboxed desktop. Use bash for a command that answers the user or feeds the next click, including one more command when the first missed. When you are still digging through files or commands, hand that stretch to code_agent. Do not use bash open as a substitute for open_in_finder, open_in_browser, or open_app.

Open a site in the user's visible browser with open_in_browser. web_search and web_fetch return text to you; they do not open a window the user can see.

Drag sliders, window edges, and files with drag. Press and hold with long_press. Multi-select with click plus shift or cmd on each later click; do not hold a modifier across calls.

When the latest screenshot still shows a loader, spinner, or a control that has not appeared, call wait. After click or open, the tool result already has a new screenshot; do not immediately wait unless that image still shows loading. When the screenshot shows a long job still running (download, install, export, or in-window generation), call long_wait with the smallest of 10, 30, 60, or 120 that covers remaining progress. Do not use long_wait for ordinary page load.

Decide each stretch yourself:
- Do it in this chat when it is visible GUI, or when one search or one command will answer the user or feed the next click. A second search that you expect will hit the point stays here. Visible GUI such as opening WeChat or clicking a button in Pages → GUI tools only. Do not call code_agent. A short lookup such as today's weather or current headlines → web_search or web_fetch in this chat. Do not call code_agent or GUI tools.
- Hand the stretch to code_agent when you are still digging through files, searches, or commands. The last step being a click does not keep that investigation here: hand off the investigation, then click after the completion notice.
- A file, document, spreadsheet, or site, such as writing a Word document, a PPT, an Excel file, a website, or a research report (write the report as HTML) → code_agent without session_id.
- Follow-up on the same artifact such as making that Word document's font green, or another stretch of the same investigation → code_agent with the session_id from that earlier result.
- Unrelated new background work such as making a gobang game after the Word document → code_agent without session_id. Do not reuse the Word session.

Working directory for a new code_agent session:
- When the user names a path (Desktop, a home folder, or an absolute path) → pass that path as cwd.
- When the user says "here", "this folder", or "the current window" and <frontmost_folder> is present → pass that folder as cwd.
- When the user says "here", "this folder", or "the current window" and <frontmost_folder> is absent → do not call code_agent. Tell the user the frontmost window is not Finder, so the current folder path is unknown; they should click that Finder window or give a path.
- Otherwise omit cwd; the tool creates a new subdirectory under this session's workspace.

If the user's request names a folder or window that does not match the screenshot or <frontmost_folder>, ask_user_question in this chat. Do not guess. Do not fall back to this session's workspace.

After code_agent returns, tell the user the background Code agent is running. Continue with a GUI action in this turn only when it does not need the background result; otherwise end the turn. Do not call wait, long_wait, or bash sleep to poll that session.

Call code_agent_status when the user asks how many background tasks there are, what they are, where they run, or whether they are still running. Call code_agent_stop when the user wants a background task cancelled. Stopping leaves the session idle; a later code_agent with the same session_id continues that artifact.

When a plugin notice reports that a Code agent session finished, decide again. Do remaining GUI that the result makes possible. If another stretch of file search or file production remains, call code_agent with that session_id. Then tell the user the short conclusion. Do not recite a long report.

When a user message starts with "Desktop selection. Answer in this chat only. Do not call GUI tools or code_agent.", answer in this chat only. Do not call GUI tools, code_agent, or screenshot on that turn.`;
/**
* Computer Use policy for one session encoding.
* @param mode - millifraction 0–1000 or attached-raster pixels.
* @returns the assembled policy section text.
*/
function policyFor(mode) {
	return `${POLICY_BEFORE_COORDINATES}${mode === "pixel" ? PIXEL_COORDINATES : MILLIFRACTION_COORDINATES}${POLICY_AFTER_COORDINATES}`;
}
/**
* Stable millifraction Computer Use policy text. Assemblies without an agent
* and Headless/Web sessions without a coordinate-mode event use this text.
*/
const POLICY = policyFor("millifraction");
//#endregion
//#region lib/types/route.js
/**
* Image-modality checks for Computer Use tools and first-frame attachment.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/route
*/
/**
* Resolve the calling agent's latest provider/model from the request header, then agent options.
* @param agent - calling agent, when any.
* @returns the route ids, or undefined when they cannot be resolved.
*/
function resolveAgentRoute(agent) {
	const routed = agent?.session.requestHeader()?.config;
	const provider = routed?.provider ?? agent?.options.provider;
	const model = routed?.model ?? agent?.options.model;
	if (provider === void 0 || model === void 0) return void 0;
	return {
		provider,
		model
	};
}
/**
* Whether the agent's exact route declares image input.
* @param ctx - plugin context; `llm` is optional.
* @param agent - calling agent, when any.
* @param signal - cooperative cancellation.
* @returns true only when the resolved model lists `image`.
*/
async function routeAcceptsImages(ctx, agent, signal) {
	const route = resolveAgentRoute(agent);
	const llm = ctx.get("llm");
	if (route === void 0 || llm === void 0) return false;
	const active = await llm.resolveModelInfo(route.provider, route.model, signal);
	return active.inputModalities !== void 0 && active.inputModalities.includes("image");
}
/**
* Refuse a GUI tool unless the calling route declares image input.
* @param ctx - plugin context used to resolve the optional `llm` service.
* @param exec - tool-execution context supplying the calling agent.
* @throws when the route cannot be resolved or does not declare image input.
*/
async function assertImageCapableRoute(ctx, exec) {
	const route = resolveAgentRoute(exec.agent);
	const llm = ctx.get("llm");
	if (route === void 0 || llm === void 0) throw new Error("cannot use computer-use tools: the current model route could not be resolved");
	const active = await llm.resolveModelInfo(route.provider, route.model, exec.signal);
	if (active.inputModalities === void 0 || !active.inputModalities.includes("image")) throw new Error(`cannot use computer-use tools: model "${route.model}" does not declare image input; switch to an image-capable model`);
}
function textOf(content) {
	return content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
/**
* Whether a claimed pre-step batch is a Desktop selection-toolbar user turn.
* @param messages - messages the loop claimed for this step.
* @returns true when a `source.kind === 'user'` message starts with {@link DESKTOP_SELECTION_PREAMBLE}.
*/
function isDesktopSelectionTurn(messages) {
	return messages.some((message) => message.source.kind === "user" && textOf(message.content).startsWith("Desktop selection. Answer in this chat only. Do not call GUI tools or code_agent."));
}
//#endregion
//#region lib/types/screenshot.js
/**
* Write captured desktop rasters to the user's Desktop with unique filenames.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/screenshot
*/
const EXTENSION = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp"
};
function pad2(value) {
	return String(value).padStart(2, "0");
}
/**
* macOS-style Screenshot stamp used as the Desktop filename stem.
* @param now - local time used in the stamp.
* @param screenIndex - observation surface index (0 for the attached window).
* @param screenCount - how many surfaces this capture wrote.
* @returns filename stem without extension.
*/
function screenshotFileStem(now, screenIndex, screenCount) {
	const stamp = `${String(now.getFullYear())}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} at ${pad2(now.getHours())}.${pad2(now.getMinutes())}.${pad2(now.getSeconds())}`;
	if (screenCount === 1) return `Screenshot ${stamp}`;
	return `Screenshot ${stamp} (screen ${String(screenIndex)})`;
}
async function pathExists(path) {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}
async function uniquePath(directory, stem, extension) {
	let candidate = join(directory, `${stem}.${extension}`);
	for (let suffix = 2; suffix <= 101; suffix += 1) {
		if (!await pathExists(candidate)) return candidate;
		if (suffix > 100) break;
		candidate = join(directory, `${stem} ${String(suffix)}.${extension}`);
	}
	throw new Error("computer-use: could not allocate a unique screenshot filename");
}
/**
* Pair capture rasters with observation screen indexes.
* @param captures - rasters in screen order.
* @param screens - observation envelopes in the same order.
* @returns files ready for {@link writeDesktopScreenshots}.
*/
function pairScreenshotFiles(captures, screens) {
	if (captures.length !== screens.length) throw new Error("computer-use: screenshot captures and screens disagree");
	const files = [];
	for (const [index, captured] of captures.entries()) {
		const screen = screens[index];
		if (screen === void 0) throw new Error("computer-use: screenshot captures and screens disagree");
		files.push({
			data: captured.data,
			mediaType: captured.mediaType,
			screenIndex: screen.screenIndex
		});
	}
	return files;
}
/**
* Write each captured display onto the user's Desktop.
* @param files - captured rasters in screen order.
* @param options.home - home directory whose Desktop receives the files.
* @param options.now - local timestamp used in the filename stamp; default `new Date()`.
* @returns absolute paths in the same order as `files`.
*/
async function writeDesktopScreenshots(files, options) {
	if (files.length === 0) throw new Error("computer-use: no screenshot files to write");
	const home = options.home;
	const now = options.now ?? /* @__PURE__ */ new Date();
	const desktop = join(home, "Desktop");
	await fs.mkdir(desktop, { recursive: true });
	const paths = [];
	for (const file of files) {
		const path = await uniquePath(desktop, screenshotFileStem(now, file.screenIndex, files.length), EXTENSION[file.mediaType]);
		await fs.writeFile(path, file.data);
		paths.push(path);
	}
	return paths;
}
//#endregion
//#region lib/types/wait-args.js
/** Allowed `long_wait` pauses, in seconds. */
const LONG_WAIT_SECONDS = [
	10,
	30,
	60,
	120
];
/**
* Require a `long_wait` duration from model JSON.
* @param raw - `wait_seconds` from the tool call.
* @returns one of {@link LONG_WAIT_SECONDS}.
* @throws when the value is missing or not 10, 30, 60, or 120.
*/
function requireLongWaitSeconds(raw) {
	if (typeof raw !== "number" || !Number.isInteger(raw) || !isLongWaitSeconds(raw)) throw new Error("wait_seconds must be 10, 30, 60, or 120");
	return raw;
}
function isLongWaitSeconds(value) {
	return LONG_WAIT_SECONDS.includes(value);
}
//#endregion
//#region lib/types/plugin.js
/**
* Register Computer Use tools, policy, and first-frame screenshot attachment.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/plugin
*/
/** Cordis plugin name used as the first-frame notice producer id. */
const PLUGIN_NAME = "tool-computer-use";
/** Prompt section sort order: after PTY guidance, before web search. */
const POLICY_SECTION_ORDER = 1750;
const SCREENS_FIELD = {
	type: "array",
	required: true,
	items: {
		type: "object",
		additionalProperties: false,
		properties: {
			screenIndex: {
				type: "integer",
				required: true
			},
			logicalWidth: {
				type: "number",
				required: true
			},
			logicalHeight: {
				type: "number",
				required: true
			},
			scale: {
				type: "number",
				required: true
			},
			image: {
				type: "object",
				additionalProperties: false,
				required: true,
				properties: {
					attachmentId: {
						type: "string",
						required: true
					},
					mediaType: {
						type: "string",
						enum: [
							"image/png",
							"image/jpeg",
							"image/webp",
							"image/gif"
						],
						required: true
					},
					bytes: {
						type: "integer",
						required: true
					},
					width: {
						type: "integer",
						required: true
					},
					height: {
						type: "integer",
						required: true
					},
					name: { type: "string" },
					originalDimensions: {
						type: "object",
						additionalProperties: false,
						properties: {
							width: {
								type: "integer",
								required: true
							},
							height: {
								type: "integer",
								required: true
							}
						}
					}
				}
			}
		}
	}
};
const FOREGROUND_FIELD = {
	type: "object",
	additionalProperties: false,
	required: true,
	properties: {
		appName: {
			type: "string",
			required: true
		},
		windowTitle: { type: "string" },
		finderFolder: { type: "string" },
		focusNote: { type: "string" }
	}
};
const COORDINATE_FIELDS = {
	coordinateMode: {
		type: "string",
		required: true,
		enum: ["millifraction", "pixel"]
	},
	attachedWidth: { type: "integer" },
	attachedHeight: { type: "integer" }
};
function genericExecute(title, rawInput) {
	return {
		card: "generic",
		title,
		kind: "execute",
		rawInput
	};
}
function resultBlocks(intro, screens, foreground, outcome) {
	return [{
		type: "text",
		text: intro
	}, ...observationContent(screens, foreground, outcome.coordinateMode)];
}
function sessionOf(exec) {
	return exec.agent?.session;
}
function validatedPosition(exec, position) {
	const session = sessionOf(exec);
	if (coordinateModeOf(session) === "millifraction") return requireNormalizedPosition(position);
	const attached = lastAttachedRaster(session);
	if (attached === void 0) throw new Error("computer-use: pixel coordinates require an attached screenshot raster");
	return requirePixelPosition(position, attached);
}
function hidPosition(exec, position) {
	const session = sessionOf(exec);
	const mode = coordinateModeOf(session);
	return modelPositionToHid(position, mode, mode === "pixel" ? lastAttachedRaster(session) : void 0);
}
function observedFields(session, observation) {
	return {
		screens: observation.screens,
		foreground: observation.foreground,
		...coordinateOutcome(session, observation.screens)
	};
}
async function recapture(ctx, backend, exec, settleMs = 0) {
	const session = sessionOf(exec);
	const mode = coordinateModeOf(session);
	const observation = await observeDesktop(ctx, backend, exec.signal, {
		settleMs,
		coordinateMode: mode
	});
	rememberObservation(session, observation.screens);
	return {
		screens: [...observation.screens],
		foreground: compactForeground(observation.foreground),
		captures: [...observation.captures]
	};
}
/**
* Hold overlay click-through across one HID or activate call and its recapture.
* @param backend - desktop backend; Desktop wrap maps this to overlay-guard `withInput`.
* @param signal - cooperative cancellation.
* @param run - HID plus recapture.
* @returns the value `run` resolves to.
*/
function guiTurn(backend, signal, run) {
	return backend.withGuiTurn(run, signal);
}
function screenshotIntro(paths, outcome) {
	return `Saved screenshot to ${paths[0]} and copied it to the clipboard. The image is ready to paste. ${coordinatesRemain(outcome)}`;
}
function clickResultText(value) {
	const mods = value.modifiers === void 0 ? "" : `, modifiers ${value.modifiers.join(", ")}`;
	return `Clicked screen ${String(value.screenIndex)} at [${value.position.join(", ")}] (${value.button}, count ${String(value.count)}${mods}). ${coordinatesRemain(value)}`;
}
/**
* Register the exclusive GUI tools, the policy section, and first-frame screenshot attachment.
* @param ctx - registration scope; requires `tools`, `systemPrompt`, and `attachments`.
* @param backend - desktop capture and input.
* @param config - resolved tunables.
*/
function applyComputerUse(ctx, backend, config) {
	installCoordinateMode(ctx);
	ctx.systemPrompt.section({
		name: "tool:computer-use",
		order: POLICY_SECTION_ORDER,
		text: (context) => policyFor(coordinateModeOf(context.agent?.session))
	});
	ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
		const nextAssembly = await next();
		const mode = coordinateModeOf(context.agent?.session);
		if (mode === "millifraction") return nextAssembly;
		return {
			...nextAssembly,
			tools: toolsForCoordinateMode(nextAssembly.tools, mode)
		};
	});
	ctx.on("session/event", (_session, event) => {
		if (event.type !== "turn/end") return;
		const guard = ctx.get("computerUseOverlayGuard");
		if (guard === void 0) return;
		guard.setObservationFrame(null).catch(() => {});
	});
	ctx.tools.register(defineTool({
		name: "click",
		description: "Click at a 0–1000 position on the attached frontmost-window screenshot, then return the post-action screenshot. Use left (default) or right button; count 2 is a double-click. Optional modifiers (shift, cmd, option, control) are held only for this click.",
		parameters: {
			screen_index: {
				type: "integer",
				required: true,
				description: "0 for the attached frontmost-window screenshot."
			},
			position: {
				type: "array",
				required: true,
				items: { type: "number" },
				description: "[x, y] as a 0–1000 fraction of that screenshot, not pixels."
			},
			button: {
				type: "string",
				enum: ["left", "right"],
				default: "left",
				description: "Mouse button. Default: left."
			},
			count: {
				type: "integer",
				enum: [1, 2],
				default: 1,
				description: "1 for a single click, 2 for a double-click. Default: 1."
			},
			modifiers: {
				type: "array",
				items: { type: "string" },
				description: "Modifier keys held only for this click, for example [\"shift\"] or [\"cmd\"]. Omit for a plain click."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					screenIndex: {
						type: "integer",
						required: true
					},
					position: {
						type: "array",
						required: true,
						items: { type: "number" }
					},
					button: {
						type: "string",
						required: true,
						enum: ["left", "right"]
					},
					count: {
						type: "integer",
						required: true
					},
					modifiers: {
						type: "array",
						items: { type: "string" }
					},
					...COORDINATE_FIELDS,
					screens: SCREENS_FIELD,
					foreground: FOREGROUND_FIELD
				}
			},
			render: (_args, value) => resultBlocks(clickResultText(value), value.screens, value.foreground, value)
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => genericExecute("Click", {
			screen_index: args.screen_index,
			position: args.position,
			...args.modifiers !== void 0 && args.modifiers.length > 0 ? { modifiers: args.modifiers } : {}
		}),
		async execute(args, exec) {
			await assertImageCapableRoute(ctx, exec);
			const position = validatedPosition(exec, args.position);
			const button = args.button === "right" ? "right" : "left";
			const count = args.count === 2 ? 2 : 1;
			const modifiers = requireClickModifiers(args.modifiers);
			return guiTurn(backend, exec.signal, async () => {
				const screen = requireScreen(await backend.listScreens(exec.signal), args.screen_index);
				await backend.click({
					screen,
					position: hidPosition(exec, position),
					button,
					count,
					...modifiers === void 0 ? {} : { modifiers }
				}, exec.signal);
				const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
				return {
					screenIndex: args.screen_index,
					position,
					button,
					count,
					...modifiers === void 0 ? {} : { modifiers },
					...observedFields(sessionOf(exec), observation)
				};
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "input_text",
		description: "Click to focus a 0–1000 position on the attached frontmost-window screenshot, type text, optionally replace existing content and press Enter, then return the post-action screenshot.",
		parameters: {
			screen_index: {
				type: "integer",
				required: true,
				description: "0 for the attached frontmost-window screenshot."
			},
			position: {
				type: "array",
				required: true,
				items: { type: "number" },
				description: "[x, y] as a 0–1000 fraction of that screenshot, not pixels; the click focuses the field."
			},
			text: {
				type: "string",
				required: true,
				description: "Characters to type after the focus click."
			},
			replace: {
				type: "boolean",
				default: false,
				description: "When true, select all in the focused field before typing. Default: false."
			},
			submit: {
				type: "boolean",
				default: false,
				description: "When true, press Enter after typing. Default: false."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					screenIndex: {
						type: "integer",
						required: true
					},
					position: {
						type: "array",
						required: true,
						items: { type: "number" }
					},
					text: {
						type: "string",
						required: true
					},
					replace: {
						type: "boolean",
						required: true
					},
					submit: {
						type: "boolean",
						required: true
					},
					...COORDINATE_FIELDS,
					screens: SCREENS_FIELD,
					foreground: FOREGROUND_FIELD
				}
			},
			render: (_args, value) => resultBlocks(`Typed on screen ${String(value.screenIndex)} at [${value.position.join(", ")}] (replace=${String(value.replace)}, submit=${String(value.submit)}). ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => genericExecute("Type text", {
			screen_index: args.screen_index,
			text: args.text
		}),
		async execute(args, exec) {
			await assertImageCapableRoute(ctx, exec);
			const position = validatedPosition(exec, args.position);
			const replace = args.replace ?? false;
			const submit = args.submit ?? false;
			return guiTurn(backend, exec.signal, async () => {
				const screen = requireScreen(await backend.listScreens(exec.signal), args.screen_index);
				await backend.typeText({
					screen,
					position: hidPosition(exec, position),
					text: args.text,
					replace,
					submit
				}, exec.signal);
				const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
				return {
					screenIndex: args.screen_index,
					position,
					text: args.text,
					replace,
					submit,
					...observedFields(sessionOf(exec), observation)
				};
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "scroll",
		description: "Scroll up or down at a 0–1000 position on the attached frontmost-window screenshot, then return the post-action screenshot. scroll_level is 1–10.",
		parameters: {
			screen_index: {
				type: "integer",
				required: true,
				description: "0 for the attached frontmost-window screenshot."
			},
			position: {
				type: "array",
				required: true,
				items: { type: "number" },
				description: "[x, y] as a 0–1000 fraction of that screenshot, not pixels."
			},
			direction: {
				type: "string",
				required: true,
				enum: ["up", "down"],
				description: "Scroll direction."
			},
			scroll_level: {
				type: "integer",
				required: true,
				description: "Scroll magnitude from 1 (smallest) to 10 (largest)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					screenIndex: {
						type: "integer",
						required: true
					},
					position: {
						type: "array",
						required: true,
						items: { type: "number" }
					},
					direction: {
						type: "string",
						required: true,
						enum: ["up", "down"]
					},
					scrollLevel: {
						type: "integer",
						required: true
					},
					...COORDINATE_FIELDS,
					screens: SCREENS_FIELD,
					foreground: FOREGROUND_FIELD
				}
			},
			render: (_args, value) => resultBlocks(`Scrolled ${value.direction} on screen ${String(value.screenIndex)} at [${value.position.join(", ")}] (level ${String(value.scrollLevel)}). ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => genericExecute("Scroll", {
			screen_index: args.screen_index,
			direction: args.direction,
			scroll_level: args.scroll_level
		}),
		async execute(args, exec) {
			await assertImageCapableRoute(ctx, exec);
			const position = validatedPosition(exec, args.position);
			if (!Number.isInteger(args.scroll_level) || args.scroll_level < 1 || args.scroll_level > 10) throw new Error("scroll_level must be an integer from 1 to 10");
			return guiTurn(backend, exec.signal, async () => {
				const screen = requireScreen(await backend.listScreens(exec.signal), args.screen_index);
				await backend.scroll({
					screen,
					position: hidPosition(exec, position),
					direction: args.direction,
					scrollLevel: args.scroll_level
				}, exec.signal);
				const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
				return {
					screenIndex: args.screen_index,
					position,
					direction: args.direction,
					scrollLevel: args.scroll_level,
					...observedFields(sessionOf(exec), observation)
				};
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "hotkey",
		description: "Press a key combination on the desktop, then return the post-action screenshot. System screenshot shortcuts (Cmd/Win+Shift+3/4/5) are rejected.",
		parameters: { keys: {
			type: "array",
			required: true,
			items: { type: "string" },
			description: "Key names in order, for example [\"cmd\", \"c\"]."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					keys: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					...COORDINATE_FIELDS,
					screens: SCREENS_FIELD,
					foreground: FOREGROUND_FIELD
				}
			},
			render: (_args, value) => resultBlocks(`Pressed hotkey [${value.keys.join(", ")}]. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => genericExecute("Hotkey", args.keys),
		async execute(args, exec) {
			await assertImageCapableRoute(ctx, exec);
			if (args.keys.length === 0) throw new Error("keys must contain at least one key");
			assertAllowedHotkey(args.keys);
			return guiTurn(backend, exec.signal, async () => {
				await backend.hotkey({ keys: args.keys }, exec.signal);
				const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
				return {
					keys: args.keys,
					...observedFields(sessionOf(exec), observation)
				};
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "wait",
		description: "Pause 1 second, then return a fresh frontmost-window screenshot without moving the pointer. Use for page refresh, a loader, or a control that has not appeared yet. Do not use for code_agent.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					waitSeconds: {
						type: "number",
						required: true
					},
					...COORDINATE_FIELDS,
					screens: SCREENS_FIELD,
					foreground: FOREGROUND_FIELD
				}
			},
			render: (_args, value) => resultBlocks(`Waited ${String(value.waitSeconds)}s. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
		},
		isConcurrencySafe: () => false,
		presentCall: () => genericExecute("Wait", 1),
		async execute(_args, exec) {
			await assertImageCapableRoute(ctx, exec);
			await delay(1e3, exec.signal);
			const observation = await recapture(ctx, backend, exec);
			return {
				waitSeconds: 1,
				...observedFields(sessionOf(exec), observation)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "long_wait",
		description: "Pause 10, 30, 60, or 120 seconds, then return a fresh frontmost-window screenshot without moving the pointer. Only for a visible long job such as a download, installer, export, or on-screen generation. Pick the smallest wait_seconds that covers remaining progress; 120 only when the screenshot already shows a minutes-long job. Ordinary loading uses wait. Do not use for code_agent.",
		parameters: { wait_seconds: {
			type: "integer",
			required: true,
			enum: [...LONG_WAIT_SECONDS],
			description: "Seconds to pause. Must be 10, 30, 60, or 120."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					waitSeconds: {
						type: "number",
						required: true
					},
					...COORDINATE_FIELDS,
					screens: SCREENS_FIELD,
					foreground: FOREGROUND_FIELD
				}
			},
			render: (_args, value) => resultBlocks(`Waited ${String(value.waitSeconds)}s. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => genericExecute("Long wait", args.wait_seconds),
		async execute(args, exec) {
			await assertImageCapableRoute(ctx, exec);
			const waitSeconds = requireLongWaitSeconds(args.wait_seconds);
			await delay(waitSeconds * 1e3, exec.signal);
			const observation = await recapture(ctx, backend, exec);
			return {
				waitSeconds,
				...observedFields(sessionOf(exec), observation)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "screenshot",
		description: "Save the current frontmost-window screenshot to the user Desktop and copy it to the clipboard. Returns the saved file path. After bash, search, or web_fetch, call this to refresh the frontmost window. After click, type, wait, or open, do not call it again — those results already attach a window. Use when the user asked for a screenshot file or needs the image on the clipboard to paste.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					paths: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					clipboard: {
						type: "boolean",
						required: true
					},
					...COORDINATE_FIELDS,
					screens: SCREENS_FIELD,
					foreground: FOREGROUND_FIELD
				}
			},
			render: (_args, value) => resultBlocks(screenshotIntro(value.paths, value), value.screens, value.foreground, value)
		},
		isConcurrencySafe: () => false,
		presentCall: () => genericExecute("Screenshot", {}),
		async execute(_args, exec) {
			await assertImageCapableRoute(ctx, exec);
			const session = sessionOf(exec);
			const observation = await observeDesktop(ctx, backend, exec.signal, {
				coordinateMode: coordinateModeOf(session),
				persistCapture: (captured) => isUsableObservationRaster(captured.data)
			});
			const foreground = compactForeground(observation.foreground);
			if (observation.screens.length === 0) {
				if (observation.captures.length > 0) throw new Error(`computer-use: screenshot capture was unusable. Retry screenshot, wait, or open_app.\n${formatForegroundEnvelope(foreground)}`);
				throw new Error("computer-use: screenshot produced no files");
			}
			rememberObservation(session, observation.screens);
			const files = pairScreenshotFiles(observation.captures, observation.screens);
			const paths = await writeDesktopScreenshots(files, { home: homedir() });
			const first = files[0];
			const firstPath = paths[0];
			if (first === void 0 || firstPath === void 0) throw new Error("computer-use: screenshot produced no files");
			await backend.copyImageToClipboard({
				path: firstPath,
				mediaType: first.mediaType
			}, exec.signal);
			return {
				paths: [...paths],
				clipboard: true,
				...observedFields(session, {
					screens: [...observation.screens],
					foreground
				})
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "long_press",
		description: "Press and hold the left button at a 0–1000 position on the attached frontmost-window screenshot, then return the post-action screenshot. duration_seconds defaults to 3 and must be 1–10.",
		parameters: {
			screen_index: {
				type: "integer",
				required: true,
				description: "0 for the attached frontmost-window screenshot."
			},
			position: {
				type: "array",
				required: true,
				items: { type: "number" },
				description: "[x, y] as a 0–1000 fraction of that screenshot, not pixels."
			},
			duration_seconds: {
				type: "number",
				default: 3,
				description: "Hold duration in seconds. Default: 3. Must be 1–10."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					screenIndex: {
						type: "integer",
						required: true
					},
					position: {
						type: "array",
						required: true,
						items: { type: "number" }
					},
					durationSeconds: {
						type: "number",
						required: true
					},
					...COORDINATE_FIELDS,
					screens: SCREENS_FIELD,
					foreground: FOREGROUND_FIELD
				}
			},
			render: (_args, value) => resultBlocks(`Long-pressed screen ${String(value.screenIndex)} at [${value.position.join(", ")}] for ${String(value.durationSeconds)}s. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => genericExecute("Long press", {
			screen_index: args.screen_index,
			position: args.position,
			duration_seconds: args.duration_seconds ?? 3
		}),
		async execute(args, exec) {
			await assertImageCapableRoute(ctx, exec);
			const position = validatedPosition(exec, args.position);
			const durationSeconds = requireLongPressDuration(args.duration_seconds);
			return guiTurn(backend, exec.signal, async () => {
				const screen = requireScreen(await backend.listScreens(exec.signal), args.screen_index);
				await backend.longPress({
					screen,
					position: hidPosition(exec, position),
					durationSeconds
				}, exec.signal);
				const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
				return {
					screenIndex: args.screen_index,
					position,
					durationSeconds,
					...observedFields(sessionOf(exec), observation)
				};
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "drag",
		description: "Drag from a start 0–1000 position to an end 0–1000 position on the attached frontmost-window screenshot, then return the post-action screenshot.",
		parameters: {
			start_screen_index: {
				type: "integer",
				required: true,
				description: "0 for the attached frontmost-window screenshot."
			},
			start_position: {
				type: "array",
				required: true,
				items: { type: "number" },
				description: "[x, y] start as a 0–1000 fraction of that screenshot, not pixels."
			},
			end_screen_index: {
				type: "integer",
				required: true,
				description: "0 for the attached frontmost-window screenshot."
			},
			end_position: {
				type: "array",
				required: true,
				items: { type: "number" },
				description: "[x, y] end as a 0–1000 fraction of that screenshot, not pixels."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					startScreenIndex: {
						type: "integer",
						required: true
					},
					startPosition: {
						type: "array",
						required: true,
						items: { type: "number" }
					},
					endScreenIndex: {
						type: "integer",
						required: true
					},
					endPosition: {
						type: "array",
						required: true,
						items: { type: "number" }
					},
					...COORDINATE_FIELDS,
					screens: SCREENS_FIELD,
					foreground: FOREGROUND_FIELD
				}
			},
			render: (_args, value) => resultBlocks(`Dragged from screen ${String(value.startScreenIndex)} [${value.startPosition.join(", ")}] to screen ${String(value.endScreenIndex)} [${value.endPosition.join(", ")}]. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => genericExecute("Drag", {
			start_screen_index: args.start_screen_index,
			end_screen_index: args.end_screen_index
		}),
		async execute(args, exec) {
			await assertImageCapableRoute(ctx, exec);
			const startPosition = validatedPosition(exec, args.start_position);
			const endPosition = validatedPosition(exec, args.end_position);
			return guiTurn(backend, exec.signal, async () => {
				const screens = await backend.listScreens(exec.signal);
				const startScreen = requireScreen(screens, args.start_screen_index);
				const endScreen = requireScreen(screens, args.end_screen_index);
				await backend.drag({
					startScreen,
					startPosition: hidPosition(exec, startPosition),
					endScreen,
					endPosition: hidPosition(exec, endPosition)
				}, exec.signal);
				const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
				return {
					startScreenIndex: args.start_screen_index,
					startPosition,
					endScreenIndex: args.end_screen_index,
					endPosition,
					...observedFields(sessionOf(exec), observation)
				};
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "open_in_browser",
		description: "Open the default browser, or a full http(s) URL in it, then return the post-action screenshot. This is the user-visible browser. Do not use web_fetch as a substitute. Chinese in path or query must be plain text, never CJK percent-encoding such as %E5... / %E8....",
		parameters: { url: {
			type: "string",
			description: "http(s) URL to open. Omit to launch the default browser with no page."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					url: { type: "string" },
					...COORDINATE_FIELDS,
					screens: SCREENS_FIELD,
					foreground: FOREGROUND_FIELD
				}
			},
			render: (_args, value) => resultBlocks(value.url === void 0 ? `Opened the default browser. ${coordinatesRemain(value)}` : `Opened ${value.url} in the default browser. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => genericExecute("Open in browser", args.url === void 0 ? {} : { url: args.url }),
		async execute(args, exec) {
			await assertImageCapableRoute(ctx, exec);
			const url = args.url === void 0 || args.url.trim() === "" ? void 0 : requireBrowserUrl(args.url);
			await backend.openInBrowser(url === void 0 ? {} : { url }, exec.signal);
			const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
			return {
				...url === void 0 ? {} : { url },
				...observedFields(sessionOf(exec), observation)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "open_in_finder",
		description: "Open a folder in Finder, open a file with its default app, or reveal a file in Finder, then return the post-action screenshot. Omit path to open the Desktop. Use reveal_only only to select a file in Finder (Open With or rename/move). Pass a real path; do not OCR one from the screenshot.",
		parameters: {
			path: {
				type: "string",
				description: "Absolute or ~ path. Omit to open the user Desktop."
			},
			reveal_only: {
				type: "boolean",
				default: false,
				description: "When true and path is a file, reveal it in Finder instead of opening it. Default: false."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true
					},
					revealOnly: {
						type: "boolean",
						required: true
					},
					...COORDINATE_FIELDS,
					screens: SCREENS_FIELD,
					foreground: FOREGROUND_FIELD
				}
			},
			render: (_args, value) => resultBlocks(value.revealOnly ? `Revealed ${value.path} in Finder. ${coordinatesRemain(value)}` : `Opened ${value.path}. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => genericExecute("Open in Finder", {
			...args.path === void 0 ? {} : { path: args.path },
			reveal_only: args.reveal_only ?? false
		}),
		async execute(args, exec) {
			await assertImageCapableRoute(ctx, exec);
			const requestedReveal = args.reveal_only ?? false;
			const target = await resolveFinderOpen(args.path, requestedReveal);
			const info = await stat(target.path);
			const revealOnly = target.revealOnly && info.isFile();
			await backend.openInFinder({
				path: target.path,
				revealOnly
			}, exec.signal);
			const observation = await recapture(ctx, backend, exec, config.postActionWaitMs);
			return {
				path: target.path,
				revealOnly,
				...observedFields(sessionOf(exec), observation)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "list_apps",
		description: "List running regular (Dock-visible) applications by display name, then return the current frontmost-window screenshot. Use this when the attached window is the wrong app.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					apps: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					...COORDINATE_FIELDS,
					screens: SCREENS_FIELD,
					foreground: FOREGROUND_FIELD
				}
			},
			render: (_args, value) => resultBlocks(value.apps.length === 0 ? `No running regular applications. ${coordinatesRemain(value)}` : `Running apps: ${value.apps.join(", ")}. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
		},
		isConcurrencySafe: () => false,
		presentCall: () => genericExecute("List apps", {}),
		async execute(_args, exec) {
			await assertImageCapableRoute(ctx, exec);
			const apps = await backend.listApps(exec.signal);
			const observation = await recapture(ctx, backend, exec);
			return {
				apps: [...apps],
				...observedFields(sessionOf(exec), observation)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "open_app",
		description: "Activate a running application or launch it by display name or bundle id, then return the post-action screenshot. Use this when the attached window is the wrong app. Do not click the Dock.",
		parameters: { name: {
			type: "string",
			required: true,
			description: "Localized application name or bundle identifier, for example Pages or com.apple.TextEdit."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					name: {
						type: "string",
						required: true
					},
					ok: {
						type: "boolean",
						required: true
					},
					action: {
						type: "string",
						enum: ["activated", "launched"]
					},
					error: { type: "string" },
					...COORDINATE_FIELDS,
					screens: SCREENS_FIELD,
					foreground: FOREGROUND_FIELD
				}
			},
			render: (_args, value) => resultBlocks(value.ok ? `Opened ${value.name} (${value.action ?? "activated"}). ${coordinatesRemain(value)}` : `Could not open ${value.name}: ${value.error ?? "unknown error"}. ${coordinatesRemain(value)}`, value.screens, value.foreground, value)
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => genericExecute("Open app", { name: args.name }),
		async execute(args, exec) {
			await assertImageCapableRoute(ctx, exec);
			const name = args.name.trim();
			if (name === "") throw new Error("name must be a non-empty application name or bundle id");
			return guiTurn(backend, exec.signal, async () => {
				let action;
				let error;
				let settleMs = 0;
				try {
					action = (await backend.openApp({ name }, exec.signal)).kind;
					settleMs = config.postActionWaitMs;
				} catch (caught) {
					if (exec.signal.aborted || caught instanceof Error && caught.name === "AbortError") throw caught;
					error = caught instanceof Error ? caught.message : String(caught);
				}
				const observation = await recapture(ctx, backend, exec, settleMs);
				return {
					name,
					ok: error === void 0,
					...action === void 0 ? {} : { action },
					...error === void 0 ? {} : { error },
					...observedFields(sessionOf(exec), observation)
				};
			});
		}
	}));
	ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || decision.messages.length === 0) return decision;
		if (isDesktopSelectionTurn(messages)) return decision;
		if (!messages.some((message) => message.source.kind === "user")) return decision;
		if (!await routeAcceptsImages(ctx, agent, signal)) return decision;
		signal.throwIfAborted();
		const mode = coordinateModeOf(agent.session);
		const observation = await observeDesktop(ctx, backend, signal, { coordinateMode: mode });
		rememberObservation(agent.session, observation.screens);
		signal.throwIfAborted();
		const notice = createUserMessage({
			content: [{
				type: "text",
				text: firstFrameNotice(mode)
			}, ...observation.blocks],
			source: {
				kind: "computer-use",
				form: "notice",
				summary: "Frontmost window attached"
			}
		});
		return {
			...decision,
			messages: [...decision.messages, notice]
		};
	});
}
//#endregion
//#region lib/types/fake.js
/**
* In-memory desktop used by tests and keyless snapshots. Never drives a real GUI.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/fake
*/
/** 1×1 red PNG used as the fixture desktop image. */
const FAKE_DESKTOP_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAEElEQVR4nGP4z8AAQQxYWACPjgj4kWPEuQAAAABJRU5ErkJggg==", "base64");
const DEFAULT_SCREENS = [{
	index: 0,
	bounds: {
		x: 0,
		y: 0,
		width: 1e3,
		height: 800
	},
	scale: 2,
	windowId: 1
}];
const DEFAULT_APPS = ["Pages", "Safari"];
/**
* Construct a fake desktop that records actions and returns a fixture PNG.
* @param options - optional screens, PNG bytes, and foreground metadata.
* @returns a test/snapshot backend.
*/
function createFakeDesktopBackend(options = {}) {
	const png = options.png ?? FAKE_DESKTOP_PNG;
	const screens = options.screens ?? DEFAULT_SCREENS;
	const foreground = options.foreground ?? { appName: "Pages" };
	const apps = options.apps ?? DEFAULT_APPS;
	const actions = [];
	const captured = {
		data: png,
		mediaType: "image/png"
	};
	return {
		get actions() {
			return actions;
		},
		listScreens: () => Promise.resolve(screens),
		capture: () => Promise.resolve(captured),
		inspectForeground: () => Promise.resolve(foreground),
		listApps: () => Promise.resolve(apps),
		openApp: (input) => {
			actions.push({
				type: "openApp",
				input
			});
			if (options.openAppError !== void 0) return Promise.reject(options.openAppError);
			return Promise.resolve(options.openAppResult ?? {
				kind: "activated",
				name: input.name
			});
		},
		click: (input) => {
			actions.push({
				type: "click",
				input
			});
			return Promise.resolve();
		},
		typeText: (input) => {
			actions.push({
				type: "typeText",
				input
			});
			return Promise.resolve();
		},
		scroll: (input) => {
			actions.push({
				type: "scroll",
				input
			});
			return Promise.resolve();
		},
		hotkey: (input) => {
			actions.push({
				type: "hotkey",
				input
			});
			return Promise.resolve();
		},
		longPress: (input) => {
			actions.push({
				type: "longPress",
				input
			});
			return Promise.resolve();
		},
		drag: (input) => {
			actions.push({
				type: "drag",
				input
			});
			return Promise.resolve();
		},
		openInBrowser: (input) => {
			actions.push({
				type: "openInBrowser",
				input
			});
			return Promise.resolve();
		},
		openInFinder: (input) => {
			actions.push({
				type: "openInFinder",
				input
			});
			return Promise.resolve();
		},
		copyImageToClipboard: (input) => {
			actions.push({
				type: "copyImageToClipboard",
				input
			});
			return Promise.resolve();
		},
		withGuiTurn: (run) => run()
	};
}
//#endregion
//#region lib/types/index.js
/**
* Experimental Computer Use plugin: exclusive GUI tools plus a first-turn screenshot.
* Observation rides existing `user/message` and `tool/result` events; `screenshot` writes Desktop files and the clipboard.
* @module @deepseek-ai/dsh-experimental-tool-computer-use
*/
/** Cordis plugin name. */
const name = PLUGIN_NAME;
/** Services required at apply time. Missing attachments keep the plugin pending. */
const inject = [
	"tools",
	"systemPrompt",
	"attachments"
];
/**
* Resolve the overlay cloak when a desktop method runs.
* Desktop Host installs `computerUseOverlayGuard` after profile plugins apply, so a one-time read during `apply` stays empty.
* @param ctx - plugin context that may later provide `computerUseOverlayGuard`.
* @param inner - platform backend. Its overlay-exclude capture also reads the guard at call time.
* @returns a backend that cloaks only while the guard service is present.
*/
function desktopBackend(ctx, inner) {
	const resolve = () => {
		const guard = ctx.get("computerUseOverlayGuard");
		return guard === void 0 ? inner : wrapDesktopBackend(inner, guard);
	};
	return {
		withGuiTurn: (run, signal) => resolve().withGuiTurn(run, signal),
		listScreens: (signal) => resolve().listScreens(signal),
		capture: (screen, signal) => resolve().capture(screen, signal),
		inspectForeground: (signal) => resolve().inspectForeground(signal),
		listApps: (signal) => resolve().listApps(signal),
		openApp: (input, signal) => resolve().openApp(input, signal),
		click: (input, signal) => resolve().click(input, signal),
		typeText: (input, signal) => resolve().typeText(input, signal),
		scroll: (input, signal) => resolve().scroll(input, signal),
		hotkey: (input, signal) => resolve().hotkey(input, signal),
		longPress: (input, signal) => resolve().longPress(input, signal),
		drag: (input, signal) => resolve().drag(input, signal),
		openInBrowser: (input, signal) => resolve().openInBrowser(input, signal),
		openInFinder: (input, signal) => resolve().openInFinder(input, signal),
		copyImageToClipboard: (input, signal) => resolve().copyImageToClipboard(input, signal)
	};
}
/**
* Mount Computer Use with the host-platform backend.
* When Desktop Host provides `computerUseOverlayGuard`, capture, inspect, listScreens, HID, and withGuiTurn run
* inside overlay-guard intervals, `listScreens` waits for the observation-frame ribbon ack, and overlay-exclude
* capture runs ScreenCaptureKit in the Electron process.
* The guard is read on each desktop call, including when Host installs it after this plugin applies.
* @param ctx - registration scope; `inject` must already be satisfied.
* @param config - optional tunables; omitted fields use schema defaults.
*/
function apply(ctx, config = {}) {
	const excludedRegionCapture = (input) => {
		const capture = ctx.get("computerUseOverlayGuard")?.captureExcludedRegion;
		if (capture === void 0) return Promise.reject(/* @__PURE__ */ new Error("dsh desktop: overlay-exclude capture is not attached"));
		const { signal, ...region } = input;
		return capture(region, signal);
	};
	applyComputerUse(ctx, desktopBackend(ctx, createPlatformBackend(process.platform, excludedRegionCapture)), resolveComputerUseConfig(config));
}
//#endregion
export { Config, FAKE_DESKTOP_PNG, FOCUS_FALLBACK_FOREGROUND, FOCUS_NOTE, PLUGIN_NAME, POLICY, POLICY_SECTION_ORDER, UNFOCUSED_WINDOW_NOTE, apply, applyComputerUse, createFakeDesktopBackend, createPlatformBackend, inject, name, resolveComputerUseConfig, wrapDesktopBackend };
