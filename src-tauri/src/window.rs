//! 窗口控制（最小化 / 最大化 / 关闭）——自定义标题栏用。
//! 通过 `app.handle()` 获取主窗口句柄，避免依赖 Tauri State。

use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn install(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
}

pub fn get_app_handle() -> Option<&'static AppHandle> {
    APP_HANDLE.get()
}

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main")
}

/// 导航主窗口到指定 URL，并在随后几秒内**重复注入壳 UI**。
///
/// 为什么必须和注入绑在一起：页面重新加载会**丢掉注入脚本**（标题栏、控制台面板、
/// 进度条都在注入脚本里），所以启动路径原本也在导航后补注入 3 次（2s/5s/9s）。
/// 「更新到最新版 / 重启后端」之后同样要重新导航（dsh 每次启动端口会变，
/// 旧端口页面会一直显示"重新连接中"），因此这里把两件事合成一个可复用入口。
pub fn navigate_and_inject(app: &AppHandle, url: &str, bridge_port: u16) {
    crate::debug_log(&format!("[nav] Navigating to {url}"));
    let Some(win) = app.get_webview_window("main") else {
        crate::debug_log("[nav] get_webview_window(\"main\") 返回 None");
        return;
    };
    let parsed: tauri::Url = match url.parse() {
        Ok(u) => u,
        Err(e) => {
            crate::debug_log(&format!("[nav] URL 解析失败: {e}"));
            return;
        }
    };
    match win.navigate(parsed.clone()) {
        Ok(_) => crate::debug_log(&format!("[nav] Navigate success: {parsed}")),
        Err(e) => crate::debug_log(&format!("[nav] Navigate failed: {e}")),
    }
    let app_clone = app.clone();
    std::thread::spawn(move || {
        for delay_ms in [2000u64, 5000, 9000] {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            crate::shell_ui::inject(&app_clone, bridge_port);
        }
    });
}

pub fn minimize() {
    if let Some(app) = APP_HANDLE.get() {
        if let Some(w) = main_window(app) {
            let _ = w.minimize();
        }
    }
}

pub fn toggle_maximize() -> bool {
    if let Some(app) = APP_HANDLE.get() {
        if let Some(w) = main_window(app) {
            let is_max = w.is_maximized().unwrap_or(false);
            let r = if is_max {
                w.unmaximize()
            } else {
                w.maximize()
            };
            let _ = r;
            return !is_max;
        }
    }
    false
}

pub fn close() {
    if let Some(app) = APP_HANDLE.get() {
        if let Some(w) = main_window(app) {
            let _ = w.close();
        }
    }
}