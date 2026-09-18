//! 壳本地 HTTP 桥：为注入到 dsh 页面的壳 UI 提供数据通道（fetch）。
//! 纯 std 实现（TcpListener + 线程），不依赖 tokio/tauri runtime。
//! 所有响应带 CORS `*`，注入脚本跨源 fetch 可达。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use crate::error::{AppError, AppErrorCode, AppResult};
use crate::process::{BackendProcess, BackendSpawnConfig};
use tauri::Manager;

/// 壳桥固定端口候选：splash 页硬编码探测（DSH_SHELL_PORT 未注入时兜底）。
/// 若全部被占用，回退到随机端口（注入脚本仍通过 DSH_SHELL_PORT 拿真实端口）。
pub const BRIDGE_PORT_CANDIDATES: [u16; 3] = [47563, 47564, 47565];

/// 启动 HTTP 桥，返回实际监听端口。
pub fn start(backend: Arc<BackendProcess>, root: PathBuf) -> u16 {
    // 优先固定端口（splash 可提前探测），被占用则随机。
    let listener: TcpListener = match BRIDGE_PORT_CANDIDATES
        .iter()
        .find_map(|&p| TcpListener::bind(("127.0.0.1", p)).ok())
        .or_else(|| TcpListener::bind("127.0.0.1:0").ok())
    {
        Some(l) => l,
        None => {
            crate::debug_log("HTTP bridge bind failed (no available port)");
            return 0;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    crate::debug_log(&format!("HTTP bridge listening 127.0.0.1:{port}"));
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let backend = backend.clone();
            let root = root.clone();
            std::thread::spawn(move || {
                let _ = handle(stream, &backend, &root);
            });
        }
    });
    port
}

fn handle(mut stream: TcpStream, backend: &Arc<BackendProcess>, root: &std::path::Path) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(10)))?;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if buf.len() > 65536 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let req = String::from_utf8_lossy(&buf).to_string();
    let mut lines = req.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_string();
    let path = parts.next().unwrap_or("/").to_string();
    let body_start = req.find("\r\n\r\n").map(|i| i + 4).unwrap_or(req.len());
    let body = req[body_start..].to_string();

    let (status, json) = route(&method, &path, &body, backend, root, stream.local_addr().map(|a| a.port()).unwrap_or(0));

    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        json.len(),
        json
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()?;
    Ok(())
}

fn json_ok(v: serde_json::Value) -> (String, String) {
    ("200 OK".to_string(), v.to_string())
}

fn json_err(msg: &str) -> (String, String) {
    (
        "200 OK".to_string(),
        serde_json::json!({ "error": msg }).to_string(),
    )
}

