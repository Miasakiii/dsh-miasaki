import { a as encodeBgraPng } from "./backend-DNT4VCU7.js";
import { execFileSync } from "node:child_process";
import koffi from "koffi";
//#region lib/types/windows-native.js
/**
* Win32 capture and input used by {@link createWindowsDesktopBackend}.
* Loaded only on Windows, and only when a method runs without injected operations.
* Each coordinate-bearing call sets this thread to per-monitor DPI awareness so
* window rectangles, `BitBlt`, and `SendInput` share physical pixels, then restores
* the previous awareness. `.agents/notes/implemented/architecture/2026-09-23-windows-computer-use-per-monitor-dpi.md`
* owns that decision.
* @module @deepseek-ai/dsh-experimental-tool-computer-use/src/windows-native
*/
const SRCCOPY = 13369376;
const MOUSEEVENTF_LEFTDOWN = 2;
const MOUSEEVENTF_LEFTUP = 4;
const MOUSEEVENTF_RIGHTDOWN = 8;
const MOUSEEVENTF_RIGHTUP = 16;
const MOUSEEVENTF_WHEEL = 2048;
const MOUSEEVENTF_ABSOLUTE = 32768;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_EXTENDEDKEY = 1;
const KEYEVENTF_KEYUP = 2;
const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 2;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const PROCESS_QUERY_LIMITED_INFORMATION = 4096;
const TOKEN_QUERY = 8;
const TokenIntegrityLevel = 25;
const SW_SHOWNORMAL = 1;
const SW_RESTORE = 9;
const GW_OWNER = 4;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_POPUP = 2147483648;
const WS_EX_TOOLWINDOW = 128;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const MONITOR_DEFAULTTONEAREST = 2;
const MDT_EFFECTIVE_DPI = 0;
const VK_MENU = 18;
/** Per-monitor v2, then per-monitor. `SetThreadDpiAwarenessContext` returns NULL when the context is unsupported. */
const DPI_PER_MONITOR_V2 = -4;
const DPI_PER_MONITOR = -3;
const FOREGROUND_RETRY_MS = 50;
koffi.struct("DSH_CU_RECT", {
	left: "int32",
	top: "int32",
	right: "int32",
	bottom: "int32"
});
koffi.struct("DSH_CU_POINT", {
	x: "int32",
	y: "int32"
});
koffi.struct("DSH_CU_BITMAPINFOHEADER", {
	biSize: "uint32",
	biWidth: "int32",
	biHeight: "int32",
	biPlanes: "uint16",
	biBitCount: "uint16",
	biCompression: "uint32",
	biSizeImage: "uint32",
	biXPelsPerMeter: "int32",
	biYPelsPerMeter: "int32",
	biClrUsed: "uint32",
	biClrImportant: "uint32"
});
const MOUSEINPUT = koffi.struct("DSH_CU_MOUSEINPUT", {
	dx: "int32",
	dy: "int32",
	mouseData: "uint32",
	dwFlags: "uint32",
	time: "uint32",
	dwExtraInfo: "uintptr"
});
const KEYBDINPUT = koffi.struct("DSH_CU_KEYBDINPUT", {
	wVk: "uint16",
	wScan: "uint16",
	dwFlags: "uint32",
	time: "uint32",
	dwExtraInfo: "uintptr"
});
const INPUT_UNION = koffi.union("DSH_CU_INPUT_UNION", {
	mi: MOUSEINPUT,
	ki: KEYBDINPUT
});
const INPUT = koffi.struct("DSH_CU_INPUT", {
	type: "uint32",
	u: INPUT_UNION
});
function isNull(value) {
	return value === null || value === void 0 || value === 0 || value === 0n;
}
function dpiContext(value) {
	if (typeof value === "bigint") return value === 0n ? void 0 : value;
	if (typeof value === "number" && value !== 0) return value;
}
function hwndId(value) {
	const id = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : NaN;
	if (!Number.isSafeInteger(id) || id === 0) return void 0;
	return id;
}
function low32(value) {
	if (typeof value === "bigint") return Number(BigInt.asIntN(32, value));
	if (typeof value === "number" && Number.isFinite(value)) return value | 0;
	return 0;
}
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function bind(libraries) {
	const { user32, gdi32, kernel32, shell32, advapi32, dwmapi } = libraries;
	const enumProc = koffi.proto("int __stdcall DshCuEnumWindowsProc(void *hwnd, intptr lParam)");
	const childProc = koffi.proto("int __stdcall DshCuEnumChildProc(void *hwnd, intptr lParam)");
	let setThreadDpi;
	try {
		setThreadDpi = user32.func("intptr __stdcall SetThreadDpiAwarenessContext(intptr dpiContext)");
	} catch {
		setThreadDpi = void 0;
	}
	let getDpiForMonitor;
	try {
		getDpiForMonitor = koffi.load("shcore.dll").func("int __stdcall GetDpiForMonitor(void *hmonitor, int dpiType, _Out_ uint32 *dpiX, _Out_ uint32 *dpiY)");
	} catch {
		getDpiForMonitor = void 0;
	}
	return {
		GetForegroundWindow: user32.func("void * __stdcall GetForegroundWindow()"),
		GetWindowRect: user32.func("int __stdcall GetWindowRect(void *hWnd, _Out_ DSH_CU_RECT *lpRect)"),
		GetWindowTextLengthW: user32.func("int __stdcall GetWindowTextLengthW(void *hWnd)"),
		GetWindowTextW: user32.func("int __stdcall GetWindowTextW(void *hWnd, uint16_t *lpString, int nMaxCount)"),
		GetWindowThreadProcessId: user32.func("uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)"),
		IsWindowVisible: user32.func("int __stdcall IsWindowVisible(void *hWnd)"),
		IsIconic: user32.func("int __stdcall IsIconic(void *hWnd)"),
		EnumWindows: user32.func("int __stdcall EnumWindows(DshCuEnumWindowsProc *lpEnumFunc, intptr lParam)"),
		EnumChildWindows: user32.func("int __stdcall EnumChildWindows(void *hWndParent, DshCuEnumChildProc *lpEnumFunc, intptr lParam)"),
		GetClassNameW: user32.func("int __stdcall GetClassNameW(void *hWnd, uint16_t *lpClassName, int nMaxCount)"),
		GetWindow: user32.func("void * __stdcall GetWindow(void *hWnd, uint32 uCmd)"),
		GetWindowLongPtrW: user32.func("intptr __stdcall GetWindowLongPtrW(void *hWnd, int nIndex)"),
		ShowWindow: user32.func("int __stdcall ShowWindow(void *hWnd, int nCmdShow)"),
		SetForegroundWindow: user32.func("int __stdcall SetForegroundWindow(void *hWnd)"),
		MonitorFromWindow: user32.func("void * __stdcall MonitorFromWindow(void *hwnd, uint32 dwFlags)"),
		GetMonitorInfoW: user32.func("int __stdcall GetMonitorInfoW(void *hMonitor, _Inout_ uint8_t *lpmi)"),
		GetSystemMetrics: user32.func("int __stdcall GetSystemMetrics(int nIndex)"),
		GetCursorPos: user32.func("int __stdcall GetCursorPos(_Out_ DSH_CU_POINT *lpPoint)"),
		SetCursorPos: user32.func("int __stdcall SetCursorPos(int X, int Y)"),
		SetThreadDpiAwarenessContext: setThreadDpi,
		GetDpiForMonitor: getDpiForMonitor,
		GetDC: user32.func("void * __stdcall GetDC(void *hWnd)"),
		ReleaseDC: user32.func("int __stdcall ReleaseDC(void *hWnd, void *hDC)"),
		CreateCompatibleDC: gdi32.func("void * __stdcall CreateCompatibleDC(void *hdc)"),
		CreateCompatibleBitmap: gdi32.func("void * __stdcall CreateCompatibleBitmap(void *hdc, int cx, int cy)"),
		SelectObject: gdi32.func("void * __stdcall SelectObject(void *hdc, void *h)"),
		BitBlt: gdi32.func("int __stdcall BitBlt(void *hdc, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32 rop)"),
		GetDIBits: gdi32.func("int __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 cLines, _Out_ uint8_t *lpvBits, _Inout_ DSH_CU_BITMAPINFOHEADER *lpbmi, uint32 usage)"),
		DeleteObject: gdi32.func("int __stdcall DeleteObject(void *ho)"),
		DeleteDC: gdi32.func("int __stdcall DeleteDC(void *hdc)"),
		SendInput: user32.func("uint32 __stdcall SendInput(uint32 cInputs, DSH_CU_INPUT *pInputs, int cbSize)"),
		OpenClipboard: user32.func("int __stdcall OpenClipboard(void *hWndNewOwner)"),
		EmptyClipboard: user32.func("int __stdcall EmptyClipboard()"),
		SetClipboardData: user32.func("void * __stdcall SetClipboardData(uint32 uFormat, void *hMem)"),
		CloseClipboard: user32.func("int __stdcall CloseClipboard()"),
		GetClipboardData: user32.func("void * __stdcall GetClipboardData(uint32 uFormat)"),
		GlobalAlloc: kernel32.func("void * __stdcall GlobalAlloc(uint32 uFlags, uintptr dwBytes)"),
		GlobalLock: kernel32.func("void * __stdcall GlobalLock(void *hMem)"),
		GlobalUnlock: kernel32.func("int __stdcall GlobalUnlock(void *hMem)"),
		GlobalSize: kernel32.func("uintptr __stdcall GlobalSize(void *hMem)"),
		RtlMoveMemory: kernel32.func("void __stdcall RtlMoveMemory(void *Destination, void *Source, uintptr Length)"),
		OpenProcess: kernel32.func("void * __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)"),
		CloseHandle: kernel32.func("int __stdcall CloseHandle(void *hObject)"),
		QueryFullProcessImageNameW: kernel32.func("int __stdcall QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, uint16_t *lpExeName, _Inout_ uint32 *lpdwSize)"),
		OpenProcessToken: advapi32.func("int __stdcall OpenProcessToken(void *ProcessHandle, uint32 DesiredAccess, _Out_ void **TokenHandle)"),
		GetTokenInformation: advapi32.func("int __stdcall GetTokenInformation(void *TokenHandle, int TokenInformationClass, _Out_ uint8_t *TokenInformation, uint32 TokenInformationLength, _Out_ uint32 *ReturnLength)"),
		GetSidSubAuthorityCount: advapi32.func("uint8_t * __stdcall GetSidSubAuthorityCount(void *pSid)"),
		GetSidSubAuthority: advapi32.func("uint32 * __stdcall GetSidSubAuthority(void *pSid, uint32 nSubAuthority)"),
		ShellExecuteW: shell32.func("intptr __stdcall ShellExecuteW(void *hwnd, str16 lpOperation, str16 lpFile, str16 lpParameters, str16 lpDirectory, int nShowCmd)"),
		DwmGetWindowAttribute: dwmapi.func("int __stdcall DwmGetWindowAttribute(void *hwnd, uint32 dwAttribute, _Out_ uint8_t *pvAttribute, uint32 cbAttribute)"),
		enumProc,
		childProc
	};
}
function windowText(api, hwnd) {
	const length = api.GetWindowTextLengthW(hwnd);
	if (length <= 0) return "";
	const buffer = Buffer.alloc((length + 1) * 2);
	api.GetWindowTextW(hwnd, buffer, length + 1);
	return buffer.toString("utf16le", 0, length * 2);
}
function classNameOf(api, hwnd) {
	const buffer = Buffer.alloc(512);
	const length = api.GetClassNameW(hwnd, buffer, 256);
	if (length <= 0) return "";
	return buffer.toString("utf16le", 0, length * 2);
}
function pidOf(api, hwnd) {
	const pid = [0];
	api.GetWindowThreadProcessId(hwnd, pid);
	return pid[0] ?? 0;
}
function processBaseName(api, pid) {
	if (pid === 0) return void 0;
	const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
	if (isNull(handle)) return void 0;
	try {
		const chars = Buffer.alloc(2048);
		const size = [1024];
		if (api.QueryFullProcessImageNameW(handle, 0, chars, size) === 0) return void 0;
		const count = size[0] ?? 0;
		const full = chars.toString("utf16le", 0, count * 2);
		return (full.split(/[\\/]/u).at(-1) ?? full).replace(/\.exe$/iu, "");
	} finally {
		api.CloseHandle(handle);
	}
}
function integrityRid(api, pid) {
	try {
		return integrityRidUnchecked(api, pid);
	} catch {
		return;
	}
}
function integrityRidUnchecked(api, pid) {
	const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
	if (isNull(handle)) return void 0;
	const token = [null];
	try {
		if (api.OpenProcessToken(handle, TOKEN_QUERY, token) === 0) return void 0;
		const tokenHandle = token[0];
		try {
			const needed = [0];
			api.GetTokenInformation(tokenHandle, TokenIntegrityLevel, null, 0, needed);
			const size = needed[0] ?? 0;
			if (size < 8) return void 0;
			const info = Buffer.alloc(size);
			if (api.GetTokenInformation(tokenHandle, TokenIntegrityLevel, info, size, needed) === 0) return void 0;
			const sid = info.readBigUInt64LE(0);
			const countPtr = api.GetSidSubAuthorityCount(sid);
			const count = koffi.decode(countPtr, "uint8");
			if (count < 1) return void 0;
			const ridPtr = api.GetSidSubAuthority(sid, count - 1);
			return koffi.decode(ridPtr, "uint32");
		} finally {
			api.CloseHandle(tokenHandle);
		}
	} finally {
		api.CloseHandle(handle);
	}
}
function explorerFolder(hwnd) {
	const script = `
$shell = New-Object -ComObject Shell.Application
foreach ($window in @($shell.Windows())) {
  if ([int64]$window.HWND -eq ${String(hwnd)}) {
    $window.Document.Folder.Self.Path
    break
  }
}
`;
	try {
		const path = execFileSync("powershell.exe", [
			"-NoProfile",
			"-Command",
			script
		], {
			encoding: "utf8",
			windowsHide: true,
			timeout: 2e3
		}).trim();
		return path === "" ? void 0 : path;
	} catch {
		return;
	}
}
function sendMouse(api, flags, x, y, data = 0) {
	const absolute = (flags & MOUSEEVENTF_ABSOLUTE) !== 0;
	const left = api.GetSystemMetrics(SM_XVIRTUALSCREEN);
	const top = api.GetSystemMetrics(SM_YVIRTUALSCREEN);
	const width = Math.max(1, api.GetSystemMetrics(SM_CXVIRTUALSCREEN));
	const height = Math.max(1, api.GetSystemMetrics(SM_CYVIRTUALSCREEN));
	const input = {
		type: INPUT_MOUSE,
		u: { mi: {
			dx: absolute ? Math.round((x - left) * 65535 / Math.max(1, width - 1)) : x,
			dy: absolute ? Math.round((y - top) * 65535 / Math.max(1, height - 1)) : y,
			mouseData: data >>> 0,
			dwFlags: flags,
			time: 0,
			dwExtraInfo: 0
		} }
	};
	if (api.SendInput(1, [input], INPUT.size) !== 1) throw new Error("computer-use: pointer input failed");
}
function postKey(api, virtualKey, down, extended) {
	const input = {
		type: INPUT_KEYBOARD,
		u: { ki: {
			wVk: virtualKey,
			wScan: 0,
			dwFlags: (down ? 0 : KEYEVENTF_KEYUP) | (extended ? KEYEVENTF_EXTENDEDKEY : 0),
			time: 0,
			dwExtraInfo: 0
		} }
	};
	if (api.SendInput(1, [input], INPUT.size) !== 1) throw new Error("computer-use: keyboard input failed");
}
function withClipboard(api, write) {
	if (api.OpenClipboard(null) === 0) throw new Error("computer-use: OpenClipboard failed");
	try {
		write();
	} finally {
		api.CloseClipboard();
	}
}
function enumTopLevel(api) {
	const hwnds = [];
	const callback = koffi.register((hwnd) => {
		hwnds.push(hwnd);
		return 1;
	}, koffi.pointer(api.enumProc));
	try {
		api.EnumWindows(callback, 0);
	} finally {
		koffi.unregister(callback);
	}
	return hwnds;
}
function coreWindowPid(api, hwnd) {
	let found = 0;
	const callback = koffi.register((child) => {
		if (classNameOf(api, child) !== "Windows.UI.Core.CoreWindow") return 1;
		found = pidOf(api, child);
		return 0;
	}, koffi.pointer(api.childProc));
	try {
		api.EnumChildWindows(hwnd, callback, 0);
	} finally {
		koffi.unregister(callback);
	}
	return found === 0 ? void 0 : found;
}
function frameOf(api, hwnd) {
	const extended = Buffer.alloc(16);
	if (api.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, extended, 16) === 0) {
		const left = extended.readInt32LE(0);
		const top = extended.readInt32LE(4);
		const right = extended.readInt32LE(8);
		const bottom = extended.readInt32LE(12);
		return {
			x: left,
			y: top,
			width: right - left,
			height: bottom - top
		};
	}
	const rect = {
		left: 0,
		top: 0,
		right: 0,
		bottom: 0
	};
	if (api.GetWindowRect(hwnd, rect) === 0) return void 0;
	return {
		x: rect.left,
		y: rect.top,
		width: rect.right - rect.left,
		height: rect.bottom - rect.top
	};
}
function cloaked(api, hwnd) {
	const flag = Buffer.alloc(4);
	if (api.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, flag, 4) !== 0) return false;
	return flag.readUInt32LE(0) !== 0;
}
function monitorOf(api, hwnd, fallback) {
	const handle = api.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
	if (isNull(handle)) return {
		monitor: fallback,
		dpi: 96
	};
	const info = Buffer.alloc(40);
	info.writeUInt32LE(40, 0);
	if (api.GetMonitorInfoW(handle, info) === 0) return {
		monitor: fallback,
		dpi: 96
	};
	const left = info.readInt32LE(4);
	const top = info.readInt32LE(8);
	const right = info.readInt32LE(12);
	const bottom = info.readInt32LE(16);
	const monitor = {
		x: left,
		y: top,
		width: right - left,
		height: bottom - top
	};
	const readDpi = api.GetDpiForMonitor;
	if (readDpi === void 0) return {
		monitor,
		dpi: 96
	};
	const dpiX = [0];
	if (readDpi(handle, MDT_EFFECTIVE_DPI, dpiX, [0]) !== 0) return {
		monitor,
		dpi: 96
	};
	const dpi = dpiX[0] ?? 0;
	return {
		monitor,
		dpi: dpi > 0 ? dpi : 96
	};
}
function stylesOf(api, hwnd) {
	const style = low32(api.GetWindowLongPtrW(hwnd, GWL_STYLE));
	const extended = low32(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
	return {
		popup: (style & WS_POPUP) !== 0,
		toolWindow: (extended & WS_EX_TOOLWINDOW) !== 0
	};
}
function cachedAppName(api, cache, pid) {
	const cached = cache.get(pid);
	if (cached !== void 0) return cached;
	const name = processBaseName(api, pid) ?? "unknown";
	cache.set(pid, name);
	return name;
}
/**
* Win32 operations for the production Windows backend.
* @returns operations that capture and post input on this machine.
*/
function createProductionWindowsOps() {
	if (process.arch === "x64" && INPUT.size !== 40) throw new Error(`computer-use: INPUT size ${String(INPUT.size)} is not 40`);
	const api = bind({
		user32: koffi.load("user32.dll"),
		gdi32: koffi.load("gdi32.dll"),
		kernel32: koffi.load("kernel32.dll"),
		shell32: koffi.load("shell32.dll"),
		advapi32: koffi.load("advapi32.dll"),
		dwmapi: koffi.load("dwmapi.dll")
	});
	const selfRid = integrityRid(api, process.pid);
	function perMonitor(fn) {
		const set = api.SetThreadDpiAwarenessContext;
		if (set === void 0) return fn();
		const restore = dpiContext(set(DPI_PER_MONITOR_V2)) ?? dpiContext(set(DPI_PER_MONITOR));
		if (restore === void 0) return fn();
		try {
			return fn();
		} finally {
			set(restore);
		}
	}
	function placePointer(x, y) {
		sendMouse(api, 49153, x, y);
		const pos = {
			x: 0,
			y: 0
		};
		if (api.GetCursorPos(pos) === 0 || pos.x !== x || pos.y !== y) {
			if (api.SetCursorPos(x, y) === 0) throw new Error("computer-use: pointer input failed");
		}
	}
	function listWindows() {
		return perMonitor(() => {
			const names = /* @__PURE__ */ new Map();
			const windows = [];
			for (const hwnd of enumTopLevel(api)) {
				const id = hwndId(hwnd);
				if (id === void 0) continue;
				const frame = frameOf(api, hwnd);
				if (frame === void 0) continue;
				const className = classNameOf(api, hwnd);
				const pid = pidOf(api, hwnd);
				const appPid = className === "ApplicationFrameWindow" ? coreWindowPid(api, hwnd) ?? pid : pid;
				const styles = stylesOf(api, hwnd);
				const display = monitorOf(api, hwnd, frame);
				windows.push({
					hwnd: id,
					pid: appPid,
					ownerHwnd: hwndId(api.GetWindow(hwnd, GW_OWNER)) ?? 0,
					className,
					appName: cachedAppName(api, names, appPid),
					title: windowText(api, hwnd),
					visible: api.IsWindowVisible(hwnd) !== 0,
					iconic: api.IsIconic(hwnd) !== 0,
					cloaked: cloaked(api, hwnd),
					toolWindow: styles.toolWindow,
					popup: styles.popup,
					frame,
					monitor: display.monitor,
					monitorDpi: display.dpi
				});
			}
			return {
				foregroundHwnd: hwndId(api.GetForegroundWindow()) ?? 0,
				windows
			};
		});
	}
	function isForeground(hwnd) {
		return hwndId(api.GetForegroundWindow()) === hwndId(hwnd);
	}
	function windowPointer(id) {
		if (!Number.isSafeInteger(id) || id <= 0) return void 0;
		for (const hwnd of enumTopLevel(api)) if (hwndId(hwnd) === id) return hwnd;
	}
	/**
	* `SetForegroundWindow` is ignored unless this process received the last input.
	* A posted Alt transition satisfies that, then the key is released.
	* @param target - top-level HWND pointer from `EnumWindows`.
	* @returns false when `target` is still not foreground after one retry.
	*/
	function becomeForeground(target) {
		if (api.IsIconic(target) !== 0) api.ShowWindow(target, SW_RESTORE);
		postKey(api, VK_MENU, true, false);
		try {
			api.SetForegroundWindow(target);
			if (!isForeground(target)) {
				sleepSync(FOREGROUND_RETRY_MS);
				if (!isForeground(target)) return false;
			}
			return true;
		} finally {
			postKey(api, VK_MENU, false, false);
		}
	}
	return {
		listWindows,
		capturePng(bounds) {
			return perMonitor(() => {
				const width = Math.max(1, Math.round(bounds.width));
				const height = Math.max(1, Math.round(bounds.height));
				const screenDc = api.GetDC(null);
				if (isNull(screenDc)) throw new Error("computer-use: screen capture failed");
				const memory = api.CreateCompatibleDC(screenDc);
				const bitmap = api.CreateCompatibleBitmap(screenDc, width, height);
				const previous = api.SelectObject(memory, bitmap);
				try {
					if (api.BitBlt(memory, 0, 0, width, height, screenDc, Math.round(bounds.x), Math.round(bounds.y), SRCCOPY) === 0) throw new Error("computer-use: screen capture failed");
					const header = {
						biSize: 40,
						biWidth: width,
						biHeight: height,
						biPlanes: 1,
						biBitCount: 32,
						biCompression: 0,
						biSizeImage: width * height * 4,
						biXPelsPerMeter: 0,
						biYPelsPerMeter: 0,
						biClrUsed: 0,
						biClrImportant: 0
					};
					const pixels = Buffer.alloc(width * height * 4);
					if (api.GetDIBits(memory, bitmap, 0, height, pixels, header, 0) === 0) throw new Error("computer-use: screen capture failed");
					return encodeBgraPng(width, height, pixels, true);
				} finally {
					api.SelectObject(memory, previous);
					api.DeleteObject(bitmap);
					api.DeleteDC(memory);
					api.ReleaseDC(null, screenDc);
				}
			});
		},
		targetBlocksInput() {
			const hwnd = api.GetForegroundWindow();
			if (isNull(hwnd) || selfRid === void 0) return false;
			const rid = integrityRid(api, pidOf(api, hwnd));
			return rid !== void 0 && rid > selfRid;
		},
		movePointer(x, y) {
			perMonitor(() => {
				placePointer(x, y);
			});
		},
		mouseButton(button, down) {
			const flags = button === "right" ? down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP : down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
			perMonitor(() => {
				sendMouse(api, flags, 0, 0);
			});
		},
		scrollWheel(x, y, delta) {
			perMonitor(() => {
				placePointer(x, y);
				sendMouse(api, MOUSEEVENTF_WHEEL, 0, 0, delta);
			});
		},
		key(virtualKey, down, extended = false) {
			postKey(api, virtualKey, down, extended);
		},
		readClipboardText() {
			let text = "";
			withClipboard(api, () => {
				const handle = api.GetClipboardData(CF_UNICODETEXT);
				if (isNull(handle)) return;
				const locked = api.GlobalLock(handle);
				if (isNull(locked)) return;
				try {
					const size = Number(api.GlobalSize(handle));
					if (!Number.isFinite(size) || size < 2) return;
					const bytes = Buffer.alloc(size);
					api.RtlMoveMemory(bytes, locked, size);
					text = bytes.toString("utf16le").replace(/\0[\s\S]*$/u, "");
				} finally {
					api.GlobalUnlock(handle);
				}
			});
			return text;
		},
		setClipboardText(text) {
			const bytes = Buffer.from(`${text}\0`, "utf16le");
			const memory = api.GlobalAlloc(GMEM_MOVEABLE, bytes.length);
			if (isNull(memory)) throw new Error("computer-use: clipboard allocation failed");
			const locked = api.GlobalLock(memory);
			if (isNull(locked)) throw new Error("computer-use: clipboard allocation failed");
			api.RtlMoveMemory(locked, bytes, bytes.length);
			api.GlobalUnlock(memory);
			withClipboard(api, () => {
				api.EmptyClipboard();
				if (isNull(api.SetClipboardData(CF_UNICODETEXT, memory))) throw new Error("computer-use: SetClipboardData failed");
			});
		},
		copyImageFile(path) {
			const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile(${JSON.stringify(path)})
try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }
`;
			execFileSync("powershell.exe", [
				"-NoProfile",
				"-STA",
				"-Command",
				script
			], {
				windowsHide: true,
				timeout: 5e3
			});
		},
		listWindowApps() {
			const names = /* @__PURE__ */ new Set();
			for (const hwnd of enumTopLevel(api)) {
				if (api.IsWindowVisible(hwnd) === 0) continue;
				const name = processBaseName(api, pidOf(api, hwnd));
				if (name !== void 0 && name !== "") names.add(name);
			}
			return [...names];
		},
		activateApp(name) {
			const wanted = name.trim().toLowerCase();
			if (wanted === "") return false;
			return perMonitor(() => {
				let target;
				for (const hwnd of enumTopLevel(api)) {
					if (api.IsWindowVisible(hwnd) === 0) continue;
					const app = (processBaseName(api, pidOf(api, hwnd)) ?? "").toLowerCase();
					const title = windowText(api, hwnd).toLowerCase();
					if (app === wanted || title.includes(wanted)) {
						target = hwnd;
						break;
					}
				}
				if (target === void 0) return false;
				if (!becomeForeground(target)) throw new Error(`computer-use: failed to activate ${name}`);
				return true;
			});
		},
		foregroundWindowId() {
			return hwndId(api.GetForegroundWindow()) ?? 0;
		},
		focusWindow(hwnd) {
			return perMonitor(() => {
				const target = windowPointer(hwnd);
				if (target === void 0) return false;
				return becomeForeground(target);
			});
		},
		launch(target, parameters) {
			const result = Number(api.ShellExecuteW(null, "open", target, parameters ?? null, null, SW_SHOWNORMAL));
			if (!Number.isFinite(result) || result <= 32) throw new Error(`computer-use: failed to open ${target}`);
		},
		explorerFolder
	};
}
//#endregion
export { createProductionWindowsOps };
