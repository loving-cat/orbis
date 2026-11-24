//! Win32 薄封装：本助手实际用到的那几个调用。
//!
//! 全部走 `windows-sys`（与 `orbis-sandbox` 同版本）。这里**不做任何判定**，
//! 只把"取一个值 / 发一个输入"包成 Rust 函数；判定与错误文案在 `main.rs` 与 Node 侧。

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, POINT, RECT};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_READOBJECTS};
use windows_sys::Win32::System::SystemInformation::GetTickCount64;
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::HiDpi::{
    GetDpiForSystem, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetLastInputInfo, SendInput, INPUT, INPUT_0, INPUT_MOUSE, LASTINPUTINFO, MOUSEINPUT,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowLongW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetCursorPos, GWL_EXSTYLE,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, WS_EX_TOOLWINDOW,
};

// 老系统上 SetProcessDpiAwarenessContext 可能不存在，退回到 SetProcessDPIAware
#[link(name = "user32")]
extern "system" {
    fn SetProcessDPIAware() -> BOOL;
}

/// 声明 Per-Monitor V2 DPI 感知；失败退回系统级感知。两者都失败 → false。
pub fn make_dpi_aware() -> bool {
    unsafe {
        if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != 0 {
            return true;
        }
        SetProcessDPIAware() != 0
    }
}

pub fn virtual_screen() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

pub fn system_dpi() -> u32 {
    unsafe { GetDpiForSystem() }
}

/// 能不能打开输入桌面（锁屏 / 断开会话时打不开）。
/// ★ 打开就必须关掉：`OpenInputDesktop` 每次都会拿一个句柄。
pub fn has_input_desktop() -> bool {
    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() {
            return false;
        }
        CloseDesktop(desktop);
        true
    }
}

pub fn last_input_tick() -> i64 {
    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info) == 0 {
            return -1;
        }
        info.dwTime as i64
    }
}

pub fn uptime_ms() -> u64 {
    unsafe { GetTickCount64() }
}

pub fn cursor_pos() -> Option<(i32, i32)> {
    unsafe {
        let mut p = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut p) == 0 {
            return None;
        }
        Some((p.x, p.y))
    }
}

fn send(inputs: &[INPUT]) -> u32 {
    unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    }
}

fn mouse_input(flags: u32, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// 移到绝对坐标：SetCursorPos 定位 + 一次 ±1px 相对移动。
///
/// ★ 只 SetCursorPos 不发 WM_MOUSEMOVE：拖拽会退化成"瞬移"，文件列表/滑块不认。
/// ★ 只靠相对移动：大位移会被系统"提高指针精确度"放大（实测 (350,320) 落到 (0,252)）。
pub fn move_to(x: i32, y: i32) -> Option<(i32, i32)> {
    unsafe {
        if SetCursorPos(x, y) == 0 {
            return None;
        }
    }
    let _ = send(&[mouse_input(MOUSEEVENTF_MOVE, 1, 0, 0)]);
    let _ = send(&[mouse_input(MOUSEEVENTF_MOVE, -1, 0, 0)]);
    cursor_pos()
}

pub fn click(button: &str) -> bool {
    let (down, up) = match button {
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    };
    let d = send(&[mouse_input(down, 0, 0, 0)]);
    let u = send(&[mouse_input(up, 0, 0, 0)]);
    d == 1 && u == 1
}

pub fn foreground_title() -> String {
    unsafe {
        let hwnd = GetForegroundWindow();
        window_text(hwnd)
    }
}

unsafe fn window_text(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
    if n <= 0 {
        return String::new();
    }
    let text = String::from_utf16_lossy(&buf[..n as usize]);
    text.chars().take(200).collect()
}

unsafe fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
    if n <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..n as usize])
}

unsafe fn process_name(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if handle.is_null() {
        return String::new();
    }
    let mut buf = [0u16; 1024];
    let mut size = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size);
    CloseHandle(handle);
    if ok == 0 {
        return String::new();
    }
    let full = String::from_utf16_lossy(&buf[..size as usize]);
    // 与 PowerShell 实现一致：**不带 .exe**（那边用 Get-Process 的 ProcessName）。
    // 带扩展名会让 `app` 在两种实现之间漂移，上层按名字匹配会静默失效。
    let base = std::path::Path::new(&full)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    base.strip_suffix(".exe").or_else(|| base.strip_suffix(".EXE")).unwrap_or(&base).to_string()
}

/// 一个窗口的矩形：优先 DWM 的「扩展边框」（Win10+ 的 GetWindowRect 会多算阴影）。
pub struct WindowRow {
    pub handle: usize,
    pub title: String,
    pub app: String,
    pub class: String,
    pub pid: u32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub minimized: bool,
}

pub fn list_windows(limit: usize) -> Vec<WindowRow> {
    let mut rows: Vec<WindowRow> = Vec::new();
    unsafe {
        EnumWindows(Some(enum_proc), &mut rows as *mut Vec<WindowRow> as LPARAM);
    }
    // 只留能截的：有标题、有面积、没最小化
    let mut out: Vec<WindowRow> = rows
        .into_iter()
        .filter(|w| w.width > 0 && w.height > 0 && !w.minimized)
        .filter(|w| !w.title.is_empty() || !w.app.is_empty())
        .collect();
    out.truncate(limit.max(1));
    out
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    // 跳过工具窗口（WS_EX_TOOLWINDOW）：输入法、托盘浮层之类 ——
    // 与 PowerShell 实现逐项一致（那边同样判 0x80）。
    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if (ex_style & WS_EX_TOOLWINDOW) != 0 {
        return 1;
    }
    let rows = &mut *(lparam as *mut Vec<WindowRow>);

    let title = window_text(hwnd);
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    let app = process_name(pid);
    let class = class_name(hwnd);

    // ★ 只用 DWM 扩展边框，**不退回 GetWindowRect** —— 与 PowerShell 实现逐项一致。
    //
    //   GetWindowRect 在 Win10+ 会把不可见的阴影边距算进去（截出来的图右边/下边
    //   多一圈别的窗口）；而"DWM 取不到就跳过"正是旧实现的行为：
    //   退回 GetWindowRect 会让一批本该被过滤掉的窗口（WorkerW 之类）出现在列表里，
    //   两种实现的结果就对不上了。
    let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let hr = DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS as u32,
        &mut rect as *mut RECT as *mut c_void,
        std::mem::size_of::<RECT>() as u32,
    );
    if hr < 0 || rect.right <= rect.left || rect.bottom <= rect.top {
        return 1;
    }

    rows.push(WindowRow {
        handle: hwnd as usize,
        title,
        app,
        class,
        pid,
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        minimized: IsIconic(hwnd) != 0,
    });
    1
}
