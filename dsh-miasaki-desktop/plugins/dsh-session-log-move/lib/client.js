window.__ModuleLoader__.load({
	id: "dsh-session-log-move",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * dsh-session-log-move — client half。
		 *
		 * 把「Session 日志」下载入口从主界面会话头部搬到轨迹页工具栏搜索栏左侧：
		 *
		 * 1. 隐藏主界面官方按钮：DOM 层 display:none（[class*="sessionLogButton"]，
		 *    子串锚点对 CSS hash 漂移稳健）。原设计的「向
		 *    conversation.session.header.utilities 注册 id: session-log-download
		 *    的同 id 条目做替换」自 DSH 0.1.5-rc.1 起已被官方自带的
		 *    `@deepseek-ai/dsh-session-log-export` 占位堵死（同 id 注册必然冲突），
		 *    2026-09-26 删除该死路——详见 apply 内注释；卸载时 disposer 还原
		 *    display，官方按钮复现（可逆）。
		 * 2. 轨迹页注入：[role=toolbar] 内 input[type="search"] 的容器左侧插入
		 *    「Session 日志」下载按钮。轨迹页 toolbar 没有官方 slot，只能 DOM
		 *    注入：MutationObserver 观察 body + 500ms 重试兜底（约 30s 窗口），
		 *    React 重渲染冲掉按钮后自动补挂。
		 * 3. 下载链路：优先复用官方 client 服务 sessionLogDownload（download
		 *    自带按会话去重），服务不可用时降级为 <a download> 直接触发
		 *    /api/session.export?sessionId=…&includeDescendants=true
		 *    （浏览器 GET 流式下载，不经 fetch，无网络层依赖）。
		 * 4. 反馈：按钮内联文案（准备中 / 已开始下载 / 下载失败，重试）随后复位。
		 *
		 * 生命周期：所有副作用（observer、按钮 DOM、retry/reset timer、被隐藏按钮的
		 * display 还原）挂 ctx.effect 的 disposer；stop / update / undefine 即完全复原。
		 *
		 * @package dsh-session-log-move
		 */

		/** Required services：timer（超时）、sessions（当前会话）。 */
		const inject = ["timer", "sessions"];

		const LABEL_READY = "Session 日志";
		const LABEL_BUSY = "准备中…";
		const LABEL_DONE = "已开始下载";
		const LABEL_FAIL = "下载失败，重试";
		const MAX_ATTEMPTS = 60; // 60 × 500ms ≈ 30s 重试窗口

		/** 当前会话 id：与官方头部按钮同源（sessions.list 快照的 current 字段）。 */
		function currentSessionId(ctx) {
			const list = ctx.sessions && ctx.sessions.list;
			if (!list) return null;
			const snap = list.getSnapshot();
			const id = snap ? snap.current : undefined;
			return id == null ? null : String(id);
		}

		/**
		 * 触发下载：优先官方 sessionLogDownload 服务（完整复用链路与去重），
		 * 缺失时降级为 <a download> 直接流式下载（不经 fetch）。
		 */
		function triggerDownload(ctx, sessionId) {
			const downloader = ctx.get("sessionLogDownload");
			const raw = downloader && typeof downloader.download === "function" ? downloader : null;
			if (raw) {
				try {
					return Promise.resolve(raw.download(sessionId));
				} catch (_) {
					/* 降级直下 */
				}
			}
			const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_");
			const a = document.createElement("a");
			a.href = "/api/session.export?sessionId=" + encodeURIComponent(sessionId) + "&includeDescendants=true";
			a.download = "dsh-session-" + safe + ".zip";
			document.body.appendChild(a);
			a.click();
			a.remove();
			return Promise.resolve(null);
		}

		/** 定位搜索框容器：toolbar 内优先，全局兜底；找不到返回 null。 */
		function findSearchAnchor() {
			const toolbar = document.querySelector('div[role="toolbar"]');
			if (toolbar) {
				const search = toolbar.querySelector('input[type="search"]');
				if (search && search.parentElement) return search.parentElement;
			}
			const anySearch = document.querySelector('input[type="search"]');
			if (anySearch && anySearch.parentElement) return anySearch.parentElement;
			return null;
		}

		function apply(ctx) {
			// ---- 1. 隐藏主界面官方按钮：只走 DOM ----
			// 历史：本插件原设计是向 conversation.session.header.utilities 注册
			// id: session-log-download 的**同 id 替换**条目（平台 slot 语义「复用已发布的
			// id 即接管该 cell」）。但 DSH 0.1.5-rc.1 起官方自带
			// `@deepseek-ai/dsh-session-log-export`，该 id 由官方包先行注册 ⇒ 替换从此
			// 永远冲突（`already has an entry with id … registered by …`），重试也不可能成功。
			//
			// 2026-09-26 清理：删掉这条**注定失败**的 slot 路线（连同 0.1.7 下必然抢跑的
			// 同步 register —— 槽声明是多级异步链，本插件 apply 时该槽尚未声明，于是每次
			// 页面加载都留一条 `slot … is not declared` 的 error 噪声；而即便等到声明，
			// 也只会换成同 id 冲突，永远走不到成功）。主界面按钮改由 DOM 隐藏**唯一**负责：
			// 不依赖 slot 语义，[class*="sessionLogButton"] 子串锚点对 CSS hash 漂移稳健，
			// 卸载时由 disposer 还原 display（见本节末尾）。
			// 若将来官方让出该 id，slot 替换路线可从 git 历史（≤0.1.1）恢复。
			const hideOfficialButton = () => {
				const nodes = document.querySelectorAll('button[class*="sessionLogButton"]');
				for (const node of nodes) {
					if (node.style.display !== "none") node.style.display = "none";
				}
			};

			// ---- 2. 轨迹页注入器状态（全部副作用归本 apply 的 fiber） ----
			let button = null;
			let observer = null;
			let retryTimer = null;
			let resetTimer = null;
			let attempts = 0;

			const setButton = (label, disabled) => {
				if (!button) return;
				button.textContent = label;
				button.disabled = disabled;
				button.setAttribute("aria-busy", disabled ? "true" : "false");
				button.setAttribute("aria-label", label + "（下载当前会话日志为 ZIP）");
			};

			const scheduleReset = (delay) => {
				if (resetTimer) {
					resetTimer();
					resetTimer = null;
				}
				resetTimer = ctx.timeout(() => {
					resetTimer = null;
					setButton(LABEL_READY, false);
				}, delay);
			};

			const removeButton = () => {
				if (button && button.parentNode) button.parentNode.removeChild(button);
				button = null;
			};

			const makeButton = () => {
				const btn = document.createElement("button");
				btn.type = "button";
				btn.textContent = LABEL_READY;
				Object.assign(btn.style, {
					height: "20px",
					padding: "0 8px",
					borderRadius: "4px",
					border: "0.5px solid var(--dsw-alias-border-l4, #666)",
					background: "transparent",
					color: "var(--dsw-alias-label-primary, #ddd)",
					fontFamily: "inherit",
					fontSize: "12px",
					lineHeight: "20px",
					cursor: "pointer",
					display: "inline-flex",
					alignItems: "center",
					gap: "4px",
					flex: "none",
					whiteSpace: "nowrap",
				});
				btn.addEventListener("mouseenter", () => {
					if (!btn.disabled) btn.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))";
				});
				btn.addEventListener("mouseleave", () => {
					btn.style.background = "transparent";
				});
				btn.addEventListener("click", () => {
					const id = currentSessionId(ctx);
					if (!id) {
						setButton("未找到会话", true);
						scheduleReset(2000);
						return;
					}
					setButton(LABEL_BUSY, true);
					triggerDownload(ctx, id)
						.then(() => {
							setButton(LABEL_DONE, false);
							scheduleReset(2500);
						})
						.catch(() => {
							setButton(LABEL_FAIL, false);
							scheduleReset(3500);
						});
				});
				return btn;
			};

			// 幂等：按钮已连接则跳过；否则重找锚点并插入（失败静默，等下一次触发）。
			const attachIfMissing = () => {
				if (button && button.isConnected) return;
				removeButton();
				const anchor = findSearchAnchor();
				if (!anchor) return;
				const btn = makeButton();
				anchor.parentNode.insertBefore(btn, anchor); // 搜索栏容器左侧 = 搜索栏左边
				button = btn;
				setButton(LABEL_READY, false);
			};

			const startRetry = () => {
				if (retryTimer || attempts >= MAX_ATTEMPTS) return;
				retryTimer = ctx.timeout(() => {
					retryTimer = null;
					attempts += 1;
					hideOfficialButton(); // 官方按钮被 React 重建后补一次隐藏
					if (!button || !button.isConnected) {
						attachIfMissing();
					}
					// 自有按钮挂上即收手；若用户始终没走到轨迹页，窗口最多空转 30s。
					if (button && button.isConnected) {
						retryTimer = null;
						return;
					}
					startRetry();
				}, 500);
			};

			const observe = () => {
				if (observer) return;
				observer = new MutationObserver(() => {
					hideOfficialButton(); // 官方按钮被 React 重建后立即重新隐藏
					attachIfMissing();
				});
				observer.observe(document.body, { childList: true, subtree: true });
			};

			ctx.effect(() => {
				hideOfficialButton();
				attachIfMissing();
				observe();
				startRetry();
				return () => {
					if (retryTimer) {
						retryTimer();
						retryTimer = null;
					}
					if (resetTimer) {
						resetTimer();
						resetTimer = null;
					}
					if (observer) {
						observer.disconnect();
						observer = null;
					}
					removeButton();
					// 恢复被 DOM 隐藏的官方按钮（slot 替换条目由 slot 服务自动复原）。
					const nodes = document.querySelectorAll('button[class*="sessionLogButton"]');
					for (const node of nodes) {
						if (node.style.display === "none") node.style.display = "";
					}
				};
			}, "dsh-session-log-move: trajectory toolbar download");
		}

		exports.name = "dsh-session-log-move";
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});