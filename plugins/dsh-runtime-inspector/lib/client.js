/**
 * dsh-runtime-inspector — 客户端半边（client half）
 *
 * 这是一个 dsh 客户端插件包（browser-side）：在 dsh 设置面板里注册一个
 * 「运行时」页面（settings.section，id=runtime，order=30，排在最后）。
 *
 * 文件格式遵循 dsh 客户端包的懒加载 CJS 约定：
 *   window.__ModuleLoader__.load({ id, factory })
 * 执行脚本只做「注册工厂」，module 体在真正被 require 时才跑。
 *
 * 数据来自宿主半边的只读路由 GET /runtime-inspector/api。页面与 dsh 后端同源
 * （壳会把 WebView 导航到 http://127.0.0.1:<dsh端口>/），所以直接用相对路径 fetch。
 */
window.__ModuleLoader__.load({
	id: "dsh-runtime-inspector",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var h = React.createElement;

		var API_URL = "/runtime-inspector/api";
		var STYLE_TAG = "dsh-runtime-inspector/styles";
		var SECTION_ID = "runtime";
		var SECTION_ORDER = 30;
		var SECTION_LABEL = "运行时";
		var MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace';

		//#region 样式
		var CSS = [
			".dshri{display:flex;flex-direction:column;gap:16px;padding:2px 2px 24px;color:var(--dsw-alias-label-primary);font:13px/1.6 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}",
			".dshri-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}",
			".dshri-title{margin:0 0 5px;font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}",
			".dshri-desc{margin:0;max-width:540px;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary)}",
			".dshri-btn{flex:none;height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;transition:background .12s}",
			".dshri-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".dshri-btn:disabled{opacity:.5;cursor:default}",
			".dshri-cards{display:flex;flex-direction:column;gap:10px}",
			".dshri-card{display:flex;flex-direction:column;gap:9px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}",
			".dshri-card-top{display:flex;align-items:center;gap:10px}",
			".dshri-badge{padding:5px 8px;border-radius:7px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font:600 10.5px/1 " + MONO + ";letter-spacing:.08em;text-transform:uppercase}",
			".dshri-ver{font:600 13px/1 " + MONO + ";color:var(--dsw-alias-label-primary)}",
			".dshri-pill{display:inline-flex;align-items:center;gap:5px;margin-left:auto;padding:4px 9px;border-radius:999px;background:transparent;font-size:11px;font-weight:600;white-space:nowrap}",
			".dshri-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}",
			".dshri-pill.tone-ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,currentColor 12%,transparent)}",
			".dshri-pill.tone-warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,currentColor 12%,transparent)}",
			".dshri-pill.tone-error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,currentColor 12%,transparent)}",
			".dshri-hint{margin:0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}",
			".dshri-rows{display:grid;grid-template-columns:76px minmax(0,1fr);gap:3px 12px;font-size:12px}",
			".dshri-k{color:var(--dsw-alias-label-tertiary)}",
			".dshri-v{color:var(--dsw-alias-label-secondary);word-break:break-all}",
			".dshri-v.mono{font-family:" + MONO + "}",
			".dshri-note{display:flex;flex-wrap:wrap;gap:4px 16px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}",
			".dshri-note code{font-family:" + MONO + ";color:var(--dsw-alias-label-secondary)}",
			".dshri-error{padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.6;word-break:break-all}",
			".dshri-skeleton{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px}",
			".dshri-bar{height:10px;border-radius:5px;background:var(--dsw-alias-bg-skeleton)}",
		].join("");

		function installStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') !== null) return;
			var style = document.createElement("style");
			style.setAttribute("data-plugin-css", STYLE_TAG);
			style.textContent = CSS;
			document.head.appendChild(style);
		}
		//#endregion

		//#region 小工具
		function describe(error) {
			if (error === null || error === undefined) return "未知错误";
			if (typeof error === "string") return error;
			if (typeof error.message === "string" && error.message !== "") return error.message;
			return String(error);
		}

		function shortSource(source) {
			if (typeof source !== "string" || source === "") return "未知来源";
			// 只保留末两层，避免把一长串绝对路径塞进卡片
			var parts = source.replace(/\\/g, "/").split("/").filter(Boolean);
			return parts.length <= 2 ? parts.join("/") : "…/" + parts.slice(-2).join("/");
		}

		function verdictOf(runtime) {
			if (runtime === null || runtime === undefined || runtime.present !== true) {
				return { tone: "error", text: "缺失", hint: (runtime && runtime.reason) || "runtimes.json 未声明该运行时" };
			}
			if (runtime.exists !== true) {
				return { tone: "error", text: "文件缺失", hint: "清单声明了 " + runtime.executablePath + "，但该文件不存在" };
			}
			if (runtime.probeOk !== true) {
				return { tone: "warn", text: "探针失败", hint: runtime.probeText || "无法执行该可执行文件" };
			}
			if (runtime.directoryOnPath !== true) {
				return { tone: "warn", text: "就绪 · 未入 PATH", hint: "运行时本体正常，但它的目录不在 PATH 中，子进程可能用不到" };
			}
			return { tone: "ok", text: "就绪", hint: null };
		}
		//#endregion

		//#region 组件
		function StatusPill(props) {
			var verdict = props.verdict;
			return h("span", { className: "dshri-pill tone-" + verdict.tone },
				h("i", { className: "dshri-dot", "aria-hidden": "true" }),
				verdict.text
			);
		}

		function Row(props) {
			if (props.value === null || props.value === undefined || props.value === "") return null;
			return [
				h("div", { className: "dshri-k", key: "k" }, props.label),
				h("div", { className: "dshri-v" + (props.mono ? " mono" : ""), key: "v" }, props.value),
			];
		}

		function RuntimeCard(props) {
			var runtime = props.runtime;
			var verdict = verdictOf(runtime);
			var size = runtime && runtime.sizeText ? runtime.sizeText : null;
			var rows = [];

			rows.push(h(Row, { key: "exe", label: "可执行文件", value: runtime && runtime.executablePath, mono: true }));
			rows.push(h(Row, { key: "probe", label: "探针输出", value: runtime && runtime.versionRaw, mono: true }));
			rows.push(h(Row, { key: "size", label: "占用", value: size }));
			rows.push(h(Row, {
				key: "src",
				label: "来源",
				value: runtime && runtime.builtin === true
					? "便携包内置 · " + shortSource(runtime.source === "bundled" ? "随壳分发" : runtime.source)
					: shortSource(runtime && runtime.source),
			}));
			rows.push(h(Row, {
				key: "path",
				label: "PATH",
				value: runtime && runtime.directoryOnPath === true
					? "已注入  " + runtime.directory
					: "未在 PATH 中",
				mono: true,
			}));

			return h("article", { className: "dshri-card" },
				h("div", { className: "dshri-card-top" },
					h("span", { className: "dshri-badge" }, runtime && runtime.id ? runtime.id : "?"),
					h("span", { className: "dshri-ver" }, (runtime && (runtime.version || runtime.label)) || "—"),
					h(StatusPill, { verdict: verdict })
				),
				verdict.hint ? h("p", { className: "dshri-hint" }, verdict.hint) : null,
				h("div", { className: "dshri-rows" }, rows)
			);
		}

		function Skeleton() {
			return h("div", { className: "dshri-skeleton" },
				h("div", { className: "dshri-bar", style: { width: "34%" } }),
				h("div", { className: "dshri-bar", style: { width: "78%" } }),
				h("div", { className: "dshri-bar", style: { width: "62%" } })
			);
		}

		function RuntimeSection() {
			var statePair = React.useState({ status: "loading", data: null, error: null });
			var state = statePair[0];
			var setState = statePair[1];
			var seqPair = React.useState(0);
			var seq = seqPair[0];
			var bumpSeq = seqPair[1];

			React.useEffect(function () {
				var alive = true;
				setState(function (previous) { return { status: "loading", data: previous.data, error: null }; });
				fetch(API_URL, { headers: { accept: "application/json" }, cache: "no-store" })
					.then(function (response) {
						if (!response.ok) throw new Error("HTTP " + response.status + " " + response.statusText);
						return response.json();
					})
					.then(function (data) {
						if (alive) setState({ status: "ready", data: data, error: null });
					})
					.catch(function (error) {
						if (alive) setState({ status: "error", data: null, error: describe(error) });
					});
				return function () { alive = false; };
			}, [seq]);

			var data = state.data;
			var runtimes = data !== null && data !== undefined && Array.isArray(data.runtimes) ? data.runtimes : [];
			var loading = state.status === "loading";
			var manifest = data !== null && data !== undefined ? data.manifest : null;
			var pathReport = data !== null && data !== undefined ? data.pathReport : null;

			return h("div", { className: "dshri" },
				h("header", { className: "dshri-head" },
					h("div", null,
						h("h2", { className: "dshri-title" }, "内置运行时"),
						h("p", { className: "dshri-desc" },
							"本便携包自带的 Node.js / Python / Git。它们随包搬移，不依赖系统已安装的版本；启动时由启动器写进 PATH。只读展示，不在此处安装或卸载。"
						)
					),
					h("button", {
						type: "button",
						className: "dshri-btn",
						onClick: function () { bumpSeq(seq + 1); },
						disabled: loading,
					}, loading ? "刷新中…" : "刷新")
				),

				state.status === "error"
					? h("div", { className: "dshri-error" }, "读取运行时状态失败：" + state.error)
					: null,

				manifest !== null && manifest !== undefined && manifest.readable === false
					? h("div", { className: "dshri-error" },
						"读不到 " + manifest.path + "：" + (manifest.error || "未知原因") +
						"。请先运行 provision-runtimes.mjs 落地内置运行时。")
					: null,

				h("div", { className: "dshri-cards" },
					runtimes.length > 0
						? runtimes.map(function (runtime) {
							return h(RuntimeCard, { key: runtime.id, runtime: runtime });
						})
						: (loading
							? [h(Skeleton, { key: "s1" }), h(Skeleton, { key: "s2" }), h(Skeleton, { key: "s3" })]
							: null)
				),

				data !== null && data !== undefined
					? h("section", { className: "dshri-note" },
						h("span", null, "清单：", h("code", null, manifest ? manifest.path : "runtime/runtimes.json")),
						pathReport !== null && pathReport !== undefined
							? h("span", null, "已入 PATH：", h("code", null,
								pathReport.onPath && pathReport.onPath.length > 0 ? pathReport.onPath.join(" · ") : "（无）"))
							: null,
						pathReport !== null && pathReport !== undefined && pathReport.missing && pathReport.missing.length > 0
							? h("span", null, "未入 PATH：", h("code", null, pathReport.missing.join(" · ")))
							: null,
						h("span", null, "dsh 后端：", h("code", null,
							String(data.nodeVersion || "") + " · pid " + String(data.pid) + " · " + String(data.platform)))
					)
					: null
			);
		}
		//#endregion

		//#region 插件
		var inject = ["slots"];

		function apply(ctx) {
			installStyles();
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: SECTION_ID,
					order: SECTION_ORDER,
					label: function () { return SECTION_LABEL; },
				}, RuntimeSection);
			});
		}

		exports.name = "dsh-runtime-inspector";
		exports.inject = inject;
		exports.apply = apply;
		exports.RuntimeSection = RuntimeSection;
		return module.exports;
	}
});
