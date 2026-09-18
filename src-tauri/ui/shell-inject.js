// dsh-portable 壳 UI 注入脚本（v4 - 自定义标题栏版）
// 结构：
//   1. 自定义标题栏：标题 + 编辑/帮助菜单 + 胶囊(余额+控制台) + 窗口控制
//   2. 控制台面板：日志/操作/设置 三 Tab
// 数据通道：壳本地 HTTP 桥（window.DSH_SHELL_PORT）+ 同源 fetch dsh /api。
// 主题：全部使用 DSH CSS 变量，自动跟随主题。
(function () {
  "use strict";
  if (document.getElementById("dshp-root")) return; // 幂等

  var PORT = window.DSH_SHELL_PORT || parseInt(sessionStorage.getItem("DSH_SHELL_PORT") || "0", 10) || 47563;
  var BASE = "http://127.0.0.1:" + PORT;

  // ---------- i18n ----------
  var lang = (navigator.language || "zh").startsWith("zh") ? "zh" : "en";
  // 尝试从 DSH 设置读取语言偏好（同步，覆盖系统语言）
  try {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", BASE + "/api/shell/settings", false);
    xhr.timeout = 2000;
    xhr.send();
    if (xhr.status === 200) {
      var s = JSON.parse(xhr.responseText);
      if (s && s.locale) lang = s.locale;
    }
  } catch (e) {}
  var i18n = {
    zh: {
      edit: "编辑(E)", help: "帮助(H)",
      undo: "撤销", redo: "恢复", cut: "剪切", copy: "复制", paste: "粘贴",
      devtools: "切换开发人员工具", viewGithub: "查看 GitHub", docs: "开发者文档", plugins: "社区插件", cordis: "Cordis 论文",
      min: "最小化", max: "最大化", close: "关闭",
      balance: "余额", console: "控制台",
      noData: "暂无数据（点击刷新重试）", queryFail: "查询失败: ",
      total: "总额", granted: "赠送", topped: "充值",
      dshBackend: "DSH 后端", port: "端口", disconnected: "未连接",
      logs: "日志", ops: "操作", settings: "设置",
      realtimeLog: "实时日志流", items: "条", export: "导出", clear: "清空", pause: "暂停", resume: "恢复",
      status: "状态", pid: "PID", version: "版本",
      healthCheck: "健康检查", restart: "重启后端", checkUpdate: "检查更新", updateTo: "更新到最新版",
      healthTip: '健康检查=端口通+服务能应答；重启会自动恢复；导出日志见"日志"标签。',
      noLogs: "暂无日志可导出", exported: "已导出 ", exportFailed: "导出失败: ", logCleared: "日志视图已清空",
      healthRunning: "正在健康检查…", healthResult: "健康检查：端口连通 ", serviceReply: " · 服务应答 ",
      healthFailed: "健康检查失败: ", confirmRestart: "确定重启 DSH 后端？当前会话会中断。",
      restarting: "正在重启后端…", restarted: "后端已重启，端口 ", restartFailed: "重启失败: ",
      checkingUpdate: "正在检查更新…", checkFailed: "检查失败: ", newVersion: "发现新版本 ", latest: "已是最新版本",
      confirmUpdate: "确定更新到 ", updateNote: "？更新包地址需 M5 打包流水线产出。",
      updateWaiting: "更新：等待打包流水线接入下载 URL…",
      updating: "更新中…（进度见「日志」页）",
      updateStarted: "更新已开始；完成后请点「重启后端」使其生效",
      selectProvider: "请先选择 provider",
      injectError: "注入错误: ",
      textFile: "文本文件",
      settingsTip: "余额与 provider 均由 DSH 自动发现；如需手动覆盖请选择 Provider 并点击应用。",
      shellError: "壳连接错误: "
    },
    en: {
      edit: "Edit(E)", help: "Help(H)",
      undo: "Undo", redo: "Redo", cut: "Cut", copy: "Copy", paste: "Paste",
      devtools: "Toggle DevTools", viewGithub: "View GitHub", docs: "Developer Docs", plugins: "Community Plugins", cordis: "Cordis Paper",
      min: "Minimize", max: "Maximize", close: "Close",
      balance: "Balance", console: "Console",
      noData: "No data (click to retry)", queryFail: "Query failed: ",
      total: "Total", granted: "Granted", topped: "Topped up",
      dshBackend: "DSH Backend", port: "Port", disconnected: "Disconnected",
      logs: "Logs", ops: "Operations", settings: "Settings",
      realtimeLog: "Real-time log stream", items: "", export: "Export", clear: "Clear", pause: "Pause", resume: "Resume",
      status: "Status", pid: "PID", version: "Version",
      healthCheck: "Health Check", restart: "Restart Backend", checkUpdate: "Check Update", updateTo: "Update to Latest",
      healthTip: 'Health check = port reachable + service responds; restart auto-recovers; see "Logs" tab to export.',
      noLogs: "No logs to export", exported: "Exported ", exportFailed: "Export failed: ", logCleared: "Log view cleared",
      healthRunning: "Running health check…", healthResult: "Health check: port ", serviceReply: " · service ",
      healthFailed: "Health check failed: ", confirmRestart: "Restart DSH backend? Current session will be interrupted.",
      restarting: "Restarting backend…", restarted: "Backend restarted, port ", restartFailed: "Restart failed: ",
      checkingUpdate: "Checking updates…", checkFailed: "Check failed: ", newVersion: "New version found: ", latest: "Already up to date",
      confirmUpdate: "Update to ", updateNote: "? Update package requires M5 pipeline.",
      updateWaiting: "Update: waiting for pipeline download URL…",
      updating: "Updating… (progress in the Logs tab)",
      updateStarted: "Update started — click Restart backend when it finishes",
      selectProvider: "Please select a provider first",
      injectError: "Injection error: ",
      textFile: "Text file",
      settingsTip: "Balance and provider are auto-discovered by DSH; select a Provider and click Apply to override.",
      shellError: "Shell connection error: "
    }
  };
  function t(key) { return (i18n[lang] && i18n[lang][key]) || i18n.zh[key] || key; }

  function api(path, payload, method) {
    return fetch(BASE + path, {
      method: method || "POST",
      headers: { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return { error: "HTTP " + r.status }; });
    });
  }

  // ---------- 全局错误捕获（诊断用）----------
  window.addEventListener("error", function (e) {
    try {
      var d = document.createElement("div");
      d.style.cssText = "position:fixed;bottom:8px;right:8px;background:#fee;color:#c00;padding:8px 12px;border-radius:6px;z-index:2147483603;font:12px/1.4 monospace;max-width:60%";
      d.textContent = t("injectError") + (e.message || "?");
      document.body.appendChild(d);
    } catch (x) {}
  });

  // ---------- 样式（直接使用 DSH 主题变量，自动跟随主题）----------
  var css = [
    // 自定义标题栏
    "#dshp-titlebar{position:fixed;top:0;left:0;right:0;height:40px;z-index:2147483601;display:flex;align-items:center;background:var(--dsw-alias-bg-base);font:13px/1.5 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:var(--dsw-alias-label-primary);-webkit-app-region:drag}",
    "#dshp-titlebar .tb-left{display:flex;align-items:center;gap:10px;padding:0 10px;-webkit-app-region:drag}",
    "#dshp-titlebar .tb-icon{width:18px;height:18px;-webkit-app-region:drag;flex-shrink:0}",
    "#dshp-titlebar .tb-text{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary);-webkit-app-region:drag;white-space:nowrap}",
    "#dshp-titlebar .tb-menus{display:flex;gap:0;-webkit-app-region:no-drag}",
    "#dshp-titlebar .tb-menu-btn{background:transparent;border:none;color:var(--dsw-alias-label-secondary);padding:6px 10px;border-radius:0;font:inherit;cursor:pointer;transition:.12s;white-space:nowrap}",
    "#dshp-titlebar .tb-menu-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
    "#dshp-titlebar .tb-menu-btn.open{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
    // 下拉菜单
    ".dshp-dropdown{position:absolute;top:100%;left:0;margin-top:0;min-width:200px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:2147483602;display:none}",
    ".dshp-dropdown.open{display:block}",
    ".dshp-dropdown-item{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-radius:5px;font:13px/1.4 inherit;color:var(--dsw-alias-label-primary);cursor:pointer;transition:.1s;white-space:nowrap}",
    ".dshp-dropdown-item:hover{background:var(--dsw-alias-interactive-bg-hover)}",
    ".dshp-dropdown-item .shortcut{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:24px;flex-shrink:0}",
    ".dshp-dropdown-sep{height:1px;background:var(--dsw-alias-border-l2);margin:4px 6px}",
    // 标题栏右侧
    "#dshp-titlebar .tb-right{display:flex;align-items:center;gap:4px;-webkit-app-region:no-drag;height:100%;margin-left:auto}",
    // 胶囊（无边框）
    "#dshp-bar{display:flex;align-items:center;gap:6px;background:transparent;padding:4px 6px;color:var(--dsw-alias-label-primary)}",
    // 窗口控制按钮（与菜单按钮风格一致）
    "#dshp-titlebar .tb-winbtns{display:flex;height:100%;-webkit-app-region:no-drag;margin-left:4px}",
    "#dshp-titlebar .tb-winbtn{width:46px;height:100%;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.1s}",
    "#dshp-titlebar .tb-winbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
    "#dshp-titlebar .tb-winbtn.close:hover{background:#c42b1c;color:#fff}",
    "#dshp-titlebar .tb-winbtn svg{width:10px;height:10px}",
    "#dshp-panel{position:fixed;top:48px;right:14px;width:680px;max-width:calc(100vw - 28px);height:72vh;max-height:680px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;display:none;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary);z-index:2147483600;font:13px/1.5 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}",
    "#dshp-panel.open{display:flex}",
    "#dshp-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
    "#dshp-head .title{font-weight:600;font-size:14px;display:flex;align-items:center;gap:7px}",
    "#dshp-head .title .dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}",
    "#dshp-head .title .dot.running{background:var(--dsw-alias-state-success-primary)}",
    "#dshp-head .state{margin-left:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-family:monospace}",
    "#dshp-head .spacer{flex:1}",
    "#dshp-head button{background:transparent;border:1px solid transparent;border-radius:7px;padding:4px 8px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;transition:.12s}",
    "#dshp-head button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
    "#dshp-tabs{display:flex;gap:2px;padding:0 14px;border-bottom:1px solid var(--dsw-alias-border-l2);background:transparent}",
    "#dshp-tabs .tab{padding:8px 14px;background:transparent;border:none;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:.12s}",
    "#dshp-tabs .tab:hover{color:var(--dsw-alias-label-primary)}",
    "#dshp-tabs .tab.active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary);font-weight:500}",
    "#dshp-body{flex:1;overflow:hidden;display:flex;flex-direction:column}",
    ".dshp-tab-pane{display:none;flex:1;overflow:auto;padding:14px}",
    ".dshp-tab-pane.active{display:flex;flex-direction:column;gap:12px}",
    "#dshp-kv{display:grid;grid-template-columns:72px 1fr;gap:6px 12px;background:var(--dsw-alias-markdown-code-block);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px}",
    "#dshp-kv dt{color:var(--dsw-alias-label-tertiary);font-size:12px}",
    "#dshp-kv dd{margin:0;font:12.5px/1.5 ui-monospace,Consolas,monospace;word-break:break-all}",
    "#dshp-actions{display:flex;gap:8px;flex-wrap:wrap}",
    "#dshp-actions button{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 13px;cursor:pointer;font:13px/1 inherit;transition:.12s}",
    "#dshp-actions button:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-state-business-primary)}",
    "#dshp-actions button.primary{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);border-color:var(--dsw-alias-state-business-primary)}",
    "#dshp-actions button.primary:hover{opacity:.9}",
    "#dshp-actions button.danger:hover{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
    "#dshp-actions button:disabled{opacity:.45;cursor:default}",
    "#dshp-logs-toolbar{display:flex;align-items:center;gap:6px;padding-bottom:8px}",
    "#dshp-logs-toolbar .label{font-size:12px;color:var(--dsw-alias-label-tertiary);font-family:monospace}",
    "#dshp-logs-toolbar .spacer{flex:1}",
    "#dshp-logs-toolbar button{background:transparent;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 9px;cursor:pointer;font:12px/1 inherit}",
    "#dshp-logs-toolbar button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
    "#dshp-logs{flex:1;min-height:200px;background:var(--dsw-alias-markdown-code-block);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px;overflow:auto;font:12px/1.5 ui-monospace,Consolas,'Courier New',monospace;color:var(--dsw-alias-label-primary)}",
    "#dshp-logs .line{padding:1px 0;word-break:break-all;white-space:pre-wrap}",
    "#dshp-logs .line.err{color:var(--dsw-alias-state-error-primary)}",
    "#dshp-logs .line.shell{color:var(--dsw-alias-state-business-primary)}",
    "#dshp-logs .line .ts{color:var(--dsw-alias-label-tertiary);margin-right:6px;font-size:11px}",
    "#dshp-tip{font-size:11.5px;color:var(--dsw-alias-label-tertiary);min-height:14px;line-height:1.4}",
    "#dshp-err{position:fixed;top:48px;right:14px;background:var(--dsw-alias-state-error-primary);color:#fff;padding:7px 13px;border-radius:9px;font:12.5px/1.5 inherit;z-index:2147483601;max-width:460px;display:none}",
    "#dshp-logs::-webkit-scrollbar,#dshp-body::-webkit-scrollbar{width:9px;height:9px}",
    "#dshp-logs::-webkit-scrollbar-thumb,#dshp-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:5px}"
  ].join("");
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- DOM：自定义标题栏 ----------
  var titlebar = document.createElement("div");
  titlebar.id = "dshp-titlebar";
  document.body.appendChild(titlebar);

  // 左侧：图标 + 标题
  var leftArea = document.createElement("div");
  leftArea.className = "tb-left";
  titlebar.appendChild(leftArea);

  var icon = document.createElement("img");
  icon.className = "tb-icon";
  icon.src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADBElEQVR4nO2WS4iOURjHf+/3fsiUWxgLueS20LhtiERTiLKQZGMlK0kiNrPRKDsLGY1pbFiKkkIWarDCwm2BhUYpxch1GHP9Pj31P80zx/vO932xmZqnTuc95z3nPP/zP//zPAfGbYxbohJbWssClazgxpVd35Br/3dLgGIV46YCszI2sl0sZDGRVGKoELXnA2uBjcByYBlwHLgHfALaI2cLgT5gldqp1ixWs6mC6snACeAJ0COqrZSAAdf+AdRp3gS3e/v3BtiXw1obMDPP+RLgqXMSHIczLwuEld/Abs2bqHprNPcYMA84CZwDXmmtKbFzK/VApyb2a2ApAlLK+D7lzncu0Kv5g8BXoCsCddsdz4iPqxrQG00YrQRmLjBs7eobdON6BMq+t3m/qRrr3c7KboGBqC8uJQe4RWsZvXcEzoOwtY7EYi+qbnPC+igle0d+oawSxNnqhPxLfS+B08Dq2DnuDr8G3kswptRFEtgloNvR7TVg9RfgUQTmvgQXxjQzbJkxoE47NwFmmYG5HIkvgOkAGoBGxYWYcquPiulwU/6yacA3neUcF63SKHjsl5BKztFz4AYwA9jgbtCAE2jjaLtHyDqdQuNwGSKZ2U4XB0pirkssmZ1xIKz+DEzPyz0FlX5FLpuwS7UfHHZsQG8ChwUoBJTZugE7pB/cMXSI3TQveRVVNzvE9Q5cDDiE3GsVbkfo31KJ/oLqBjfpvPqCs6xMWS/qhzJKEN/dyEeupaqvO/RGJ065iUD6xfZE5+2vZ7fySlINgIIGLgV+aoHvwGb339h4CzwG1rm5LQ5EuJ4W/zfpfzXvihEs7HW7sUh2kGE7pP4+petgV1wO6VcaX1Pjy2sE2gNR+n0InJWiwzmXJcSVYudihhBfAAtGO4YkB8Sg8nqrztFbEKrRPUl9ds0eALekk8Va5x3QpAiZ1PKGTF2EbNIjIi8JfVAqDoGoJksqgDCq0U4tk61QqC7rClrweiYG/BEGcP/8ek6qVHFai9BiB9VYEFE83t/7cRub9gekwjGJbeDuWgAAAABJRU5ErkJggg==";
  icon.alt = "";
  leftArea.appendChild(icon);

  // 图标主题自适应：深色模式下反转为白色
  function updateIconTheme() {
    try {
      var bg = getComputedStyle(titlebar).backgroundColor;
      var m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        var brightness = (parseInt(m[1]) * 299 + parseInt(m[2]) * 587 + parseInt(m[3]) * 114) / 1000;
        icon.style.filter = brightness < 128 ? "invert(1)" : "none";
      }
    } catch (e) {}
  }
  updateIconTheme();
  setInterval(updateIconTheme, 2000);

  // 编辑/帮助菜单按钮
  var menusDiv = document.createElement("div");
  menusDiv.className = "tb-menus";
  titlebar.appendChild(menusDiv);

  function createMenuBtn(label, menuId) {
    var btn = document.createElement("button");
    btn.className = "tb-menu-btn";
    btn.textContent = label;
    btn.dataset.menu = menuId;
    var wrapper = document.createElement("div");
    wrapper.style.cssText = "position:relative";
    wrapper.appendChild(btn);
    var dd = document.createElement("div");
    dd.className = "dshp-dropdown";
    dd.id = "dshp-dd-" + menuId;
    wrapper.appendChild(dd);
    menusDiv.appendChild(wrapper);
    return { btn: btn, dd: dd };
  }

  var editMenu = createMenuBtn(t("edit"), "edit");
  var helpMenu = createMenuBtn(t("help"), "help");

  // 编辑下拉菜单内容
  var editItems = [
    { label: t("undo"), shortcut: "Ctrl+Z", action: function () { doEdit("undo"); } },
    { label: t("redo"), shortcut: "Ctrl+Y", action: function () { doEdit("redo"); } },
    null, // separator
    { label: t("cut"), shortcut: "Ctrl+X", action: function () { doEdit("cut"); } },
    { label: t("copy"), shortcut: "Ctrl+C", action: function () { doEdit("copy"); } },
    { label: t("paste"), shortcut: "Ctrl+V", action: function () { doEdit("paste"); } }
  ];
  editItems.forEach(function (item) {
    if (!item) {
      var sep = document.createElement("div");
      sep.className = "dshp-dropdown-sep";
      editMenu.dd.appendChild(sep);
      return;
    }
    var el = document.createElement("div");
    el.className = "dshp-dropdown-item";
    el.innerHTML = '<span>' + item.label + '</span><span class="shortcut">' + (item.shortcut || "") + '</span>';
    el.addEventListener("click", function () { closeAllDropdowns(); item.action(); });
    editMenu.dd.appendChild(el);
  });

  // 帮助下拉菜单内容
  var helpItems = [
    { label: t("devtools"), shortcut: "Ctrl+Shift+I", action: function () { api("/api/shell/devtools", { enabled: true }); } },
    null,
    { label: t("viewGithub"), action: function () { api("/api/shell/open-external", { url: "https://github.com/deepseek-ai/deepseek-harness" }); } },
    { label: t("docs"), action: function () { api("/api/shell/open-external", { url: "https://deepseek-harness.github.io/deepseek-harness/guide/quickstart" }); } },
    { label: t("plugins"), action: function () { api("/api/shell/open-external", { url: "https://github.com/topics/dsh-plugin" }); } },
    { label: t("cordis"), action: function () { api("/api/shell/open-external", { url: "https://github.com/cordiverse/paper" }); } }
  ];
  helpItems.forEach(function (item) {
    if (!item) {
      var sep = document.createElement("div");
      sep.className = "dshp-dropdown-sep";
      helpMenu.dd.appendChild(sep);
      return;
    }
    var el = document.createElement("div");
    el.className = "dshp-dropdown-item";
    el.innerHTML = '<span>' + item.label + '</span><span class="shortcut">' + (item.shortcut || "") + '</span>';
    el.addEventListener("click", function () { closeAllDropdowns(); item.action(); });
    helpMenu.dd.appendChild(el);
  });

  // 菜单开关逻辑
  function closeAllDropdowns() {
    menusDiv.querySelectorAll(".dshp-dropdown").forEach(function (dd) { dd.classList.remove("open"); });
    menusDiv.querySelectorAll(".tb-menu-btn").forEach(function (b) { b.classList.remove("open"); });
  }
  menusDiv.addEventListener("click", function (e) {
    var btn = e.target.closest(".tb-menu-btn");
    if (!btn) return;
    var dd = btn.parentElement.querySelector(".dshp-dropdown");
    var wasOpen = dd.classList.contains("open");
    closeAllDropdowns();
    if (!wasOpen) { dd.classList.add("open"); btn.classList.add("open"); }
    e.stopPropagation();
  });
  document.addEventListener("click", function (e) {
    if (!menusDiv.contains(e.target)) closeAllDropdowns();
  });

  // 标题栏右侧：胶囊 + 窗口控制（整个标题栏都是拖拽区，交互元素用 no-drag 覆盖）
  var rightArea = document.createElement("div");
  rightArea.className = "tb-right";
  titlebar.appendChild(rightArea);

  // 胶囊（余额+控制台）——移入标题栏
  var root = document.createElement("div");
  root.id = "dshp-root";
  root.style.cssText = "font:13px/1.5 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
  rightArea.appendChild(root);

  // 窗口控制按钮（SVG 图标，与菜单风格一致）
  var winBtns = document.createElement("div");
  winBtns.className = "tb-winbtns";
  titlebar.appendChild(winBtns);

  var btnMin = document.createElement("button");
  btnMin.className = "tb-winbtn";
  btnMin.innerHTML = '<svg viewBox="0 0 10 10"><line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" stroke-width="1.2"/></svg>';
  btnMin.title = t("min");
  btnMin.addEventListener("click", function () { api("/api/shell/window/minimize"); });
  winBtns.appendChild(btnMin);

  var btnMax = document.createElement("button");
  btnMax.className = "tb-winbtn";
  btnMax.innerHTML = '<svg viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
  btnMax.title = t("max");
  btnMax.addEventListener("click", function () { api("/api/shell/window/toggle-maximize"); });
  winBtns.appendChild(btnMax);

  var btnClose = document.createElement("button");
  btnClose.className = "tb-winbtn close";
  btnClose.innerHTML = '<svg viewBox="0 0 10 10"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.2"/><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.2"/></svg>';
  btnClose.title = t("close");
  btnClose.addEventListener("click", function () { api("/api/shell/window/close"); });
  winBtns.appendChild(btnClose);

  // 页面内容偏移（避免被标题栏遮挡）+ 撑开不滚动
  document.body.style.paddingTop = "40px";
  document.body.style.boxSizing = "border-box";
  document.body.style.height = "100vh";
  document.body.style.overflow = "hidden";
  document.documentElement.style.overflow = "hidden";

  // ---------- DOM：胶囊（余额+控制台，在标题栏内）----------

  var bar = document.createElement("div");
  bar.id = "dshp-bar";
  bar.style.cssText = "display:flex;align-items:center;gap:6px;background:transparent;padding:4px 6px;color:var(--dsw-alias-label-primary)";
  root.appendChild(bar);

  var btnStyle = "display:inline-flex;align-items:center;gap:5px;background:transparent;border:1px solid transparent;border-radius:9px;padding:4px 9px;color:inherit;font:inherit;cursor:pointer;transition:background .15s,border-color .15s";
  function setupHover(btn) {
    btn.addEventListener("mouseenter", function () {
      btn.style.background = "rgba(128,128,128,.12)";
      btn.style.borderColor = "var(--dsw-alias-border-l2)";
    });
    btn.addEventListener("mouseleave", function () {
      btn.style.background = "transparent";
      btn.style.borderColor = "transparent";
    });
  }

  var bal = document.createElement("button");
  bal.id = "dshp-bal";
  bal.title = t('balance') + ' — ' + (lang === 'zh' ? '点击刷新' : 'Click to refresh');
  bal.style.cssText = btnStyle + ";min-width:80px;font-size:12.5px";
  // 余额胶囊：只显示「余额 <金额>」，**金额前不放任何货币符号**。
  // （原实现在金额前塞了一个人民币符号图标；用户要求去掉。
  //   动态更新走 setBal()，那里本来就只写 label，保持一致。）
  bal.innerHTML = '<span class="label">' + t("balance") + ' --</span>';
  setupHover(bal);
  bar.appendChild(bal);

  var toggleBtn = document.createElement("button");
  toggleBtn.id = "dshp-btn-toggle";
  toggleBtn.title = t("dshBackend") + " " + t("console");
  toggleBtn.style.cssText = btnStyle + ";font-weight:500";
  toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/></svg><span style="margin-left:4px">' + t("console") + '</span>';
  setupHover(toggleBtn);
  bar.appendChild(toggleBtn);

  // ---------- 控制台面板 ----------
  var panel = document.createElement("div");
  panel.id = "dshp-panel";
  panel.innerHTML =
    '<div id="dshp-head">' +
    '  <div class="title"><span class="dot" id="dshp-title-dot"></span><span>' + t("console") + '</span></div>' +
    '  <span class="state" id="dshp-state">-</span>' +
    '  <div class="spacer"></div>' +
    '  <button id="dshp-refresh-all" title="Refresh">&#x27F3;</button>' +
    '  <button id="dshp-close" title="' + t("close") + '">&times;</button>' +
    '</div>' +
    '<div id="dshp-tabs">' +
    '  <button class="tab active" data-tab="logs">' + t("logs") + '</button>' +
    '  <button class="tab" data-tab="ops">' + t("ops") + '</button>' +
    '  <button class="tab" data-tab="settings">' + t("settings") + '</button>' +
    '</div>' +
    '<div id="dshp-body">' +
    '  <div class="dshp-tab-pane active" data-pane="logs">' +
    '    <div id="dshp-logs-toolbar">' +
    '      <span class="label">' + t("realtimeLog") + '（<span id="dshp-log-count">0</span> ' + t("items") + '）</span>' +
    '      <div class="spacer"></div>' +
    '      <button id="a-logs-export" title="' + t("export") + '">' + t("export") + '</button>' +
    '      <button id="a-logs-clear" title="' + t("clear") + '">' + t("clear") + '</button>' +
    '      <button id="a-logs-pause" title="' + t("pause") + '/' + t("resume") + '">' + t("pause") + '</button>' +
    '    </div>' +
    '    <div id="dshp-logs"></div>' +
    '  </div>' +
    '  <div class="dshp-tab-pane" data-pane="ops">' +
    '    <div id="dshp-kv">' +
    '      <dt>' + t("status") + '</dt><dd id="kv-state">-</dd>' +
    '      <dt>' + t("pid") + '</dt><dd id="kv-pid">-</dd>' +
    '      <dt>' + t("port") + '</dt><dd id="kv-port">-</dd>' +
    '      <dt>' + t("version") + '</dt><dd id="kv-ver">-</dd>' +
    '      <dt>DSH_HOME</dt><dd id="kv-home">-</dd>' +
    '      <dt>' + t("balance") + '</dt><dd id="kv-bal">-</dd>' +
    '    </div>' +
    '    <div id="dshp-actions">' +
    '      <button id="a-health">' + t('healthCheck') + '</button>' +
    '      <button id="a-restart" class="danger">' + t('restart') + '</button>' +
    '      <button id="a-update-check">' + t('checkUpdate') + '</button>' +
    '      <button id="a-update-apply" class="primary" disabled>' + t('updateTo') + '</button>' +
    '    </div>' +
    '    <div id="dshp-tip">' + t("healthTip") + '</div>' +
    '  </div>' +
    '  <div class="dshp-tab-pane" data-pane="settings">' +
    '    <div>' +
    '      <div style="font-size:12px;color:var(--dshp-fg-dim);margin-bottom:6px">Provider</div>' +
    '      <div style="display:flex;gap:6px">' +
    '        <select id="a-provider-select" style="flex:1;background:var(--dshp-code-bg);color:var(--dshp-fg);border:1px solid var(--dshp-border-strong);border-radius:7px;padding:6px 10px;font:13px/1 inherit">' +
    '          <option value="">Auto</option>' +
    '          <option value="deepseek-official">DeepSeek</option>' +
    '        </select>' +
    '        <button id="a-provider-apply">Apply</button>' +
    '      </div>' +
    '    </div>' +
    '    <div id="dshp-tip">' + t("settingsTip") + '</div>' +
    '  </div>' +
    '</div>';
  document.body.appendChild(panel);

  var errBox = document.createElement("div");
  errBox.id = "dshp-err";
  document.body.appendChild(errBox);

  var $ = function (id) { return document.getElementById(id); };
  var state = { provider: null, providerManual: false, latest: null, logsCursor: 0, logsBuffer: [], logPaused: false, dshReady: false };

  function showErr(msg) {
    errBox.textContent = t("shellError") + msg;
    errBox.style.display = "block";
    clearTimeout(errBox._t);
    errBox._t = setTimeout(function () { errBox.style.display = "none"; }, 8000);
  }
  function setTip(t) { $("dshp-tip").textContent = t; }

  // 主题由 DSH CSS 变量自动处理（--dsw-alias-*），无需手动检测。

  // ---------- 状态 ----------
  function refreshStatus() {
    api("/api/shell/status").then(function (info) {
      var ready = info.state === "running" && info.port != null;
      $("kv-state").textContent = info.state || "-";
      $("dshp-state").textContent = info.state || "-";
      $("kv-pid").textContent = info.pid != null ? info.pid : "-";
      $("kv-port").textContent = info.port != null ? info.port : "-";
      $("kv-ver").textContent = info.dsh_version || "-";
      $("kv-home").textContent = info.dsh_home || "-";
      $("dshp-title-dot").className = "dot " + (ready ? "running" : "");
      bar.title = t("dshBackend") + " " + (info.state || "-") + (info.port ? " · " + t("port") + " " + info.port : "") + (info.dsh_version ? " · v" + info.dsh_version : "");
      if (ready && !state.dshReady) {
        state.dshReady = true;
        discoverProvider();
        refreshBalance();
      }
    }).catch(function () {
      $("dshp-title-dot").className = "dot";
      bar.title = t("disconnected");
      state.dshReady = false;
    });
  }

  // ---------- Provider 发现 ----------
  function discoverProvider() {
    fetch("/api/host.describe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "dshp", method: "host.describe", payload: {} })
    }).then(function (r) { return r.json(); }).then(function (json) {
      var p = json && json.result && json.result.value && json.result.value.provider;
      if (p) {
        state.provider = p;
        if (p.indexOf("deepseek") === 0) $("a-provider-select").value = p;
        refreshBalance();
      }
    }).catch(function () {});
  }

  // ---------- 余额 ----------
  function setBal(text, detail) {
    $("dshp-bal").querySelector(".label").textContent = t("balance") + " " + text;
    if (detail !== undefined) $("kv-bal").textContent = detail;
  }
  function refreshBalance() {
    var provider = state.providerManual && $("a-provider-select").value ? $("a-provider-select").value : state.provider;
    if (!provider) provider = "deepseek-official";
    api("/api/shell/quota", { provider: provider }).then(function (q) {
      if (q && q.error) { setBal("--", q.error); return; }
      var total = q.total_balance;
      if (total != null && total !== "") {
        var cur = q.currency ? q.currency + " " : "";
        setBal(cur + total, t('total') + ' ' + cur + total +
          (q.granted_balance != null ? ' · ' + t('granted') + ' ' + q.granted_balance : "") +
          (q.topped_up_balance != null ? ' · ' + t('topped') + ' ' + q.topped_up_balance : ""));
      } else {
        setBal("--", t("noData"));
      }
    }).catch(function (e) { setBal("--", t("queryFail") + e); });
  }

  // ---------- 日志 ----------
  function pollLogs() {
    api("/api/shell/logs?since=" + state.logsCursor, undefined, "GET").then(function (r) {
      var lines = r.lines || [];
      if (lines.length === 0) return;
      var box = $("dshp-logs");
      var frag = document.createDocumentFragment();
      for (var i = 0; i < lines.length; i++) {
        var L = lines[i];
        if (L.line.indexOf("DASHBOOT_MARKER") >= 0) continue; // 跳过启动噪音
        var div = document.createElement("div");
        div.className = "line" + (L.stream === "stderr" ? " err" : "") + (L.stream === "shell" ? " shell" : "");
        var ts = L.ts ? new Date(L.ts).toLocaleTimeString() : "";
        div.innerHTML = '<span class="ts">' + ts + '</span>' + escapeHtml(L.line);
        frag.appendChild(div);
        state.logsBuffer.push(L);
        var id = L.id != null ? L.id : null;
        if (id != null && id > state.logsCursor) state.logsCursor = id;
      }
      box.appendChild(frag);
      while (box.children.length > 3000) box.removeChild(box.firstChild);
      $("dshp-log-count").textContent = state.logsBuffer.length;
      if (!state.logPaused) box.scrollTop = box.scrollHeight;
    }).catch(function () {});
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  async function exportLogs() {
    if (state.logsBuffer.length === 0) { setTip(t("noLogs")); return; }
    var content = state.logsBuffer.map(function (L) {
      var ts = L.ts ? new Date(L.ts).toISOString() : "";
      return "[" + ts + "] [" + L.stream + "] " + L.line;
    }).join("\n");
    try {
      var filename = "dsh-portable-logs-" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt";
      var handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: t("textFile"), accept: { "text/plain": [".txt"] } }]
      });
      var writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      setTip(t("exported") + state.logsBuffer.length + " " + t("items"));
    } catch (e) {
      if (e.name !== "AbortError") setTip(t("exportFailed") + e.message);
    }
  }
  function clearLogsView() { $("dshp-logs").innerHTML = ""; setTip(t("logCleared")); }
  function togglePauseLogs() {
    state.logPaused = !state.logPaused;
    $("a-logs-pause").textContent = state.logPaused ? t('resume') : t('pause');
  }

  // ---------- 编辑操作支持 ----------
  // 编辑/帮助菜单由自定义标题栏 HTML 下拉菜单处理。
  var lastFocus = null;
  document.addEventListener("focusin", function (e) {
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) lastFocus = t;
  });
  function doEdit(cmd) {
    try {
      if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus();
      document.execCommand(cmd, false, null);
    } catch (e) {}
  }
  // 暴露给壳原生菜单调用（menu.rs eval）
  window.__dshpEdit = doEdit;

  // ---------- 面板事件（全部 root 级 click 委托：抗 SPA 重渲染清掉元素导致 onclick 失效）----------
  function findEl(e, id) {
    var n = e.target;
    while (n && n !== document.body) {
      if (n.id === id) return n;
      n = n.parentElement;
    }
    return null;
  }
  function closeDropdowns() {}
  document.body.addEventListener("click", function (e) {
    var tab = e.target.closest(".tab");
    if (tab) {
      var key = tab.dataset.tab;
      panel.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("active", t === tab); });
      panel.querySelectorAll(".dshp-tab-pane").forEach(function (p) { p.classList.toggle("active", p.dataset.pane === key); });
      return;
    }
    var el;
    if ((el = findEl(e, "dshp-btn-toggle"))) {
      panel.classList.toggle("open"); if (panel.classList.contains("open")) refreshStatus();
    } else if ((el = findEl(e, "dshp-close"))) {
      panel.classList.remove("open");
    } else if ((el = findEl(e, "dshp-refresh-all"))) {
      refreshStatus(); refreshBalance(); pollLogs();
    } else if ((el = findEl(e, "dshp-bal"))) {
      refreshBalance();
    } else if ((el = findEl(e, "a-logs-export"))) { exportLogs();
    } else if ((el = findEl(e, "a-logs-clear"))) { clearLogsView();
    } else if ((el = findEl(e, "a-logs-pause"))) { togglePauseLogs();
    } else if ((el = findEl(e, "a-health"))) {
      setTip(t("healthRunning"));
      api("/api/shell/health").then(function (h) {
        setTip(t('healthResult') + (h.tcp_ok ? "✓" : "✗") + t('serviceReply') + (h.handshake_ok ? "✓" : "✗") + " · " + h.latency_ms + "ms (" + h.detail + ")");
      }).catch(function (err) { setTip(t("healthFailed") + err); });
    } else if ((el = findEl(e, "a-restart"))) {
      if (!confirm(t("confirmRestart"))) return;
      setTip(t("restarting"));
      api("/api/shell/restart").then(function (r) {
        if (r.ok) { setTip(t('restarted') + r.port); state.dshReady = false; setTimeout(refreshStatus, 800); setTimeout(discoverProvider, 1500); }
        else { setTip(t("restartFailed") + (r.error || "")); }
      }).catch(function (err) { setTip(t("restartFailed") + err); });
    } else if ((el = findEl(e, "a-update-check"))) {
      setTip(t("checkingUpdate"));
      api("/api/shell/update-check").then(function (r) {
        $("kv-ver").textContent = r.current;
        state.latest = r.latest;
        $("a-update-apply").disabled = !r.has_update;
        setTip(r.error ? t("checkFailed") + r.error : (r.has_update ? t('newVersion') + r.latest : t('latest')));
      }).catch(function (err) { setTip(t("checkFailed") + err); });
    } else if ((el = findEl(e, "a-update-apply"))) {
      if (!state.latest) return;
      if (!confirm(t('confirmUpdate') + state.latest + t('updateNote'))) return;
      setTip(t('updating'));
      api("/api/shell/update-apply", {}).then(function (r) {
        if (r && r.ok) { setTip(t('updateStarted')); }
        else { setTip(t('checkFailed') + ((r && r.error) || '')); }
      }).catch(function (err) { setTip(t('checkFailed') + err); });
    } else if ((el = findEl(e, "a-provider-apply"))) {
      var sel = $("a-provider-select");
      var v = sel ? sel.value : "";
      if (!v) { setTip(t("selectProvider")); return; }
      state.providerManual = true;
      state.provider = v;
      refreshBalance();
    }
  });

  // ---------- 定时 ----------
  refreshStatus();
  setInterval(refreshStatus, 8000);
  setInterval(refreshBalance, 600000);
  setInterval(pollLogs, 1200);
  setInterval(discoverProvider, 30000);

  // 语言变化检测：定期检查设置，变化时更新 UI 文字（不刷新页面）
  function checkLang() {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", BASE + "/api/shell/settings", true);
      xhr.timeout = 2000;
      xhr.onload = function () {
        if (xhr.status === 200) {
          try {
            var s = JSON.parse(xhr.responseText);
            if (s && s.locale && s.locale !== lang) {
              lang = s.locale;
              updateUI();
              refreshBalance(); // 余额文字需要重新获取
            }
          } catch (e) {}
        }
      };
      xhr.send();
    } catch (e) {}
  }
  function updateUI() {
    // 菜单按钮
    var editBtn = menusDiv.querySelector('[data-menu="edit"]');
    var helpBtn = menusDiv.querySelector('[data-menu="help"]');
    if (editBtn) editBtn.textContent = t("edit");
    if (helpBtn) helpBtn.textContent = t("help");
    // 编辑下拉菜单项
    if (editMenu) {
      var editLabels = [t("undo"), t("redo"), null, t("cut"), t("copy"), t("paste")];
      var editDdItems = editMenu.dd.querySelectorAll(".dshp-dropdown-item");
      var idx = 0;
      for (var ei = 0; ei < editDdItems.length && idx < editLabels.length; idx++) {
        if (editLabels[idx] === null) { idx++; }
        var span = editDdItems[ei].querySelector("span:first-child");
        if (span) span.textContent = editLabels[idx];
        ei++;
      }
    }
    // 帮助下拉菜单项
    if (helpMenu) {
      var helpLabels = [t("devtools"), null, t("viewGithub"), t("docs"), t("plugins"), t("cordis")];
      var helpDdItems = helpMenu.dd.querySelectorAll(".dshp-dropdown-item");
      var hi = 0;
      for (var hj = 0; hj < helpDdItems.length && hi < helpLabels.length; hi++) {
        if (helpLabels[hi] === null) { hi++; }
        var hspan = helpDdItems[hj].querySelector("span:first-child");
        if (hspan) hspan.textContent = helpLabels[hi];
        hj++;
      }
    }
    // 窗口控制标题
    btnMin.title = t("min");
    btnMax.title = t("max");
    btnClose.title = t("close");
    // 余额按钮
    if (bal) bal.title = t('balance') + ' — ' + (lang === 'zh' ? '点击刷新' : 'Click to refresh');
    // 控制台按钮
    if (toggleBtn) {
      toggleBtn.title = t("dshBackend") + " " + t("console");
      var conSpan = toggleBtn.querySelector("span");
      if (conSpan) conSpan.textContent = t("console");
    }
    // 面板 Tab
    var tabs = panel ? panel.querySelectorAll(".tab") : [];
    if (tabs.length >= 3) {
      tabs[0].textContent = t("logs");
      tabs[1].textContent = t("ops");
      tabs[2].textContent = t("settings");
    }
    // 面板标题
    var headTitle = panel ? panel.querySelector("#dshp-head .title span:last-child") : null;
    if (headTitle) headTitle.textContent = t("console");
    // 面板内 KV 标签
    var kvLabels = panel ? panel.querySelectorAll("#dshp-kv dt") : [];
    var kvKeys = ["status", "pid", "port", "version", null, "balance"];
    for (var i = 0; i < kvLabels.length && i < kvKeys.length; i++) {
      if (kvKeys[i]) kvLabels[i].textContent = t(kvKeys[i]);
    }
    // 操作区按钮
    var btns = panel ? panel.querySelectorAll("#dshp-actions button") : [];
    var btnKeys = ["healthCheck", "restart", "checkUpdate", "updateTo"];
    for (var j = 0; j < btns.length && j < btnKeys.length; j++) {
      btns[j].textContent = t(btnKeys[j]);
    }
    // 提示文本
    var tips = panel ? panel.querySelectorAll("#dshp-tip") : [];
    if (tips.length > 0) tips[0].textContent = t("healthTip");
    if (tips.length > 1) tips[1].textContent = t("settingsTip");
    // 日志工具栏
    var logLabel = panel ? panel.querySelector("#dshp-logs-toolbar .label") : null;
    if (logLabel) logLabel.innerHTML = t("realtimeLog") + '（<span id="dshp-log-count">0</span> ' + t("items") + '）';
    var logBtns = panel ? panel.querySelectorAll("#dshp-logs-toolbar button") : [];
    if (logBtns.length >= 3) {
      logBtns[0].textContent = t("export");
      logBtns[0].title = t("export");
      logBtns[1].textContent = t("clear");
      logBtns[1].title = t("clear");
      logBtns[2].textContent = state.logPaused ? t("resume") : t("pause");
    }
  }
  setInterval(checkLang, 2000);

  // 抗 dsh 路由变化（history.pushState 切换会卸载当前组件树，可能影响注入 UI）
  window.addEventListener("popstate", function () {
    setTimeout(function () {
      if (!document.getElementById("dshp-root")) {
        location.reload(); // 最稳：直接刷新页面让壳重新注入
      }
    }, 500);
  });
})();