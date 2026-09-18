//! 后端进程管理（纯 std 同步实现——实测 tauri async_runtime 下 tokio process/time
//! 驱动不可靠，子进程等待与就绪超时全部改用 std 线程 + Condvar + mpsc）。
//!
//! 职责：spawn runtime node + dsh web --port 0，注入 DSH_HOME，接管 stdout/stderr，
//! Job Object 兜底清理（R3），提供 start/stop/restart/status。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use crate::error::{AppError, AppErrorCode, AppResult};
use crate::readyline::{parse_ready_line, ReadyLineParser};

/// 后端状态机（对齐绘世启动器 idle/starting/running 三态 + error）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendState {
    Idle,
    Starting,
    Running,
    Error,
}

/// 后端运行时信息（F-10 调试面板）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProcessInfo {
    pub pid: Option<u32>,
    pub state: BackendState,
    pub port: Option<u16>,
    pub url: Option<String>,
    pub started_at_unix_ms: Option<u64>,
    pub dsh_home: String,
    pub runtime_node: String,
    pub dsh_version: String,
}

/// 日志行（F-08）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LogLine {
    pub stream: String, // "stdout" | "stderr"
    pub line: String,
    /// 壳写入时的 Unix 时间戳（毫秒）。导出/排序/客户端游标兜底。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
}

/// 后端启动参数。
#[derive(Debug)]
pub struct BackendSpawnConfig {
    pub node_exe: PathBuf,
    pub dsh_bin: PathBuf,
    pub dsh_home: PathBuf,
    pub data_dir: PathBuf,
}

impl BackendSpawnConfig {
    /// 从应用根目录推导：`<root>/runtime/node/node.exe` 与
    /// `<root>/runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`。
    pub fn from_root(root: &std::path::Path) -> AppResult<Self> {
        let node_exe = root.join("runtime").join("node").join("node.exe");
        let dsh_bin = root
            .join("runtime")
            .join("dsh")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js");
        for p in [&node_exe, &dsh_bin] {
            if !p.is_file() {
                return Err(AppError::new(
                    AppErrorCode::RuntimeMissing,
                    format!("runtime 文件缺失: {}", p.display()),
                ));
            }
        }
        let dsh_home = root.join("data");
        Ok(Self { node_exe, dsh_bin, dsh_home: dsh_home.clone(), data_dir: dsh_home })
    }
}

/// 后端进程句柄 + 共享状态（全部 std 同步原语，可在任意线程使用）。
pub struct BackendProcess {
    child: Mutex<Option<Child>>,
    state: Mutex<BackendState>,
    info: Mutex<ProcessInfo>,
    ready: Mutex<Option<AppResult<(u16, String)>>>,
    ready_cv: Condvar,
    log_buffer: Mutex<VecDeque<LogLine>>,
    log_tx: Mutex<Option<mpsc::Sender<LogLine>>>,
    stopping: AtomicBool,
}

impl BackendProcess {
    pub fn new(dsh_version: String, dsh_home: String, runtime_node: String) -> Arc<Self> {
        // 创建全局日志通道：sender 给 debug_log，receiver 由本实例消费推入 ring buffer。
        let (global_tx, global_rx) = mpsc::channel::<LogLine>();
        crate::init_log_sender(global_tx);

        let arc = Arc::new(Self {
            child: Mutex::new(None),
            state: Mutex::new(BackendState::Idle),
            info: Mutex::new(ProcessInfo {
                pid: None,
                state: BackendState::Idle,
                port: None,
                url: None,
                started_at_unix_ms: None,
                dsh_home,
                runtime_node,
                dsh_version,
            }),
            ready: Mutex::new(None),
            ready_cv: Condvar::new(),
            log_buffer: Mutex::new(VecDeque::new()),
            log_tx: Mutex::new(None),
            stopping: AtomicBool::new(false),
        });

        // 消费全局日志，推入 ring buffer + 转发给订阅者。
        let backend = arc.clone();
        std::thread::spawn(move || {
            while let Ok(line) = global_rx.recv() {
                {
                    let mut buf = backend.log_buffer.lock().unwrap();
                    buf.push_back(line.clone());
                    while buf.len() > 5000 {
                        buf.pop_front();
                    }
                }
                if let Some(tx) = backend.log_tx.lock().unwrap().as_ref() {
                    let _ = tx.send(line);
                }
            }
        });

        arc
    }