fn route(
    method: &str,
    path_with_query: &str,
    body: &str,
    backend: &Arc<BackendProcess>,
    root: &std::path::Path,
    bridge_port: u16,
) -> (String, String) {
    if method == "OPTIONS" {
        return ("204 No Content".to_string(), String::new());
    }
    // 拆分 path / query：内部路径分发用 path，参数解析用 query。
    let (path, query) = match path_with_query.split_once('?') {
        Some((p, q)) => (p, q),
        None => (path_with_query, ""),
    };
    let query_param = |name: &str| -> Option<String> {
        query
            .split('&')
            .find_map(|kv| kv.split_once('=').and_then(|(k, v)| if k == name { Some(v.to_string()) } else { None }))
    };
    match path {
        "/api/shell/status" => {
            let info = backend.info();
            json_ok(serde_json::json!({
                "pid": info.pid,
                "state": info.state,
                "port": info.port,
                "url": info.url,
                "started_at_unix_ms": info.started_at_unix_ms,
                "dsh_home": info.dsh_home,
                "runtime_node": info.runtime_node,
                "dsh_version": info.dsh_version,
            }))
        }
        "/api/shell/logs" => {
            // 支持 ?since=<id> 增量拉取（前端基于 cursor，不会丢/重）。
            let since: u64 = query_param("since").and_then(|s| s.parse().ok()).unwrap_or(0);
            let lines = backend.log_history(2000);
            let arr: Vec<serde_json::Value> = lines
                .iter()
                .enumerate()
                .map(|(i, l)| {
                    serde_json::json!({
                        "id": (i as u64) + 1,
                        "ts": l.ts,
                        "stream": l.stream,
                        "line": l.line,
                    })
                })
                .filter(|v| v["id"].as_u64().unwrap_or(0) > since)
                .collect();
            json_ok(serde_json::json!({ "lines": arr, "total": lines.len() }))
        }
        "/api/shell/health" => {
            let info = backend.info();
            match info.port {
                None => json_ok(serde_json::json!({
                    "tcp_ok": false, "handshake_ok": false, "latency_ms": 0, "detail": "后端未运行"
                })),
                Some(port) => {
                    let t0 = std::time::Instant::now();
                    let tcp_ok = std::net::TcpStream::connect(("127.0.0.1", port)).is_ok();
                    let mut handshake_ok = false;
                    if tcp_ok {
                        if let Ok(client) = reqwest::blocking::Client::builder().build() {
                            let body = r#"{"type":"client-request","rpcId":"shell","method":"host.describe","payload":{}}"#;
                            if let Ok(resp) = client
                                .post(format!("http://127.0.0.1:{port}/api/host.describe"))
                                .header("content-type", "application/json")
                                .body(body)
                                .timeout(std::time::Duration::from_secs(5))
                                .send()
                            {
                                handshake_ok = resp.status().is_success();
                            }
                        }
                    }
                    json_ok(serde_json::json!({
                        "tcp_ok": tcp_ok,
                        "handshake_ok": handshake_ok,
                        "latency_ms": t0.elapsed().as_millis() as u64,
                        "detail": format!("端口 {port}"),
                    }))
                }
            }
        }
        "/api/shell/restart" => {
            backend.stop();
            let cfg = BackendSpawnConfig::from_root(root);
            match cfg {
                Ok(cfg) => match backend.start(&cfg, 90) {
                    Ok((port, url)) => json_ok(serde_json::json!({ "ok": true, "port": port, "url": url })),
                    Err(e) => json_err(&e.to_string()),
                },
                Err(e) => json_err(&e.to_string()),
            }
        }
        "/api/shell/update-check" => {
            let info = backend.info();
            match crate::update::check_for_update(&info.dsh_version) {
                Ok(r) => json_ok(serde_json::json!({
                    "current": r.current, "latest": r.latest, "has_update": r.has_update, "error": r.error
                })),
                Err(e) => json_err(&e.to_string()),
            }
        }
        // 控制台「更新到最新版」：更新的是 **dsh 核心**（只替换 runtime/dsh，
        // node/python/git 运行时不动）。实现方式 = 调用随包携带的升级脚本
        // data/downloads/update-dsh.mjs —— 它自带：版本解析（GitHub tag → npm 回退）、
        // 暂存安装、启动兼容性预检、备份与回滚、数据层迁移。
        // 之所以不在壳里自己下载替换：厂商脚本头部明确警告「壳内实现会整个替换
        // runtime/，会连 node.exe 一起换掉，产物形态对不上就起不来」。
        // 脚本自己解析版本 ⇒ 本路由不需要 downloadUrl 参数。
        "/api/shell/update-apply" => {
            use std::io::{BufRead, BufReader};
            use std::os::windows::process::CommandExt;

            let root_owned = root.to_path_buf();
            let candidates = [
                root_owned.join("data").join("downloads").join("update-dsh.mjs"),
                root_owned.join("scripts").join("update-dsh.mjs"),
            ];
            let script = match candidates.iter().find(|p| p.exists()) {
                Some(p) => p.clone(),
                None => return json_err("找不到升级脚本：data/downloads/update-dsh.mjs"),
            };
            let node = root_owned.join("runtime").join("node").join("node.exe");
            if !node.exists() {
                return json_err("找不到内置 node：runtime/node/node.exe");
            }

            crate::debug_log(&format!("[update] 启动升级脚本 {}", script.display()));
            // script 会被 move 进下面的线程 ⇒ 先把回包要用的展示串取出来。
            let script_display = script.display().to_string();
            let node2 = node.clone();
            let root2 = root_owned.clone();
            std::thread::spawn(move || {
                let mut cmd = std::process::Command::new(&node2);
                cmd.arg(&script)
                    .arg("--root")
                    .arg(&root2)
                    .current_dir(&root2)
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
                match cmd.spawn() {
                    Ok(mut child) => {
                        if let Some(e) = child.stderr.take() {
                            std::thread::spawn(move || {
                                for l in BufReader::new(e).lines().map_while(Result::ok) {
                                    crate::debug_log(&format!("[update] {l}"));
                                }
                            });
                        }
                        if let Some(out) = child.stdout.take() {
                            for l in BufReader::new(out).lines().map_while(Result::ok) {
                                crate::debug_log(&format!("[update] {l}"));
                            }
                        }
                        let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                        crate::debug_log(&format!(
                            "[update] 结束（退出码 {code}）{}",
                            if code == 0 {
                                "。请点「重启后端」使新版本生效。"
                            } else {
                                "。升级未完成，详情见上方日志。"
                            }
                        ));
                    }
                    Err(e) => crate::debug_log(&format!("[update] 启动失败：{e}")),
                }
            });

            json_ok(serde_json::json!({
                "ok": true, "started": true, "script": script_display
            }))
        }
        "/api/shell/quota" => {
            // body: { "provider": "..." }
            let provider: String = serde_json::from_str(body)
                .ok()
                .and_then(|v: serde_json::Value| v["provider"].as_str().map(String::from))
                .unwrap_or_default();
            if provider.is_empty() {
                return json_err("缺少 provider");
            }
            let data_dir = root.join("data");
            let result = crate::rpc::fetch_balance_by_provider_pub(&provider, &data_dir);
            match result {
                Ok(mut view) => {
                    view.provider = provider;
                    json_ok(serde_json::json!(view))
                }
                Err(e) => json_ok(serde_json::json!({
                    "provider": provider, "error": e.to_string()
                })),
            }
        }
        "/api/shell/quota/configure-minimax" => {
            let key: String = serde_json::from_str(body)
                .ok()
                .and_then(|v: serde_json::Value| v["api_key"].as_str().map(String::from))
                .unwrap_or_default();
            if key.is_empty() {
                return json_err("缺少 api_key");
            }
            let data_dir = root.join("data");
            match crate::quota::write_api_key(&data_dir, "MINIMAX_CN_API_KEY", &key) {
                Ok(()) => json_ok(serde_json::json!({ "ok": true })),
                Err(e) => json_err(&e.to_string()),
            }
        }
        "/api/shell/quota/clear-minimax" => {
            let data_dir = root.join("data");
            match crate::quota::clear_api_key(&data_dir, "MINIMAX_CN_API_KEY") {
                Ok(()) => json_ok(serde_json::json!({ "ok": true })),
                Err(e) => json_err(&e.to_string()),
            }
        }
        "/api/shell/quota/minimax-status" => {
            let data_dir = root.join("data");
            match crate::quota::read_api_key(&data_dir, "MINIMAX_CN_API_KEY") {
                Ok(key) => json_ok(serde_json::json!({
                    "configured": true, "masked": crate::quota::mask_api_key(&key)
                })),
                Err(_) => json_ok(serde_json::json!({ "configured": false, "masked": "" })),
            }
        }
        "/api/shell/inject.js" => {
            let js = crate::shell_ui::inject_js_content();
            ("200 OK".to_string(), js)
        }
        "/api/shell/proxy-dsh" => {
            // 代理 DSH 页面，注入壳脚本 script 标签
            let dsh_port: u16 = query_param("port")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            if dsh_port == 0 {
                json_err("missing port parameter")
            } else {
                match proxy_dsh_page(dsh_port, bridge_port) {
                    Ok(html) => ("200 OK".to_string(), html),
                    Err(e) => json_err(&format!("proxy failed: {e}")),
                }
            }
        }
        "/api/shell/open-external" => {
            // 打开外部链接（系统浏览器）。
            let url: String = serde_json::from_str(body)
                .ok()
                .and_then(|v: serde_json::Value| v.get("url").and_then(|u| u.as_str()).map(String::from))
                .unwrap_or_default();
            if url.starts_with("http://") || url.starts_with("https://") {
                let _ = open::that(&url);
                json_ok(serde_json::json!({ "ok": true }))
            } else {
                json_err("无效 URL")
            }
        }
        "/api/shell/window/minimize" => {
            crate::window::minimize();
            json_ok(serde_json::json!({ "ok": true }))
        }
        "/api/shell/window/toggle-maximize" => {
            let max = crate::window::toggle_maximize();
            json_ok(serde_json::json!({ "ok": true, "maximized": max }))
        }
        "/api/shell/window/close" => {
            crate::window::close();
            json_ok(serde_json::json!({ "ok": true }))
        }
        "/api/shell/devtools" => {
            #[cfg(debug_assertions)]
            {
                if let Some(app) = crate::window::get_app_handle() {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.open_devtools();
                    }
                }
            }
            json_ok(serde_json::json!({ "ok": true }))
        }
        "/api/shell/settings" => {
            let settings_path = root.join("data").join("settings.yaml");
            let content = std::fs::read_to_string(&settings_path).unwrap_or_default();
            let locale = content.lines()
                .find(|l| l.trim_start().starts_with("locale:"))
                .and_then(|_| content.lines()
                    .skip_while(|l| !l.trim_start().starts_with("locale:"))
                    .nth(1)
                    .and_then(|l| l.split(':').nth(1))
                    .map(|s| s.trim().to_string()))
                .unwrap_or_else(|| "zh".to_string());
            json_ok(serde_json::json!({ "locale": locale }))
        }
        _ => json_err("未知路由"),
    }
}

