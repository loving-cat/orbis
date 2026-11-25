// Orbis 桌面助手（Windows）。
//
// 阶段 A（SPEC-PERF-V1 §5.3）：**单次进程**，同步语义不变。
//   orbis-desktop-win.exe <command>   stdin 一个 JSON → stdout 一个 JSON
//
// ## 为什么要有它
//
// 现状每次调用都现起一个 PowerShell（~170 ms）并用 Add-Type 现编译 P/Invoke
// （再 ~180 ms）；一次点击全链路 2.5–3.5 s。这些时间全是**固定开销**，和要做的事无关。
//
// ## 边界（规格 §5.2 安全条）
//
//   · 只执行被请求的**单个** Win32 动作；
//   · 不执行 shell 命令、不联网、不读写用户文件；
//   · 未知命令、非法参数一律 `{ok:false, code, text}`，绝不"看起来成功"。
//   · 授权 / 租约 / 审计全部留在 Node 侧（desktop-input-session.js），这里只负责动作。
//
// ## 坐标口径（必须与现有 PowerShell 实现逐项一致，§5.5 有口径对拍）
//
//   · 启动第一件事声明 Per-Monitor V2 DPI 感知：不声明的话 125% 缩放下
//     虚拟屏和窗口矩形都是逻辑坐标（本机实测 2048x1152 而不是 2560x1440），
//     用逻辑坐标去点/截图会整体偏移且**不报错**。
//   · 所有坐标都是**物理像素、左上原点**。
//   · `perform` 的移动沿用 JS 侧同一套策略：SetCursorPos 定位 + ±1px 相对移动
//     把 WM_MOUSEMOVE 投递给目标窗口（只 SetCursorPos 不发 move，拖拽会退化）。

use std::io::{Read, Write};

mod capture;
mod json;
mod serve;
mod win;

use json::Json;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const PROTOCOL: i64 = 2;

/// 移动复核容差（与 desktop-input-win.js 的 CURSOR_TOLERANCE_PX 一致）。
const CURSOR_TOLERANCE_PX: i32 = 24;
/// 移动最多试几次（同上）。
const MOVE_ATTEMPTS: i32 = 3;
/// 列窗口上限（与 desktop-observe.js 的 MAX_WINDOWS 一致）。
const MAX_WINDOWS: usize = 40;

fn main() {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();

    // ★ DPI 感知必须是**第一件事**：任何窗口/坐标 API 之前。
    //   常驻模式下也**只在这里调一次** —— 进程级 DPI 感知本来就是一个进程
    //   只能声明一次的东西（§5.4 说的是不许缓存**显示器/DPI 值/桌面句柄**）。
    let aware = win::make_dpi_aware();

    // ★ `serve`：常驻模式，按行读请求、按行回响应，stdin EOF 就干净退出。
    if command == "serve" {
        serve::run(aware);
        return;
    }

    // ★ `version` 绝不能等 stdin：`build-desktop-win.ps1 -Check` 会直接用当前终端
    //   跑 `orbis-desktop-win.exe version` —— 终端上的 stdin 是**打开但永远没有 EOF**
    //   的，read_to_string 会把构建脚本挂死在那里（实测）。
    if command == "version" {
        emit_line(&dispatch(aware, "version", &Json::Null));
        return;
    }

    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let req = json::parse(&input).unwrap_or(Json::Null);
    let out = dispatch(aware, &command, &req);
    emit_line(&out);
}

/// 一个请求 → 一个响应。单次进程与常驻模式**共用**这一份：
/// 否则同一个命令在两条路径上会有两套口径，迟早漂移。
pub fn dispatch(aware: bool, command: &str, req: &Json) -> Json {
    match command {
        "version" => Json::obj(vec![
            ("ok", Json::Bool(true)),
            ("version", Json::Str(VERSION.to_string())),
            ("protocol", Json::Int(PROTOCOL)),
        ]),
        "env" => cmd_env(aware),
        "probe" => cmd_probe(),
        "cursor" => cmd_cursor(aware),
        "foreground" => cmd_foreground(),
        "perform" => cmd_perform(aware, &req),
        "noise" => cmd_noise(aware, &req),
        "windows" => cmd_windows(aware, &req),
        "drag-step" => cmd_drag_step(aware, req),
        "capture" => cmd_capture(req),
        "" => fail("bad_command", "缺少子命令"),
        other => fail("bad_command", &format!("未知子命令：{}", other)),
    }
}

