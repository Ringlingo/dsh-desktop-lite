//! 就绪行解析：从后端 stdout 流中识别官方就绪信号。
//!
//! 协议（R10 严格白名单）：仅接受与
//! `dsh web: http://127.0.0.1:PORT` 完全匹配的行作为就绪信号。
//! 端口范围 [1024, 65535]，host 必须为 127.0.0.1。

use std::error::Error;
use std::fmt;

/// 解析失败的原因，用于错误 UI 展示（R9 统一错误）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadyParseError {
    /// 行格式不匹配（不是就绪行，不视为错误，仅返回 None）。
    NoMatch,
    /// host 不是 127.0.0.1（安全拒绝）。
    NonLoopbackHost(String),
    /// 端口越界。
    PortOutOfRange(String),
}

impl fmt::Display for ReadyParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReadyParseError::NoMatch => write!(f, "line is not a ready line"),
            ReadyParseError::NonLoopbackHost(h) => write!(f, "non-loopback host in ready line: {h}"),
            ReadyParseError::PortOutOfRange(p) => write!(f, "port out of range in ready line: {p}"),
        }
    }
}

impl Error for ReadyParseError {}

/// 解析一行 stdout。匹配则返回 `(port, url)`；非就绪行返回 `Ok(None)`；
/// 形似就绪行但字段非法返回 `Err`。
///
/// 兼容两种就绪行：
///   `dsh web: http://127.0.0.1:PORT`
///   `dsh web: http://127.0.0.1:PORT/?token=XXX`   ← dsh 0.1.5 起带 token
/// token 是登录凭据，**必须原样带进导航 URL**，否则窗口会停在登录页
/// （8-19 基线只接受纯数字端口，实测导致「后端就绪但窗口不导航」）。
pub fn parse_ready_line(line: &str) -> Result<Option<(u16, String)>, ReadyParseError> {
    let line = line.trim_end_matches(['\r', '\n']);
    // 严格前缀匹配，防止误报（R10）。
    const PREFIX: &str = "dsh web: http://127.0.0.1:";
    let Some(rest) = line.strip_prefix(PREFIX) else {
        return Ok(None);
    };
    // 端口 = 前导连续数字；其后只允许「空」或 `/?token=...` 这类安全尾随。
    let digits_end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    if digits_end == 0 {
        return Ok(None);
    }
    let (digits, tail) = rest.split_at(digits_end);
    let port: u16 = digits
        .parse()
        .map_err(|_| ReadyParseError::PortOutOfRange(digits.to_string()))?;
    if port < 1024 {
        return Err(ReadyParseError::PortOutOfRange(digits.to_string()));
    }
    let url = if tail.is_empty() {
        format!("http://127.0.0.1:{port}")
    } else {
        // 只接受 `/?token=` 形态，且字符集受限（保持防误报；不让任意内容进导航 URL）
        let safe = tail.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b'/' | b'?' | b'=' | b'-' | b'_' | b'.' | b'~' | b'+' | b'%' | b'&')
        });
        if !tail.starts_with("/?token=") || !safe {
            return Ok(None);
        }
        format!("http://127.0.0.1:{port}{tail}")
    };
    Ok(Some((port, url)))
}

/// 对 stdout 流进行增量解析：累积不完整行，逐行喂给 [`parse_ready_line`]。
pub struct ReadyLineParser {
    buffer: String,
}

impl Default for ReadyLineParser {
    fn default() -> Self {
        Self::new()
    }
}

impl ReadyLineParser {
    pub fn new() -> Self {
        Self { buffer: String::new() }
    }

    /// 喂入一段 stdout 文本，返回 (解析到的就绪信号, 是否完成)。
    pub fn feed(
        &mut self,
        chunk: &str,
    ) -> Result<Option<(u16, String)>, ReadyParseError> {
        self.buffer.push_str(chunk);
        let mut result = None;
        while let Some(idx) = self.buffer.find('\n') {
            let line = self.buffer[..idx].to_string();
            self.buffer.drain(..=idx);
            if let Some(found) = parse_ready_line(&line)? {
                result = Some(found);
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_canonical_ready_line() {
        let got = parse_ready_line("dsh web: http://127.0.0.1:38571\n").unwrap();
        assert_eq!(got, Some((38571, "http://127.0.0.1:38571".into())));
    }

    #[test]
    fn matches_without_trailing_newline() {
        let got = parse_ready_line("dsh web: http://127.0.0.1:3080").unwrap();
        assert_eq!(got, Some((3080, "http://127.0.0.1:3080".into())));
    }

    #[test]
    fn matches_ready_line_with_token() {
        // dsh 0.1.5 起带 token —— 必须原样带进导航 URL（否则停在登录页）
        let got = parse_ready_line("dsh web: http://127.0.0.1:38571/?token=abc-DEF_123\n").unwrap();
        assert_eq!(
            got,
            Some((38571, "http://127.0.0.1:38571/?token=abc-DEF_123".into()))
        );
    }

    #[test]
    fn rejects_non_ready_lines() {
        assert_eq!(parse_ready_line("some dev server output").unwrap(), None);
        assert_eq!(parse_ready_line("").unwrap(), None);
        assert_eq!(parse_ready_line("dsh web: http://localhost:3080").unwrap(), None);
    }

    #[test]
    fn rejects_port_out_of_range() {
        assert!(parse_ready_line("dsh web: http://127.0.0.1:80").is_err());
        assert!(parse_ready_line("dsh web: http://127.0.0.1:99999").is_err());
        assert!(parse_ready_line("dsh web: http://127.0.0.1:0").is_err());
    }

    #[test]
    fn rejects_suffix_garbage() {
        // 形似行 + 尾随内容必须拒绝（R10 防误报）。
        assert_eq!(
            parse_ready_line("dsh web: http://127.0.0.1:3080 (LAN: http://10.0.0.2:3080)").unwrap(),
            None
        );
    }

    #[test]
    fn incremental_parser_handles_split_chunks() {
        let mut p = ReadyLineParser::new();
        assert_eq!(p.feed("dsh web: http://127.0").unwrap(), None);
        assert_eq!(
            p.feed(".0.1:4444\n").unwrap(),
            Some((4444, "http://127.0.0.1:4444".into()))
        );
    }

    #[test]
    fn incremental_parser_ignores_noise_lines() {
        let mut p = ReadyLineParser::new();
        assert_eq!(p.feed("info: loading\n[W] webServer ...\n").unwrap(), None);
        assert_eq!(
            p.feed("dsh web: http://127.0.0.1:5173\n").unwrap(),
            Some((5173, "http://127.0.0.1:5173".into()))
        );
    }
}