/// 代理 DSH 页面：获取 HTML，注入壳脚本 script 标签，修复相对 URL。
fn proxy_dsh_page(dsh_port: u16, bridge_port: u16) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{dsh_port}/");
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client: {e}"))?;
    let resp = client.get(&url).send().map_err(|e| format!("fetch: {e}"))?;
    let mut html = resp.text().map_err(|e| format!("read: {e}"))?;

    let dsh_origin = format!("http://127.0.0.1:{dsh_port}");

    // 将相对 URL 替换为绝对 URL（确保资源从 DSH 后端加载）
    // src="/..." → src="http://127.0.0.1:PORT/..."
    // href="/..." → href="http://127.0.0.1:PORT/..."
    html = html.replace("src=\"/", &format!("src=\"{dsh_origin}/"));
    html = html.replace("href=\"/", &format!("href=\"{dsh_origin}/"));

    let inject_tag = format!(
        r#"<script>window.DSH_SHELL_PORT={bridge_port};</script><script src="http://127.0.0.1:{bridge_port}/api/shell/inject.js?t={dsh_port}"></script>"#
    );
    if let Some(pos) = html.find("</head>") {
        html.insert_str(pos, &inject_tag);
    } else if let Some(pos) = html.find("<body") {
        html.insert_str(pos, &inject_tag);
    } else {
        html = inject_tag + &html;
    }
    Ok(html)
}