/// 一行 JSON 写出去并 flush（常驻模式靠这个不被管道缓冲卡住）。
pub fn emit_line(value: &Json) {
    let text = value.to_string();
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(text.as_bytes());
    let _ = stdout.write_all(b"
");
    let _ = stdout.flush();
}

/// 截图：**不写盘**，把 PNG base64 交回 Node 侧落盘（§5.2「助手不读写用户文件」）。
///
/// 这样即使助手被替换或被利用，也没有「任意路径写文件」这个能力 ——
/// 落盘路径由 Node 侧决定（受控的 outFile）。
fn cmd_capture(req: &Json) -> Json {
    // 目标是窗口还是屏幕矩形？窗口优先（有句柄就不用自己算坐标）。
    let hwnd = req
        .get("window")
        .and_then(|w| num_field(w, "handle"))
        .or_else(|| int_field(req, "handle").map(|n| n as f64))
        .unwrap_or(0.0) as i64;

    let rect = req.get("rect").and_then(|r| {
        Some((
            num_field(r, "x")?.round() as i32,
            num_field(r, "y")?.round() as i32,
            num_field(r, "width")?.round() as i32,
            num_field(r, "height")?.round() as i32,
        ))
    });
    // Node 侧已经有窗口矩形时直接传进来，省一次窗口查询
    let rect = rect.or_else(|| {
        Some((
            int_field(req, "x")? as i32,
            int_field(req, "y")? as i32,
            int_field(req, "width")? as i32,
            int_field(req, "height")? as i32,
        ))
    });

    // ★ 负数不能直接 `as u32`：-1 会回绕成 4294967295，等于「永远不缩放」，
    //   一张 4K 图就原样吐出去（base64 十几 MB）。范围外一律回落默认。
    let raw_edge = int_field(req, "maxEdge").unwrap_or(capture::DEFAULT_MAX_EDGE as i64);
    let max_edge = if raw_edge <= 0 || raw_edge > 16384 {
        capture::DEFAULT_MAX_EDGE
    } else {
        raw_edge as u32
    };

    match capture::capture(hwnd, rect, max_edge) {
        Ok(shot) => match capture::encode_png(&shot.rgba, shot.width, shot.height) {
            Ok(png) => Json::obj(vec![
                ("ok", Json::Bool(true)),
                ("pngBase64", Json::Str(capture::base64_encode(&png))),
                ("width", Json::Int(shot.width as i64)),
                ("height", Json::Int(shot.height as i64)),
                ("originalWidth", Json::Int(shot.original_width as i64)),
                ("originalHeight", Json::Int(shot.original_height as i64)),
                ("resized", Json::Bool(shot.resized)),
                ("method", Json::Str(shot.method.to_string())),
            ]),
            Err(err) => fail("encode_failed", &err),
        },
        Err(err) => fail("capture_failed", &err),
    }
}

fn fail(code: &str, text: &str) -> Json {
    Json::obj(vec![
        ("ok", Json::Bool(false)),
        ("code", Json::Str(code.to_string())),
        ("text", Json::Str(text.chars().take(400).collect())),
    ])
}

fn num_field(v: &Json, key: &str) -> Option<f64> {
    match v.get(key) {
        Some(Json::Int(n)) => Some(*n as f64),
        Some(Json::Float(n)) => Some(*n),
        Some(Json::Str(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn int_field(v: &Json, key: &str) -> Option<i64> {
    num_field(v, key).map(|n| n.round() as i64)
}

// ---------------------------------------------------------------- 命令

fn cmd_env(aware: bool) -> Json {
    if !aware {
        // 与现有 PowerShell 实现一致：声明不了感知就**不发输入**，
        // 由 JS 侧翻译成 INPUT_FAIL.notAware。
        return Json::obj(vec![
            ("ok", Json::Bool(true)),
            ("aware", Json::Bool(false)),
        ]);
    }
    let (x, y, w, h) = win::virtual_screen();
    Json::obj(vec![
        ("ok", Json::Bool(true)),
        ("aware", Json::Bool(true)),
        ("screen", Json::obj(vec![
            ("x", Json::Int(x as i64)),
            ("y", Json::Int(y as i64)),
            ("width", Json::Int(w as i64)),
            ("height", Json::Int(h as i64)),
        ])),
        ("dpi", Json::Int(win::system_dpi() as i64)),
        ("session", Json::Bool(win::has_input_desktop())),
    ])
}

fn cmd_probe() -> Json {
    let tick = win::last_input_tick();
    let uptime = win::uptime_ms();
    Json::obj(vec![
        ("ok", Json::Bool(true)),
        ("lastInputTick", Json::Int(tick)),
        ("uptime", Json::Int(uptime as i64)),
    ])
}

fn cmd_cursor(_aware: bool) -> Json {
    match win::cursor_pos() {
        Some((x, y)) => Json::obj(vec![
            ("ok", Json::Bool(true)),
            ("x", Json::Int(x as i64)),
            ("y", Json::Int(y as i64)),
        ]),
        None => fail("call_failed", "GetCursorPos 失败"),
    }
}

fn cmd_foreground() -> Json {
    Json::obj(vec![
        ("ok", Json::Bool(true)),
        ("title", Json::Str(win::foreground_title())),
    ])
}

/// 一次「移动 → 复核（最多 3 次）→（可选）点击」。
///
/// 只处理 move / click。scroll / key / text 不在阶段 A（它们走剪贴板与按键状态机，
/// 且没有真机验收），JS 侧见到 `unsupported_action` 就回退 PowerShell。
fn cmd_perform(aware: bool, req: &Json) -> Json {
    if !aware {
        return fail("not_aware", "声明不了 DPI 感知，坐标不可信，没发输入");
    }
    let plan = match req.get("plan") {
        Some(p) => p,
        None => return fail("invalid", "缺少 plan"),
    };
    let action = match plan.get("action") {
        Some(Json::Str(s)) => s.as_str(),
        _ => return fail("invalid", "plan.action 缺失"),
    };
    if action != "move" && action != "click" {
        return fail("unsupported_action", &format!("阶段 A 不支持动作：{}", action));
    }
    let point = match plan.get("point") {
        Some(p) => p,
        None => return fail("invalid", "plan.point 缺失"),
    };
    let (tx, ty) = match (num_field(point, "x"), num_field(point, "y")) {
        (Some(x), Some(y)) => (x.round() as i32, y.round() as i32),
        _ => return fail("invalid", "plan.point 不是数字"),
    };
    let button = match plan.get("button") {
        Some(Json::Str(s)) => s.clone(),
        _ => "left".to_string(),
    };
    if !matches!(button.as_str(), "left" | "right" | "middle") {
        return fail("invalid", "plan.button 只能是 left/right/middle");
    }
    let clicks = int_field(plan, "clicks").unwrap_or(1).clamp(1, 5) as i32;

    // ① 移动 + 复核（偏差在容差内才算到位；**到位之前绝不点击**）
    let mut last = (0i32, 0i32);
    let mut ok = false;
    for attempt in 0..MOVE_ATTEMPTS {
        match win::move_to(tx, ty) {
            Some(at) => {
                last = at;
                if (at.0 - tx).abs() <= CURSOR_TOLERANCE_PX && (at.1 - ty).abs() <= CURSOR_TOLERANCE_PX {
                    ok = true;
                    break;
                }
            }
            None => return fail("call_failed", "SetCursorPos 失败"),
        }
        // 只有"没到位、而且还有下一次"才等这一下：一次到位就零额外延迟。
        // （以前每次循环都睡，等于把一次成功的移动硬生生拖慢 40 ms。）
        if attempt + 1 < MOVE_ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    }
    if !ok {
        return fail(
            "cursor_not_reached",
            &format!("光标没到位：目标 ({},{}) 实际 ({},{})", tx, ty, last.0, last.1),
        );
    }

    // ② 点击（紧跟移动，减少中间被抢的机会）
    if action == "click" {
        for i in 0..clicks {
            if !win::click(&button) {
                return fail("call_failed", "SendInput 没有发出点击");
            }
            if i + 1 < clicks {
                std::thread::sleep(std::time::Duration::from_millis(45));
            }
        }
    }

    Json::obj(vec![
        ("ok", Json::Bool(true)),
        ("at", Json::obj(vec![
            ("x", Json::Int(last.0 as i64)),
            ("y", Json::Int(last.1 as i64)),
        ])),
    ])
}

/// 采样「输入噪声」：连续读几遍 GetLastInputInfo + 光标位置。
///
/// 判据（噪声 / 光标是否在动）留在 JS 侧的 `classifyInputNoise` —— 两个平台共用，
/// 这里只负责采样。这样也顺带消灭了 JS 里的 `Atomics.wait`（硬规矩 3）。
fn cmd_noise(aware: bool, req: &Json) -> Json {
    let samples = int_field(req, "samples").unwrap_or(5).clamp(2, 20);
    let interval = int_field(req, "intervalMs").unwrap_or(120).clamp(10, 1000) as u64;
    let mut gaps: Vec<Json> = Vec::new();
    let mut cursors: Vec<Json> = Vec::new();
    for i in 0..samples {
        let tick = win::last_input_tick();
        if tick < 0 {
            return fail("probe_unavailable", "GetLastInputInfo 失败（没有交互式会话）");
        }
        let uptime = win::uptime_ms();
        let uptime32 = (uptime % (1u64 << 32)) as i64;
        let mut idle = uptime32 - tick;
        if idle < 0 {
            idle += 1i64 << 32; // 32 位 tick 回绕
        }
        gaps.push(Json::Int(idle.max(0)));
        let (x, y) = win::cursor_pos().unwrap_or((0, 0));
        cursors.push(Json::obj(vec![
            ("x", Json::Int(x as i64)),
            ("y", Json::Int(y as i64)),
        ]));
        if i + 1 < samples {
            std::thread::sleep(std::time::Duration::from_millis(interval));
        }
    }
    let _ = aware;
    Json::obj(vec![
        ("ok", Json::Bool(true)),
        ("gaps", Json::Arr(gaps)),
        ("cursors", Json::Arr(cursors)),
    ])
}

fn cmd_windows(aware: bool, req: &Json) -> Json {
    if !aware {
        // 未声明感知时窗口矩形是逻辑坐标（125% 下小一圈），宁可失败也不给错数据
        return fail("not_aware", "声明不了 DPI 感知，窗口矩形不可信");
    }
    let limit = int_field(req, "limit").unwrap_or(MAX_WINDOWS as i64).clamp(1, MAX_WINDOWS as i64) as usize;
    // 排序与截断都在 win::sort_and_limit 里（先全域排序，再取前 N）
    let rows = win::list_windows(limit);
    let list = rows
        .into_iter()
        .map(|w| {
            Json::obj(vec![
                ("handle", Json::Int(w.handle as i64)),
                ("title", Json::Str(w.title)),
                ("app", Json::Str(w.app)),
                ("class", Json::Str(w.class)),
                ("pid", Json::Int(w.pid as i64)),
                ("x", Json::Int(w.x as i64)),
                ("y", Json::Int(w.y as i64)),
                ("width", Json::Int(w.width as i64)),
                ("height", Json::Int(w.height as i64)),
                ("minimized", Json::Bool(w.minimized)),
            ])
        })
        .collect();
    Json::obj(vec![("ok", Json::Bool(true)), ("windows", Json::Arr(list))])
}

/// 拖拽的**单步移动**。
///
/// 阶段 A 只提供这个原语：拖拽的按下/抬起与分段节奏仍由 JS 编排
/// （`performDrag` 的 `shouldAbort` / `onStep` 回调语义不能变）。
/// 真机拖拽验收（§5.5）通过后再把整条 drag 收进助手，见 SPEC §5.2 的分期表。
fn cmd_drag_step(aware: bool, req: &Json) -> Json {
    if !aware {
        return fail("not_aware", "声明不了 DPI 感知，坐标不可信");
    }
    let point = match req.get("point") {
        Some(p) => p,
        None => return fail("invalid", "缺少 point"),
    };
    let (x, y) = match (num_field(point, "x"), num_field(point, "y")) {
        (Some(x), Some(y)) => (x.round() as i32, y.round() as i32),
        _ => return fail("invalid", "point 不是数字"),
    };
    match win::move_to(x, y) {
        Some(at) => Json::obj(vec![
            ("ok", Json::Bool(true)),
            ("at", Json::obj(vec![
                ("x", Json::Int(at.0 as i64)),
                ("y", Json::Int(at.1 as i64)),
            ])),
        ]),
        None => fail("call_failed", "SetCursorPos 失败"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_semver() {
        assert!(VERSION.split('.').count() == 3, "version 应该是 x.y.z");
        // 阶段 B：版本 0.2.0 + 协议 2（Node 侧 DESKTOP_HELPER_VERSION / HELPER_PROTOCOL
        // 必须同步，否则会静默连上阶段 A 的旧二进制）
        assert_eq!(PROTOCOL, 2);
    }

    #[test]
    fn negative_max_edge_falls_back_to_default() {
        // -1 若直接 `as u32` 会回绕成 4294967295 → 永远不缩放，
        // 一张 4K 图原样吐十几 MB base64。这里验"回落默认"这条规则本身。
        let pick = |raw: i64| {
            if raw <= 0 || raw > 16384 {
                capture::DEFAULT_MAX_EDGE
            } else {
                raw as u32
            }
        };
        assert_eq!(pick(-1), capture::DEFAULT_MAX_EDGE);
        assert_eq!(pick(0), capture::DEFAULT_MAX_EDGE);
        assert_eq!(pick(16385), capture::DEFAULT_MAX_EDGE);
        assert_eq!(pick(640), 640);
        assert_eq!(pick(16384), 16384);
    }

    fn code_of(out: &Json) -> String {
        match out.get("code") {
            Some(Json::Str(code)) => code.clone(),
            other => panic!("期望失败码，实际 {:?}", other),
        }
    }

    #[test]
    fn missing_point_is_invalid_when_aware() {
        let req = json::parse(r#"{"plan":{"action":"click"}}"#).unwrap();
        assert_eq!(code_of(&cmd_perform(true, &req)), "invalid");
    }

    #[test]
    fn unaware_short_circuits_before_validation() {
        let req = json::parse(r#"{"plan":{"action":"click"}}"#).unwrap();
        // 声明不了感知时连参数都不该走到"发输入"那一步
        assert_eq!(code_of(&cmd_perform(false, &req)), "not_aware");
    }

    #[test]
    fn window_list_sorts_by_area_before_truncating() {
        let row = |width: i32, height: i32| win::WindowRow {
            handle: 0,
            title: format!("{}x{}", width, height),
            app: "app".to_string(),
            class: "cls".to_string(),
            pid: 1,
            x: 0,
            y: 0,
            width,
            height,
            minimized: false,
        };
        // 输入顺序是"小、大、中、微、巨大"：先截断会拿错人
        let rows = vec![row(10, 10), row(300, 30), row(100, 20), row(1, 1), row(1000, 100)];
        let top2 = win::sort_and_limit(rows, 2);
        assert_eq!(top2.len(), 2);
        assert_eq!(top2[0].width, 1000, "最大的应该排第一");
        assert_eq!(top2[1].width, 300, "第二大的应该留下");
    }

    #[test]
    fn window_list_area_does_not_overflow_i32() {
        // 8K 级虚拟屏：20000 x 20000 = 4e8 还在 i32 内，但 40000 x 40000 = 1.6e9 已溢出 i32 的正数边界
        let big = win::WindowRow {
            handle: 0, title: "big".into(), app: "a".into(), class: "c".into(), pid: 1,
            x: 0, y: 0, width: 40000, height: 40000, minimized: false,
        };
        let normal = win::WindowRow {
            handle: 0, title: "normal".into(), app: "a".into(), class: "c".into(), pid: 1,
            x: 0, y: 0, width: 2560, height: 1440, minimized: false,
        };
        let top = win::sort_and_limit(vec![normal, big], 1);
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].width, 40000, "溢出成负数会把最大的排到最后");
    }

    #[test]
    fn unsupported_action_is_explicit() {
        let req = json::parse(r#"{"plan":{"action":"key","point":{"x":1,"y":2}}}"#).unwrap();
        let out = cmd_perform(true, &req);
        match out.get("code") {
            Some(Json::Str(code)) => assert_eq!(code, "unsupported_action"),
            other => panic!("期望 unsupported_action，实际 {:?}", other),
        }
    }

    #[test]
    fn invalid_button_is_rejected() {
        let req = json::parse(r#"{"plan":{"action":"click","point":{"x":1,"y":2},"button":"thumb"}}"#).unwrap();
        let out = cmd_perform(true, &req);
        match out.get("code") {
            Some(Json::Str(code)) => assert_eq!(code, "invalid"),
            other => panic!("期望 invalid，实际 {:?}", other),
        }
    }

    #[test]
    fn numbers_accept_string_and_float() {
        let v = json::parse(r#"{"x":"12","y":3.6}"#).unwrap();
        assert_eq!(num_field(&v, "x"), Some(12.0));
        assert_eq!(int_field(&v, "y"), Some(4));
    }
}
