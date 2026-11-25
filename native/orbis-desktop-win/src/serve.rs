//! 常驻模式（SPEC-PERF-V1 §5.4 阶段 B）。
//!
//! ```text
//! orbis-desktop-win.exe serve
//! ← {"id":1,"cmd":"cursor","payload":{}}
//! → {"id":1,"ok":true,"x":100,"y":200}
//! ```
//!
//! 一行一个 JSON、一问一答、**每条响应写完就 flush**。
//!
//! ## 为什么是常驻
//!
//! 阶段 A 每次调用都要起一个进程（~25 ms）并重新声明 DPI 感知。一次点击全链路
//! 由 3–4 次调用组成，加起来接近 100 ms；常驻之后单次只剩「管道往返 + 动作本身」，
//! §5.6 的阶段 B 指标（只读探针 p50 ≤ 2 ms）才可能达到。
//!
//! ## 三条必须守住的边界
//!
//! 1. **不缓存显示器 / DPI / 桌面句柄**：每条请求都重新取（`win.rs` 里那几处
//!    都是现查现放）。外接屏热插拔、改缩放、锁屏、UAC 安全桌面都会让旧口径失效，
//!    缓存的坐标会**点偏**，缓存的句柄会泄漏。
//! 2. **单条请求失败不影响后续**：解析失败 / 未知命令都回一条 `{ok:false}`，
//!    进程继续服务 —— 一次手滑的调用不该把常驻进程带走。
//! 3. **stdin EOF 就退出**：Node 侧停机时关管道，这里必须跟着结束，
//!    绝不留下一个还在等输入的孤儿进程。
//!
//! 注意：这里的 `aware` 是**进程级** DPI 感知开关（一个进程只能声明一次），
//! 与上面第 1 条不冲突 —— 第 1 条说的是不许缓存**读到的值**与**系统句柄**。

use std::io::{BufRead, Write};

use crate::json::{self, Json};
use crate::{dispatch, emit_line, fail};

/// 单行请求上限：截图不会走这条（请求只有几个字段），
/// 给 1 MiB 已经很宽松，也防住一条失控的超长行把内存吃光。
const MAX_LINE: usize = 1024 * 1024;

pub fn run(aware: bool) {
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let mut buf: Vec<u8> = Vec::new();

    loop {
        buf.clear();
        // 逐字节读而不是 read_line：非法 UTF-8 也不能让常驻进程崩掉，
        // 那种情况回一条 bad_json 继续服务即可。
        let read = match read_line_limited(&mut reader, &mut buf) {
            Ok(n) => n,
            // ★ 超长行：明确回一条错误并**继续服务**（不是退出，也不是静默吞掉）
            Err(LineError::TooLong) => {
                emit_line(&crate::fail(
                    "line_too_long",
                    &format!("单行请求超过 {} 字节，已丢弃", MAX_LINE),
                ));
                continue;
            }
            Err(LineError::Io) => break,
        };
        if read == 0 {
            break; // stdin EOF：干净退出（不留孤儿）
        }
        let text = String::from_utf8_lossy(&buf);
        let trimmed = text.trim();
        if trimmed.is_empty() { continue; }
        emit_line(&handle_line(aware, trimmed));
    }
    // 退出前把 stdout 刷干净：Node 侧是按行读的，少一条响应它会一直等到超时。
    let _ = std::io::stdout().flush();
}

/// Read one line (including the trailing newline), bounded by MAX_LINE.
///
/// An over-long line (no newline in sight, e.g. a client sending a whole file as
/// one request) is *discarded* with a fixed-size buffer instead of being appended
/// to `buf` forever -- otherwise a single bad client OOMs the resident process.
fn read_line_limited<R: BufRead>(reader: &mut R, buf: &mut Vec<u8>) -> Result<usize, LineError> {
    let mut total = 0usize;
    let mut over = false;
    loop {
        let mut byte = [0u8; 1];
        let n = match reader.read(&mut byte) {
            Ok(n) => n,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(LineError::Io),
        };
        if n == 0 {
            return if over { Err(LineError::TooLong) } else { Ok(total) };
        }
        total += 1;
        if byte[0] == b'\n' {
            return if over { Err(LineError::TooLong) } else { Ok(total) };
        }
        if over { continue; }
        if buf.len() >= MAX_LINE {
            buf.clear();
            over = true;
            continue;
        }
        buf.push(byte[0]);
    }
}

/// 读一行时可能遇到的两类失败。
#[derive(Debug, PartialEq)]
pub enum LineError {
    /// 超过 `MAX_LINE`（已安全丢弃，可以继续服务）
    TooLong,
    /// 真正的 IO 错误（应当退出）
    Io,
}

