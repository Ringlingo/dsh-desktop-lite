//! 启动自检：在 spawn 后端**之前**跑一遍数据层健康检查。
//!
//! 与 9-14 首版的两点关键差别（本版为「代理目录」时代重写）：
//!
//! 1. **内嵌脚本已识别 dsh 托管的「代理目录」**（真实目录 + `package.json` 里的
//!    `dsh.moduleFallback.targets` + `entry-N.js`）。dsh 在 pkg 模式、或本包打了
//!    `DSH_MODULE_FALLBACK=proxy` 补丁时，用真实目录代替 junction 表达镜像条目；
//!    旧版自检把这些目录判为「物化」并移出、再由 dsh 全量重建 —— 净负收益
//!    （实测 411 条每次启动反复搬移，`_backup` 持续膨胀）。
//!
//! 2. **fail-open**：写不出内嵌脚本时（例如文件被设为只读），回落到磁盘上已有的那份
//!    并留痕，**而不是直接阻断启动**。旧版实测：只要 `data/downloads/startup-selfcheck.mjs`
//!    是只读的，应用就永远起不来 —— 这不合理。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::error::{AppError, AppErrorCode, AppResult};

/// 编译期内嵌的自检脚本。`include_str!` ⇒ 改脚本必须重编 —— 这是刻意的：
/// 壳与它执行的检查必须同源，否则会出现「壳以为在跑 A、其实跑的是 B」。
const SELFCHECK_JS: &str = include_str!("../../scripts/startup-selfcheck.mjs");

/// 自检结论。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SelfcheckOutcome {
    /// 数据层是否健康（壳据此决定要不要放行 spawn）。
    pub ok: bool,
    /// 供日志/加载页展示的一行摘要。
    pub summary: String,
    /// 实际执行的脚本路径。
    pub script: String,
    /// `embedded`（写成功）或 `existing-file`（写失败，回落使用磁盘副本）。
    pub script_source: String,
}

/// 从自检脚本的 stdout 里解析 `SC|result|<json>`。
///
/// 返回 `(ok, 一行摘要)`。找不到结果行时返回 `None`（调用方应视为不可放行）。
/// 纯函数，便于单测。
pub fn parse_selfcheck_stdout(stdout: &str) -> Option<(bool, String)> {
    let mut found = None;
    for line in stdout.lines() {
        let Some(rest) = line.strip_prefix("SC|result|") else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) else { continue };
        let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
        let n = |p: &str| v.pointer(p).and_then(|x| x.as_u64()).unwrap_or(0);
        let len = |p: &str| v.pointer(p).and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0);
        let mut s = format!(
            "物化 {}/移出 {} · 悬空 {}/清理 {} · 孤儿锁 {} · 链接重建 {} · manifest {} · 链接总数 {}",
            n("/materialized/found"),
            len("/materialized/moved"),
            n("/dangling/found"),
            len("/dangling/removed"),
            n("/locks/removed"),
            len("/aliases/rebuilt"),
            len("/manifest/fixed"),
            n("/linksTotal"),
        );
        // 兼容两种字段形状：嵌套 {managedProxy:{found}} 与扁平 managedProxyFound
        let managed = v
            .pointer("/managedProxy/found")
            .and_then(|x| x.as_u64())
            .or_else(|| v.get("managedProxyFound").and_then(|x| x.as_u64()));
        if let Some(m) = managed {
            if m > 0 {
                s.push_str(&format!(" · 代理目录 {m}"));
            }
        }
        let bad = len("/unrepairable");
        if bad > 0 {
            s.push_str(&format!(" · ⚠ 无法修复 {bad} 项"));
        }
        found = Some((ok, s));
    }
    found
}

/// 只读属性会让 `fs::write` 以 `拒绝访问` (os error 5) 失败 —— 清掉它再试一次。
fn clear_readonly(p: &Path) -> bool {
    match std::fs::metadata(p) {
        Ok(m) => {
            let mut perm = m.permissions();
            if perm.readonly() {
                perm.set_readonly(false);
                std::fs::set_permissions(p, perm).is_ok()
            } else {
                true
            }
        }
        Err(_) => false,
    }
}

/// 把内嵌脚本写到目标路径；失败时**回落**到磁盘上已有的那份（fail-open）。
fn materialize_script(target: &Path) -> (PathBuf, &'static str) {
    if let Some(dir) = target.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::write(target, SELFCHECK_JS).is_ok() {
        return (target.to_path_buf(), "embedded");
    }
    crate::debug_log("[selfcheck] 写入自检脚本失败：改为尝试清只读后重写");
    if clear_readonly(target) && std::fs::write(target, SELFCHECK_JS).is_ok() {
        crate::debug_log("[selfcheck] 清只读后写入成功");
        return (target.to_path_buf(), "embedded");
    }
    crate::debug_log("[selfcheck] 仍写不进去：回落到磁盘上已有的一份（fail-open）");
    (target.to_path_buf(), "existing-file")
}

