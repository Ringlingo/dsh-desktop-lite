//! dsh-portable Tauri 壳：启动编排（spawn dsh web → 就绪 → 导航窗口）、
//! 托盘常驻（F-03）、退出清理（R3）、日志转发、命令注册、单实例。
//!
//! 后端进程管理为纯 std 同步实现（process.rs），启动/日志转发均用 std 线程，
//! 避免 tauri async_runtime 下 tokio time/process 驱动不可靠的问题。

use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use crate::app::AppState;

mod app;
mod error;
mod job;
mod menu;
mod process;
mod quota;
mod readyline;
mod rpc;
mod shell_bridge;
mod shell_ui;
mod startup_check;
mod tray;
mod update;
mod version;
mod window;

/// 全局日志发送器：debug_log 将消息推入壳桥日志缓冲区，控制台面板可查看。
static LOG_SENDER: std::sync::OnceLock<std::sync::mpsc::Sender<process::LogLine>> = std::sync::OnceLock::new();

/// 初始化全局日志通道（由 BackendProcess::new 调用）。
pub fn init_log_sender(tx: std::sync::mpsc::Sender<process::LogLine>) {
    let _ = LOG_SENDER.set(tx);
}

/// 便携应用根目录：exe 所在目录（绿色目录布局：exe 与 runtime/data 同级）。
fn portable_root() -> PathBuf {
    if let Ok(root) = std::env::var("DSH_PORTABLE_ROOT") {
        if !root.is_empty() {
            return PathBuf::from(root);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 调试日志：写入 `<应用根>/data/logs/shell-debug.log` + 推入壳桥日志缓冲区。
///
/// 8-19 基线这里写死了一个开发机绝对路径，
/// 导致换机后日志落到别的盘、事后无法排障。已改为始终跟随 `portable_root()`。
pub fn debug_log(msg: &str) {
    let dir = portable_root().join("data").join("logs");
    let _ = std::fs::create_dir_all(&dir);
    use std::io::Write;
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("shell-debug.log"))
        .and_then(|mut f| writeln!(f, "{msg}"));
    // 推入壳桥日志缓冲区
    if let Some(tx) = LOG_SENDER.get() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .ok();
        let _ = tx.send(process::LogLine {
            stream: "shell".to_string(),
            line: msg.to_string(),
            ts,
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // R9：panic hook 兜底，避免裸崩溃黑屏。
    std::panic::set_hook(Box::new(|info| {
        debug_log(&format!("panic: {info}"));
    }));

    let root = portable_root();
    let app_state = AppState::init(&root).expect("AppState 初始化失败：请检查 runtime 完整性");
    let backend_for_exit = app_state.backend.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二个实例：聚焦已有主窗口。
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            rpc::backend_start,
            rpc::backend_status,
            rpc::backend_stop,
            rpc::backend_restart,
            rpc::backend_logs_tail,
            rpc::devtools_toggle,
            rpc::update_check,
            rpc::update_apply,
            rpc::quota_get,
            rpc::quota_configure_minimax,
            rpc::quota_minimax_status,
            rpc::backend_health,
            rpc::debug_open,
        ])
        .setup(|app| {
            // 自定义标题栏：注册 app handle 给窗口控制模块（最小化/最大化/关闭）。
            window::install(app.handle());

            // 托盘（F-03）。
            if let Err(e) = tray::create_tray(app.handle()) {
                debug_log(&format!("Tray creation failed: {e}"));
            }

            // 壳 HTTP 桥（注入脚本数据通道，纯 std）。
            let backend = app.state::<AppState>().backend.clone();
            let bridge_port = shell_bridge::start(backend, portable_root());
            debug_log(&format!("Shell bridge port: {bridge_port}"));

            // 日志流 → 前端事件（F-08）：std 线程消费 mpsc，emit 线程安全。
            let app_handle = app.handle().clone();
            let backend = app.state::<AppState>().backend.clone();
            let log_rx = backend.subscribe_logs();
            std::thread::spawn(move || {
                while let Ok(line) = log_rx.recv() {
                    let payload = serde_json::to_string(&line).unwrap_or_default();
                    let _ = app_handle.emit("log://line", payload);
                }
            });

            // 自动启动后端并导航（F-01）：std 线程（后端 start 为同步实现）。
            let app_handle = app.handle().clone();
            let backend = app.state::<AppState>().backend.clone();
            std::thread::spawn(move || {
                match backend_start_and_navigate(&app_handle, &backend, bridge_port) {
                    Ok(()) => {}
                    Err(e) => {
                        debug_log(&format!("Startup failed: {e}"));
                        let _ = app_handle.emit("backend://error", e.to_string());
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // F-03/Q3：关窗最小化到托盘（不退出，后端继续运行）。
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            // R3：退出时清理后端进程树（同步 stop）。
            if let tauri::RunEvent::Exit = event {
                debug_log("Exit: cleaning up backend process tree");
                backend_for_exit.stop();
            }
        });
}

fn backend_start_and_navigate(
    app: &AppHandle,
    backend: &std::sync::Arc<process::BackendProcess>,
    bridge_port: u16,
) -> Result<(), error::AppError> {
    let root = portable_root();

    // ── 数据层自检：**在 spawn 之前**跑；不健康就不拉起后端 ──────────────────
    // 设计取向：与其让用户面对"卡在加载页"，不如明确告知原因。
    // 自检脚本编译期内嵌（scripts/startup-selfcheck.mjs），写不出时 fail-open 回落磁盘副本。
    let check = startup_check::run(&root)?;
    if !check.ok {
        let msg = format!(
            "数据层自检未通过：{}。报告：{}",
            check.summary,
            root.join("data")
                .join("logs")
                .join("startup-selfcheck.txt")
                .display()
        );
        debug_log(&format!("[selfcheck] 阻断启动：{}", check.summary));
        // 在加载页上把原因显示出来（自包含 eval，不依赖前端注入是否已完成）
        if let Some(win) = app.get_webview_window("main") {
            let lit = serde_json::to_string(&msg)
                .unwrap_or_else(|_| "\"(数据层自检未通过)\"".to_string());
            let js = format!(
                "try{{var d=document.createElement('pre');\
                 d.style.cssText='position:fixed;left:0;right:0;bottom:0;max-height:45%;overflow:auto;background:#7f1d1d;color:#fff;font:12px/1.6 monospace;padding:10px;z-index:99999;white-space:pre-wrap';\
                 d.textContent={lit};document.body.appendChild(d)}}catch(e){{}}"
            );
            let _ = win.eval(js);
        }
        return Err(error::AppError::new(error::AppErrorCode::RuntimeMissing, msg));
    }

    let cfg = BackendSpawnConfig::from_root(&root)?;
    // 超时 300s（原 90s）：**首次在"新路径"上启动时**，dsh 必须重写整份镜像
    // （路径变化会让 proxy 条目里的绝对 file:// 目标失效 ⇒ heal 全量重建；
    //   实测解压后首次启动会走这条路径）。90s 在慢盘上会误报 READY_TIMEOUT。
    let (_, url) = backend.start(&cfg, 300)?;
    // 导航 + 补注入合成一个入口（window::navigate_and_inject）：
    // 「更新/重启后端」之后也走同一份实现 —— dsh 每次启动端口会变，
    // 不重新导航页面会一直停在"重新连接中"。
    window::navigate_and_inject(app, &url, bridge_port);
    Ok(())
}

use crate::process::BackendSpawnConfig;

// re-export for main.rs
pub use error::{AppError, AppErrorCode, AppResult};
