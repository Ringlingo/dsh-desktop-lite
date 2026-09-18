/**
 * dsh-balance-gate — 客户端半边（client half）
 *
 * 只做一件事：让壳注入的那个「余额」胶囊，**只在当前会话真的跑在 DeepSeek 上时才出现**，
 * 其他模型下把它（以及控制台「操作」页里的余额行）隐藏。
 *
 * 为什么只能从客户端做：余额胶囊由壳的注入脚本创建，而那段脚本是
 * `include_str!("../ui/shell-inject.js")` 编译进 exe 的 —— 改磁盘文件不生效，
 * 而现役 exe 对应的新源码已丢失，重编译会退化 UI。所以用 dsh 插件在页面上做补丁。
 *
 * provider 取法（按准确性排序）：
 *   1. 会话级：ctx.get("sessions").list.getSnapshot().current 拿当前会话 id，
 *      再用 ctx.get("modelDirectories").directoryFor(id).store.getSnapshot().current.provider。
 *      这就是 composer 模型座与 /model 弹窗共用的那份状态，等于「当前实际在用哪个模型」。
 *   2. 兜底：GET /dsh-balance-gate/api（宿主半边读 data/settings.yaml 的默认 provider）。
 *   3. 都拿不到 → 不隐藏（保持原样，宁可多显示也不要误隐藏）。
 *
 * 判定规则与壳桥 quota.rs 的 is_deepseek_provider 完全一致：
 *   provider.trim().toLowerCase().startsWith("deepseek")
 *
 * 文件格式遵循 dsh 客户端包的懒加载 CJS 约定：
 *   window.__ModuleLoader__.load({ id, factory })
 */