/// 跑一次启动自检。
///
/// - 脚本既写不进去、磁盘上也没有 → `Err`（调用方应阻断，因为无从判断）
/// - 能跑但结果 `ok=false` → 返回 `Ok(outcome)` 且 `ok=false`（调用方应阻断并显示摘要）
pub fn run(root: &Path) -> AppResult<SelfcheckOutcome> {
    let node = root.join("runtime").join("node").join("node.exe");
    if !node.is_file() {
        return Err(AppError::new(
            AppErrorCode::RuntimeMissing,
            format!("自检需要内嵌 node，但找不到 {}", node.display()),
        ));
    }
    let target = root.join("data").join("downloads").join("startup-selfcheck.mjs");
    let (script, source) = materialize_script(&target);
    if !script.is_file() {
        return Err(AppError::new(
            AppErrorCode::RuntimeMissing,
            format!("自检脚本既写不进去、磁盘上也没有：{}", script.display()),
        ));
    }

    crate::debug_log(&format!(
        "[selfcheck] 执行 {}（来源 {source}）",
        script.display()
    ));

    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .arg("--root")
        .arg(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let out = cmd
        .output()
        .map_err(|e| AppError::new(AppErrorCode::SpawnFailed, format!("执行自检失败: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);

    for line in stderr.lines().take(40) {
        crate::debug_log(&format!("[selfcheck:err] {line}"));
    }
    for line in stdout.lines() {
        if let Some(step) = line.strip_prefix("SC|step|") {
            crate::debug_log(&format!("[selfcheck] {step}"));
        }
        if let Some(fatal) = line.strip_prefix("SC|fatal|") {
            return Err(AppError::new(
                AppErrorCode::Internal,
                format!("自检无法进行: {fatal}"),
            ));
        }
    }

    let (ok, summary) = parse_selfcheck_stdout(&stdout).ok_or_else(|| {
        AppError::new(
            AppErrorCode::Internal,
            "自检没有输出可解析的结论（SC|result|）；详见 data/logs/startup-selfcheck.txt",
        )
    })?;
    crate::debug_log(&format!("[selfcheck] ok={ok} {summary}"));

    Ok(SelfcheckOutcome {
        ok,
        summary,
        script: script.display().to_string(),
        script_source: source.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ok_result() {
        let out = "SC|step|检查写入锁\nSC|result|{\"ok\":true,\"linksTotal\":421,\"unrepairable\":[],\"materialized\":{\"found\":0,\"moved\":[]},\"dangling\":{\"found\":0,\"removed\":[]},\"locks\":{\"removed\":0},\"aliases\":{\"rebuilt\":[]},\"manifest\":{\"fixed\":[]}}";
        let (ok, summary) = parse_selfcheck_stdout(out).unwrap();
        assert!(ok);
        assert!(summary.contains("链接总数 421"), "{summary}");
    }

    #[test]
    fn parses_failed_result_with_unrepairable() {
        let out = "SC|result|{\"ok\":false,\"linksTotal\":0,\"unrepairable\":[{\"path\":\"a\",\"why\":\"b\"},{\"path\":\"c\",\"why\":\"d\"}],\"materialized\":{\"found\":411,\"moved\":[1,2]},\"dangling\":{\"found\":0,\"removed\":[]},\"locks\":{\"removed\":0},\"aliases\":{\"rebuilt\":[]},\"manifest\":{\"fixed\":[]}}";
        let (ok, summary) = parse_selfcheck_stdout(out).unwrap();
        assert!(!ok);
        assert!(summary.contains("无法修复 2 项"), "{summary}");
        assert!(summary.contains("物化 411/移出 2"), "{summary}");
    }

    #[test]
    fn reports_managed_proxy_count() {
        let out = "SC|result|{\"ok\":true,\"linksTotal\":0,\"managedProxy\":{\"found\":411},\"unrepairable\":[],\"materialized\":{\"found\":0,\"moved\":[]},\"dangling\":{\"found\":0,\"removed\":[]},\"locks\":{\"removed\":0},\"aliases\":{\"rebuilt\":[]},\"manifest\":{\"fixed\":[]}}";
        let (ok, summary) = parse_selfcheck_stdout(out).unwrap();
        assert!(ok);
        assert!(summary.contains("代理目录 411"), "{summary}");
    }

    #[test]
    fn missing_result_line_is_none() {
        assert!(parse_selfcheck_stdout("SC|step|检查写入锁\n").is_none());
    }
}