    /// 订阅日志流：创建新的 mpsc 通道（单消费者；lib.rs 转发线程使用一次）。
    pub fn subscribe_logs(&self) -> mpsc::Receiver<LogLine> {
        let (tx, rx) = mpsc::channel::<LogLine>();
        *self.log_tx.lock().unwrap() = Some(tx);
        rx
    }

    pub fn log_history(&self, count: usize) -> Vec<LogLine> {
        let buf = self.log_buffer.lock().unwrap();
        let skip = buf.len().saturating_sub(count);
        buf.iter().skip(skip).cloned().collect()
    }

    pub fn state(&self) -> BackendState {
        *self.state.lock().unwrap()
    }

    pub fn info(&self) -> ProcessInfo {
        self.info.lock().unwrap().clone()
    }

    fn push_log(&self, stream: &str, line: String) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .ok();
        {
            let mut buf = self.log_buffer.lock().unwrap();
            buf.push_back(LogLine { stream: stream.to_string(), line: line.clone(), ts });
            while buf.len() > 5000 {
                buf.pop_front();
            }
        }
        if let Some(tx) = self.log_tx.lock().unwrap().as_ref() {
            let _ = tx.send(LogLine { stream: stream.to_string(), line, ts });
        }
    }

    /// 启动后端并等待就绪（同步；Condvar 等待，超时 timeout_secs 秒）。
    pub fn start(self: &Arc<Self>, cfg: &BackendSpawnConfig, timeout_secs: u64) -> AppResult<(u16, String)> {
        crate::debug_log("start(): entered");
        {
            let mut guard = self.child.lock().unwrap();
            if guard.is_some() {
                return Err(AppError::new(AppErrorCode::InvalidState, "后端已在运行"));
            }
        }
        self.stopping.store(false, Ordering::SeqCst);
        *self.state.lock().unwrap() = BackendState::Starting;

        if let Err(e) = std::fs::create_dir_all(&cfg.dsh_home) {
            *self.state.lock().unwrap() = BackendState::Error;
            return Err(AppError::new(
                AppErrorCode::DataDirUnusable,
                format!("无法创建数据目录 {}: {e}", cfg.dsh_home.display()),
            ));
        }

        // current_dir 必须是 runtime/dsh/（node_modules 所在层），否则 Node 找不到 sharp 等 native 模块。
        let dsh_dir = cfg
            .dsh_bin
            .ancestors()
            .find(|p| p.join("node_modules").is_dir())
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        crate::debug_log(&format!("spawn: cwd={}, node={}", dsh_dir.display(), cfg.node_exe.display()));
        // 直接 spawn node（跳过 bash 中转；bash 中转会导致 sharp 等 native 模块加载失败）。
        let mut cmd = Command::new(&cfg.node_exe);
        cmd.current_dir(&dsh_dir)
            .arg(&cfg.dsh_bin)
            .arg("web")
            .arg("--port")
            .arg("0")
            // 阻止 dsh 自行拉起系统默认浏览器 —— 窗口由壳自己导航
            // （8-19 基线缺这个参数，实测每启动一次就弹一个浏览器页）
            .arg("--no-open")
            .env("DSH_HOME", &cfg.dsh_home)
            .env_remove("NODE_OPTIONS")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        // 注入运行时 PATH（root 从 DSH_HOME 的父目录推导：DSH_HOME = <root>/data）
        if let Some(root) = cfg.dsh_home.parent() {
            inject_runtime_path(&mut cmd, root);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                *self.state.lock().unwrap() = BackendState::Error;
                return Err(AppError::new(
                    AppErrorCode::SpawnFailed,
                    format!("spawn node 失败: {e}"),
                ));
            }
        };

        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // Job Object 兜底（R3）：壳进程死亡（含强杀）时由 OS 自动终止整棵后端进程树。
        // （2026-09-15 曾为诊断 EPERM 临时停用；已确认 EPERM 与 Job 无关，故还原。）
        #[cfg(windows)]
        unsafe {
            let _ = crate::job::assign_current_job(pid);
        }
        let _ = pid;

        *self.child.lock().unwrap() = Some(child);
        {
            let mut info = self.info.lock().unwrap();
            info.pid = Some(pid);
            info.state = BackendState::Starting;
            info.started_at_unix_ms = Some(now_unix_ms());
        }
        *self.ready.lock().unwrap() = None;

        // stdout 读取线程：就绪行解析 + 日志。
        let backend = self.clone();
        std::thread::spawn(move || {
            let mut parser = ReadyLineParser::new();
            if let Some(out) = stdout {
                let reader = BufReader::new(out);
                for line in reader.lines().map_while(Result::ok) {
                    if backend.stopping.load(Ordering::SeqCst) {
                        break;
                    }
                    crate::debug_log(&format!("[dsh:out] {line}"));
                    backend.push_log("stdout", line.clone());
                    if let Ok(Some(found)) = parse_ready_line(&line) {
                        let (port, url) = found;
                        {
                            let mut info = backend.info.lock().unwrap();
                            info.port = Some(port);
                            info.url = Some(url.clone());
                        }
                        {
                            let mut r = backend.ready.lock().unwrap();
                            *r = Some(Ok((port, url)));
                            backend.ready_cv.notify_all();
                        }
                    }
                }
                // 流结束但未就绪：报错（除非正在停止）。
                let mut r = backend.ready.lock().unwrap();
                if r.is_none() && !backend.stopping.load(Ordering::SeqCst) {
                    *r = Some(Err(AppError::new(
                        AppErrorCode::SpawnFailed,
                        "后端进程意外退出，未输出就绪信号",
                    )));
                    backend.ready_cv.notify_all();
                }
            }
        });

        // stderr 读取线程。
        let backend = self.clone();
        std::thread::spawn(move || {
            if let Some(err) = stderr {
                let reader = BufReader::new(err);
                for line in reader.lines().map_while(Result::ok) {
                    if backend.stopping.load(Ordering::SeqCst) {
                        break;
                    }
                    crate::debug_log(&format!("[dsh:err] {line}"));
                    backend.push_log("stderr", line);
                }
            }
        });

        // 等待就绪或超时（Condvar wait_timeout，不依赖 tokio time）。
        crate::debug_log("start(): waiting for ready line...");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
        let result = loop {
            {
                let guard = self.ready.lock().unwrap();
                if let Some(r) = guard.as_ref() {
                    break r.clone();
                }
            }
            if std::time::Instant::now() >= deadline {
                break Err(AppError::new(
                    AppErrorCode::ReadyTimeout,
                    format!("后端 {timeout_secs}s 内未就绪"),
                ));
            }
            let guard = self.ready.lock().unwrap();
            let (g, _) = self.ready_cv.wait_timeout(guard, std::time::Duration::from_millis(200)).unwrap();
            drop(g);
        };
        crate::debug_log("start(): wait finished");

        match &result {
            Ok((_, url)) => {
                *self.state.lock().unwrap() = BackendState::Running;
                let mut info = self.info.lock().unwrap();
                info.state = BackendState::Running;
                info.url = Some(url.clone());
                Ok(result.unwrap())
            }
            Err(e) => {
                *self.state.lock().unwrap() = BackendState::Error;
                self.stop_inner();
                Err(e.clone())
            }
        }
    }

    /// 停止后端并清理子进程树（同步）。
    pub fn stop(&self) {
        self.stop_inner();
    }

    fn stop_inner(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let mut guard = self.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            let pid = child.id();
            kill_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
        {
            let mut info = self.info.lock().unwrap();
            info.pid = None;
            info.port = None;
            info.url = None;
            info.state = BackendState::Idle;
        }
        {
            let mut r = self.ready.lock().unwrap();
            *r = None;
        }
    }
}