window.__ModuleLoader__.load({
	id: "dsh-balance-gate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var API_URL = "/dsh-balance-gate/api";
		var PILL_ID = "dshp-bal";
		var KV_ID = "kv-bal";
		var HIDDEN_CLASS = "dshbg-hidden";
		var STYLE_TAG = "dsh-balance-gate/styles";
		var POLL_MS = 1000;
		var HOST_TTL_MS = 30000;

		//#region 工具

		/** 与壳桥 quota.rs 的 is_deepseek_provider 同规则。 */
		function isDeepseekProvider(provider) {
			return typeof provider === "string" && provider.trim().toLowerCase().indexOf("deepseek") === 0;
		}

		function nonEmptyString(value) {
			return typeof value === "string" && value.trim() !== "" ? value : null;
		}

		//#endregion

		//#region 样式：只负责「隐藏」，用 !important 压过壳的内联样式

		function installStyles() {
			if (document.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') !== null) return;
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-balance-gate";
			tag.dataset.pluginCss = STYLE_TAG;
			tag.textContent = "." + HIDDEN_CLASS + "{display:none !important}";
			document.head.appendChild(tag);
		}

		//#endregion

		//#region provider 解析

		/** 当前会话 id（壳内单窗口下就是正在看的那个会话）。 */
		function currentSessionId(ctx) {
			try {
				var sessions = ctx.get("sessions");
				if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== "function") return null;
				var snapshot = sessions.list.getSnapshot();
				return snapshot ? nonEmptyString(snapshot.current) : null;
			} catch (error) {
				return null;
			}
		}

		/** 会话级 provider —— 权威来源（模型座与 /model 弹窗共用的那份状态）。 */
		function sessionProvider(ctx) {
			var sessionId = currentSessionId(ctx);
			if (sessionId === null) return null;
			try {
				var directories = ctx.get("modelDirectories");
				if (!directories || typeof directories.directoryFor !== "function") return null;
				var directory = directories.directoryFor(sessionId);
				if (!directory || !directory.store || typeof directory.store.getSnapshot !== "function") return null;
				var snapshot = directory.store.getSnapshot();
				var current = snapshot ? snapshot.current : null;
				return current ? nonEmptyString(current.provider) : null;
			} catch (error) {
				// 会话还没建 scope / 不是可路由会话 —— 交给兜底
				return null;
			}
		}

		/** 宿主半边汇报的 settings 默认 provider（带 TTL 的异步缓存，不阻塞轮询）。 */
		var hostDefault = { provider: null, at: 0, tried: false, error: null };

		function refreshHostDefault() {
			try {
				fetch(API_URL, { headers: { accept: "application/json" } })
					.then(function (response) { return response.ok ? response.json() : null; })
					.then(function (data) {
						var settings = data ? data.settings : null;
						var provider = settings ? nonEmptyString(settings.defaultProvider) : null;
						hostDefault.provider = provider;
						hostDefault.at = Date.now();
						hostDefault.tried = true;
						hostDefault.error = null;
					})
					.catch(function (error) {
						hostDefault.tried = true;
						hostDefault.error = String(error);
					});
			} catch (error) {
				hostDefault.tried = true;
				hostDefault.error = String(error);
			}
		}

		/** 解析出「当前生效的 provider」及它的来源。 */
		function resolveProvider(ctx) {
			var provider = sessionProvider(ctx);
			if (provider !== null) return { provider: provider, source: "session" };

			if (provider === null && (!hostDefault.tried || Date.now() - hostDefault.at > HOST_TTL_MS)) {
				refreshHostDefault();
			}
			if (hostDefault.provider !== null) return { provider: hostDefault.provider, source: "settings-default" };

			return { provider: null, source: "unknown" };
		}

		//#endregion

		//#region DOM 应用

		function toggle(el, hidden) {
			if (!el) return false;
			el.classList.toggle(HIDDEN_CLASS, hidden);
			return true;
		}

		/**
		 * 把显隐落到壳的 DOM 上：
		 *  - 标题栏余额胶囊 #dshp-bal
		 *  - 控制台「操作」页余额行 #kv-bal 及其左侧 dt 标签
		 * 两边都可能还不存在（壳是页面加载后 800ms 起用 eval 注入的），所以每个轮询都重试。
		 */
		function applyVisibility(hidden) {
			var applied = 0;
			if (toggle(document.getElementById(PILL_ID), hidden)) applied++;
			var dd = document.getElementById(KV_ID);
			if (dd) {
				toggle(dd, hidden);
				var dt = dd.previousElementSibling;
				if (dt && dt.tagName === "DT") toggle(dt, hidden);
				applied++;
			}
			return applied;
		}

		//#endregion

		//#region 主循环

		var state = {
			provider: null,
			source: "unknown",
			isDeepseek: null,
			hidden: false,
			targetsBound: 0,
			ticks: 0,
			lastTickAt: null,
		};

		function sync(ctx) {
			state.ticks++;
			state.lastTickAt = new Date().toISOString();

			var resolved = resolveProvider(ctx);
			state.provider = resolved.provider;
			state.source = resolved.source;

			// provider 未知时不隐藏：保持原行为，绝不误隐藏用户想看的东西。
			var isDeepseek = resolved.provider === null ? null : isDeepseekProvider(resolved.provider);
			var hidden = isDeepseek === false;

			state.isDeepseek = isDeepseek;
			state.hidden = hidden;
			state.targetsBound = applyVisibility(hidden);
		}

		//#endregion

		//#region 插件

		// 不声明 inject：立刻 apply，然后靠轮询等 sessions / modelDirectories 就位，
		// 也顺带覆盖壳注入脚本晚到（eval 在 800ms 之后才开始）的情况。
		var inject = [];

		function apply(ctx) {
			installStyles();
			sync(ctx);
			setInterval(function () {
				try {
					sync(ctx);
				} catch (error) {
					// 单次失败不影响后续轮询
				}
			}, POLL_MS);

			// 排查用句柄（只读小对象，方便在 DevTools 里看当前判定）
			try {
				window.__DSH_BALANCE_GATE__ = {
					state: state,
					sync: function () { sync(ctx); },
					rule: 'provider.trim().toLowerCase().startsWith("deepseek")',
				};
			} catch (error) {}
		}

		exports.name = "dsh-balance-gate";
		exports.inject = inject;
		exports.apply = apply;
		exports.isDeepseekProvider = isDeepseekProvider;
		exports.resolveProvider = resolveProvider;
		return module.exports;
	}
});