/// 一条请求 → 一条响应（带上原来的 `id`）。
pub fn handle_line(aware: bool, line: &str) -> Json {
    let parsed = match json::parse(line) {
        Some(v) => v,
        None => return with_id(Json::Null, fail("bad_json", "请求不是合法 JSON")),
    };
    let id = parsed.get("id").cloned().unwrap_or(Json::Null);
    let command = match parsed.get("cmd") {
        Some(Json::Str(s)) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return with_id(id, fail("bad_command", "请求缺少 cmd")),
    };
    let payload = parsed.get("payload").cloned().unwrap_or(Json::Null);
    with_id(id, dispatch(aware, &command, &payload))
}

/// 把 `id` 放到响应对象的最前面（便于人读；顺序不影响 JSON 语义）。
fn with_id(id: Json, body: Json) -> Json {
    match body {
        Json::Obj(pairs) => {
            let mut out = Vec::with_capacity(pairs.len() + 1);
            out.push(("id".to_string(), id));
            out.extend(pairs);
            Json::Obj(out)
        }
        other => Json::Obj(vec![
            ("id".to_string(), id),
            ("ok".to_string(), Json::Bool(false)),
            ("code".to_string(), Json::Str("bad_response".to_string())),
            (
                "text".to_string(),
                Json::Str(format!("响应不是对象：{}", other.to_string().chars().take(120).collect::<String>())),
            ),
        ]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatches_known_command_with_id_echo() {
        let out = handle_line(true, r#"{"id":7,"cmd":"version","payload":{}}"#);
        let text = out.to_string();
        assert!(text.starts_with(r#"{"id":7,"#), "id 要原样带回：{text}");
        assert!(text.contains(r#""ok":true"#), "version 应成功：{text}");
        assert!(text.contains(r#""protocol":2"#), "协议版本 2：{text}");
    }

    #[test]
    fn unknown_command_is_reported_not_panicking() {
        let out = handle_line(true, r#"{"id":"a1","cmd":"nope"}"#);
        let text = out.to_string();
        assert!(text.contains(r#""id":"a1""#), "字符串 id 也要带回：{text}");
        assert!(text.contains(r#""ok":false"#));
        assert!(text.contains("bad_command"));
    }

    #[test]
    fn invalid_json_is_tolerated() {
        let out = handle_line(true, "{not json");
        let text = out.to_string();
        assert!(text.contains("bad_json"), "非法 JSON 要明确报错：{text}");
    }

    #[test]
    fn missing_command_is_reported() {
        let text = handle_line(true, r#"{"id":1}"#).to_string();
        assert!(text.contains("bad_command"), "{text}");
    }

    #[test]
    fn payload_is_forwarded() {
        // capture 缺参数 → 应该走到「既没有窗口也没有矩形」的失败分支，
        // 说明 payload 确实被透传下去了（而不是被 serve 丢掉）。
        let text = handle_line(true, r#"{"id":2,"cmd":"capture","payload":{}}"#).to_string();
        assert!(text.contains(r#""ok":false"#), "{text}");
        assert!(text.contains("capture_failed") || text.contains("bad_command"), "{text}");
    }

    #[test]
    fn over_long_line_is_dropped_and_service_continues() {
        // 一条 5 MiB 没有换行的输入：必须被安全丢弃、回 line_too_long，
        // 之后**正常请求仍可服务**（这才是"有界丢弃"的意义）。
        let mut payload = vec![b'x'; 5 * 1024 * 1024];
        payload.push(b'\n');
        payload.extend_from_slice(b"{\"id\":9,\"cmd\":\"version\"}
");
        let mut cur = std::io::Cursor::new(payload);

        let mut buf = Vec::new();
        match read_line_limited(&mut cur, &mut buf) {
            Err(LineError::TooLong) => {}
            other => panic!("超长行必须返回 TooLong，实际 {:?}", other),
        }
        assert!(buf.is_empty(), "丢弃时要清空缓冲，不能留着半个巨型请求");

        buf.clear();
        let n = read_line_limited(&mut cur, &mut buf).expect("下一条正常行必须还能读");
        assert!(n > 0);
        let out = handle_line(true, String::from_utf8_lossy(&buf).trim()).to_string();
        assert!(out.contains("\"id\":9"), "后续请求仍应被正常处理：{out}");
        assert!(out.contains("\"ok\":true"));
    }

    #[test]
    fn line_too_long_is_reported_with_a_code() {
        // 走 run() 的那条分支用的是同一套判定：这里直接验错误码文案的存在
        let text = crate::fail("line_too_long", "x").to_string();
        assert!(text.contains("line_too_long"));
    }

    #[test]
    fn line_reader_handles_eof_and_blank_lines() {
        let mut cur = std::io::Cursor::new(b"{\"id\":1,\"cmd\":\"version\"}\n\n".to_vec());
        let mut buf = Vec::new();
        assert!(read_line_limited(&mut cur, &mut buf).unwrap() > 0);
        buf.clear();
        let n = read_line_limited(&mut cur, &mut buf).unwrap();
        assert!(n > 0 && buf.is_empty(), "空行要能读出来（上层会跳过）");
        buf.clear();
        assert_eq!(read_line_limited(&mut cur, &mut buf).unwrap(), 0, "读到 EOF 返回 0");
    }
}