/// 往子进程 PATH 前插运行时目录（python / git / node），使其不依赖宿主机环境。
///
/// 9-11 的修复，8-19 基线里缺失；壳重编时补回。段顺序即优先级：
/// `runtime/python`、`runtime/git/cmd`、`runtime/git/mingw64/bin`、`runtime/node`。
fn inject_runtime_path(cmd: &mut Command, root: &std::path::Path) {
    let segs = [
        root.join("runtime").join("python"),
        root.join("runtime").join("git").join("cmd"),
        root.join("runtime").join("git").join("mingw64").join("bin"),
        root.join("runtime").join("node"),
    ];
    let present: Vec<String> = segs
        .iter()
        .filter(|p| p.is_dir())
        .map(|p| p.display().to_string())
        .collect();
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut parts = present.clone();
    if let Ok(existing) = std::env::var("PATH") {
        if !existing.is_empty() {
            parts.push(existing);
        }
    }
    cmd.env("PATH", parts.join(&sep.to_string()));
    crate::debug_log(&format!("spawn: 注入 PATH {} 段", present.len()));
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 查找 Git Bash（避免解析到 WSL bash，后者无法执行 Windows 路径）。
#[cfg(windows)]
fn find_git_bash() -> String {
    let candidates = [
        "D:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ];
    for p in &candidates {
        if std::path::Path::new(p).is_file() {
            return p.to_string();
        }
    }
    // 回退：从 PATH 中排除 WSL bash，找 Git bash
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(';') {
            let trimmed = dir.trim();
            if trimmed.is_empty() || trimmed.contains("WindowsApps") {
                continue;
            }
            let candidate = std::path::Path::new(trimmed).join("bash.exe");
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }
    "bash".to_string()
}

#[cfg(not(windows))]
fn find_git_bash() -> String {
    "bash".to_string()
}

/// Windows: taskkill /T 按 PID 终止进程树。
#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .status();
}

#[cfg(not(windows))]
fn kill_tree(_pid: u32) {
    // Unix: 交给 child.kill()。
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_starts_idle() {
        let p = BackendProcess::new("0.1.0-rc.6".into(), "d:/data".into(), "node".into());
        assert_eq!(p.state(), BackendState::Idle);
    }

    #[test]
    fn info_defaults_are_sane() {
        let p = BackendProcess::new("0.1.0-rc.6".into(), "d:/data".into(), "node.exe".into());
        let info = p.info();
        assert_eq!(info.dsh_version, "0.1.0-rc.6");
        assert!(info.pid.is_none());
        assert_eq!(info.state, BackendState::Idle);
    }

    #[test]
    fn missing_runtime_is_error() {
        let cfg = BackendSpawnConfig::from_root(std::path::Path::new("D:/不存在/路径"));
        assert!(cfg.is_err());
        let err = cfg.unwrap_err();
        assert_eq!(err.code, AppErrorCode::RuntimeMissing);
    }

    #[test]
    fn log_history_roundtrip() {
        let p = BackendProcess::new("v".into(), "d".into(), "n".into());
        p.push_log("stdout", "hello".into());
        p.push_log("stderr", "world".into());
        let hist = p.log_history(10);
        assert_eq!(hist.len(), 2);
        assert_eq!(hist[0].line, "hello");
        assert_eq!(hist[1].stream, "stderr");
    }
}
