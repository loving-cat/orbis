//! 原生截图（SPEC-PERF-V1 §5.2 / §5.4 阶段 B）。
//!
//! ## 为什么截在图原生侧做
//!
//! 旧实现是 PowerShell：现起进程 + 现编译 P/Invoke + `System.Drawing` 存盘 + 再起一次
//! PowerShell 缩放。一次截图 1–3 次进程往返、几百毫秒，而且每次都要**碰用户文件系统**。
//!
//! 现在一次调用就够，并且**助手完全不写盘**：
//! 抓图 → 内存里缩放 → PNG → base64 从管道吐回去，由 Node 侧写受控的 outFile。
//! 这样即使助手被换掉/被利用，也没有「任意路径写文件」这个能力。
//!
//! ## 三条硬约束
//!
//! 1. **GDI 零泄漏**：常驻进程每漏一个 HDC/HBITMAP，最终会打爆 GDI 限额（每进程 ~10k）。
//!    这里所有句柄都走 RAII guard（`ScreenDc` / `MemDc` / `Dib`），异常路径也一定释放。
//! 2. **不缓存显示器 / DPI / 桌面句柄**：每次请求都重新取屏幕 DC 与窗口矩形。
//!    外接屏热插拔、改缩放、锁屏、UAC 安全桌面都会让上一次的口径失效。
//! 3. **老程序全黑要能兜住**：一部分程序 `PrintWindow` 只给一张纯黑图，
//!    所以抓完先做 `is_mostly_blank` 判断，几乎全单色就退回屏幕 `BitBlt`。

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ, SRCCOPY,
};
use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;

// windows-sys 0.59 把 PrintWindow 放在 Win32::Storage::Xps（要额外开一个大 feature）。
// 这里只有这一个函数，自己声明比为一个符号打开整个 Xps 模块划算 ——
// 与 win.rs 里 SetProcessDPIAware 的处理方式一致。
#[link(name = "user32")]
extern "system" {
    fn PrintWindow(hwnd: HWND, hdc_blt: *mut c_void, flags: u32) -> i32;
}

/// `PW_RENDERFULLCONTENT`：让 PrintWindow 抓 DWM 合成后的内容（Win8.1+）。
/// windows-sys 没有导这个名字，值就是 2。
const PW_RENDERFULLCONTENT: u32 = 2;

/// 默认长边上限（与 desktop-observe.js 的 MAX_EDGE 一致）。
pub const DEFAULT_MAX_EDGE: u32 = 1600;

// ---------------------------------------------------------------- RAII guards

/// 屏幕/窗口 DC：`GetDC` 一定要配 `ReleaseDC`。
struct ScreenDc(HWND, *mut c_void);

impl ScreenDc {
    fn acquire(hwnd: HWND) -> Option<ScreenDc> {
        let hdc = unsafe { GetDC(hwnd) };
        if hdc.is_null() {
            None
        } else {
            Some(ScreenDc(hwnd, hdc))
        }
    }
    fn raw(&self) -> *mut c_void {
        self.1
    }
}

impl Drop for ScreenDc {
    fn drop(&mut self) {
        unsafe {
            ReleaseDC(self.0, self.1);
        }
    }
}

/// 内存 DC：`CreateCompatibleDC` 配 `DeleteDC`。
struct MemDc(*mut c_void);

impl MemDc {
    fn new(src: *mut c_void) -> Option<MemDc> {
        let dc = unsafe { CreateCompatibleDC(src) };
        if dc.is_null() {
            None
        } else {
            Some(MemDc(dc))
        }
    }
    fn raw(&self) -> *mut c_void {
        self.0
    }
}

impl Drop for MemDc {
    fn drop(&mut self) {
        unsafe {
            DeleteDC(self.0);
        }
    }
}

/// 32bpp top-down DIBSection：配 `DeleteObject`（选进 DC 时要先 SelectObject 回来）。
struct Dib {
    handle: *mut c_void,
    bits: *mut c_void,
    previous: HGDIOBJ,
    dc: *mut c_void,
}

impl Dib {
    fn new(dc: *mut c_void, width: i32, height: i32) -> Option<Dib> {
        if width <= 0 || height <= 0 {
            return None;
        }
        unsafe {
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = width;
            // 负高度 = top-down：内存里第一行就是图像最上面一行，
            // 省掉一次垂直翻转，也让 PNG 的扫描顺序天然正确。
            info.bmiHeader.biHeight = -height;
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB;

            let mut bits: *mut c_void = std::ptr::null_mut();
            let handle = CreateDIBSection(
                dc,
                &info,
                DIB_RGB_COLORS,
                &mut bits,
                std::ptr::null_mut(),
                0,
            );
            if handle.is_null() || bits.is_null() {
                if !handle.is_null() {
                    DeleteObject(handle as HGDIOBJ);
                }
                return None;
            }
            let previous = SelectObject(dc, handle as HGDIOBJ);
            Some(Dib { handle, bits, previous, dc })
        }
    }

    fn pixels(&self) -> *mut u8 {
        self.bits as *mut u8
    }
}

impl Drop for Dib {
    fn drop(&mut self) {
        unsafe {
            // 先把原来的位图选回去，否则 DeleteObject 会对「仍被选中的位图」失败，
            // 句柄就漏了 —— 这正是常驻进程最怕的那种慢性泄漏。
            SelectObject(self.dc, self.previous);
            DeleteObject(self.handle as HGDIOBJ);
        }
    }
}

// ---------------------------------------------------------------- 抓图

/// 抓到的图（RGBA，逐行 top-down）。
pub struct Shot {
    pub width: u32,
    pub height: u32,
    pub original_width: u32,
    pub original_height: u32,
    pub resized: bool,
    pub method: &'static str,
    pub rgba: Vec<u8>,
}

/// 从某个 DC 的一块区域抓像素（BGRA → RGBA，alpha 一律补满）。
fn grab_from(src: *mut c_void, x: i32, y: i32, width: i32, height: i32) -> Option<Vec<u8>> {
    let mem = MemDc::new(src)?;
    let dib = Dib::new(mem.raw(), width, height)?;
    let ok = unsafe { BitBlt(mem.raw(), 0, 0, width, height, src, x, y, SRCCOPY) };
    if ok == 0 {
        return None;
    }
    // ★ 必须在 Dib drop 之前拷贝：Drop 一跑，位图内存就归还给系统了。
    let len = (width as usize) * (height as usize) * 4;
    let mut rgba = vec![0u8; len];
    unsafe {
        std::ptr::copy_nonoverlapping(dib.pixels(), rgba.as_mut_ptr(), len);
    }
    for px in rgba.chunks_exact_mut(4) {
        px.swap(0, 2); // BGRA → RGBA
        px[3] = 255; // DIB 的 alpha 常常是 0，不补满会得到全透明 PNG
    }
    Some(rgba)
}

/// 用 `PrintWindow` 抓一个窗口（含 DWM 合成的阴影/圆角）。
fn grab_window(hwnd: HWND, width: i32, height: i32) -> Option<Vec<u8>> {
    let screen = ScreenDc::acquire(std::ptr::null_mut())?;
    let mem = MemDc::new(screen.raw())?;
    let dib = Dib::new(mem.raw(), width, height)?;
    let ok = unsafe { PrintWindow(hwnd, mem.raw(), PW_RENDERFULLCONTENT) };
    if ok == 0 {
        return None;
    }
    let len = (width as usize) * (height as usize) * 4;
    let mut rgba = vec![0u8; len];
    unsafe {
        std::ptr::copy_nonoverlapping(dib.pixels(), rgba.as_mut_ptr(), len);
    }
    for px in rgba.chunks_exact_mut(4) {
        px.swap(0, 2);
        px[3] = 255;
    }
    Some(rgba)
}

/// 窗口的物理矩形：优先 DWM 扩展边框，取不到退 `GetWindowRect`。
///
/// 与 `list_windows` 的差别是**这里要退回 GetWindowRect**：列表要的是「能点得准」
/// 的可见区域，截图要的是「别截成 0×0」。两者取舍不同，所以不共用同一个过滤。
fn window_rect(hwnd: HWND) -> Option<(i32, i32, i32, i32)> {
    unsafe {
        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let dwm = windows_sys::Win32::Graphics::Dwm::DwmGetWindowAttribute(
            hwnd,
            windows_sys::Win32::Graphics::Dwm::DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            &mut rect as *mut RECT as *mut c_void,
            std::mem::size_of::<RECT>() as u32,
        );
        let ok_by_dwm = dwm >= 0 && rect.right > rect.left && rect.bottom > rect.top;
        if !ok_by_dwm {
            if GetWindowRect(hwnd, &mut rect) == 0 {
                return None;
            }
        }
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return None;
        }
        Some((rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top))
    }
}

/// 这张图是不是「几乎全单色」（老程序 PrintWindow 只给全黑就是这个形态）。
///
/// 按网格采样而不看全部像素：一张 2560×1440 有 370 万像素，全扫一遍没必要，
/// 而这个判断只用来决定「要不要退回 BitBlt」，容忍偶尔的误判。
pub fn is_mostly_blank(rgba: &[u8], width: u32, height: u32) -> bool {
    if width < 2 || height < 2 || rgba.len() < 4 {
        return true;
    }
    let step_x = (width / 16).max(1) as usize;
    let step_y = (height / 16).max(1) as usize;
    let stride = (width as usize) * 4;
    let mut first: Option<(u8, u8, u8)> = None;
    let mut same = 0usize;
    let mut total = 0usize;
    let mut y = 0usize;
    while y < height as usize {
        let mut x = 0usize;
        while x < width as usize {
            let i = y * stride + x * 4;
            let (r, g, b) = (rgba[i], rgba[i + 1], rgba[i + 2]);
            total += 1;
            match first {
                None => first = Some((r, g, b)),
                Some((fr, fg, fb)) => {
                    // 允许 ±2 的抗锯齿/量化抖动，否则「纯色但带一点噪声」会漏判
                    if r.abs_diff(fr) <= 2 && g.abs_diff(fg) <= 2 && b.abs_diff(fb) <= 2 {
                        same += 1;
                    }
                }
            }
            x += step_x;
        }
        y += step_y;
    }
    total > 0 && first.is_some() && same * 100 >= total * 98
}

/// 盒滤波缩小到长边 `max_edge` 以内（纯 Rust，不引 image）。
///
/// 放大不做：比例超采样没有意义（源就那么多像素），这里只在需要**缩小**时跑。
pub fn downscale(rgba: &[u8], width: u32, height: u32, max_edge: u32) -> (Vec<u8>, u32, u32) {
    let longest = width.max(height);
    if max_edge == 0 || longest <= max_edge {
        return (rgba.to_vec(), width, height);
    }
    let scale = max_edge as f64 / longest as f64;
    let dw = ((width as f64 * scale).round() as u32).max(1);
    let dh = ((height as f64 * scale).round() as u32).max(1);
    let mut out = vec![0u8; (dw as usize) * (dh as usize) * 4];

    for dy in 0..dh {
        // 目标像素覆盖的源区间（box）：面积的加权平均，比最近邻好得多，
        // 又比真正的双线性少一半边界处理。
        let y0 = (dy as u64 * height as u64 / dh as u64) as u32;
        let y1 = (((dy + 1) as u64 * height as u64 + dh as u64 - 1) / dh as u64).min(height as u64) as u32;
        let y1 = y1.max(y0 + 1).min(height);
        for dx in 0..dw {
            let x0 = (dx as u64 * width as u64 / dw as u64) as u32;
            let x1 = (((dx + 1) as u64 * width as u64 + dw as u64 - 1) / dw as u64).min(width as u64) as u32;
            let x1 = x1.max(x0 + 1).min(width);
            let (mut r, mut g, mut b, mut n) = (0u64, 0u64, 0u64, 0u64);
            for sy in y0..y1 {
                let base = (sy as usize) * (width as usize) * 4;
                for sx in x0..x1 {
                    let i = base + (sx as usize) * 4;
                    r += rgba[i] as u64;
                    g += rgba[i + 1] as u64;
                    b += rgba[i + 2] as u64;
                    n += 1;
                }
            }
            let o = ((dy as usize) * (dw as usize) + dx as usize) * 4;
            if n > 0 {
                out[o] = (r / n) as u8;
                out[o + 1] = (g / n) as u8;
                out[o + 2] = (b / n) as u8;
            }
            out[o + 3] = 255;
        }
    }
    (out, dw, dh)
}

/// PNG 编码（`Compression::Fast`：截图的编码时间要算进 150 ms 预算里）。
pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|e| format!("png header: {e}"))?;
        writer
            .write_image_data(rgba)
            .map_err(|e| format!("png data: {e}"))?;
        writer.finish().map_err(|e| format!("png finish: {e}"))?;
    }
    Ok(out)
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 轻量 base64 编码（标准字母表 + `=` 填充）。
///
/// 不引 base64 crate：这里只需要编码、输入是内存里的 PNG 字节，
/// 40 行够用，也少一个依赖要登记许可。
pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

/// base64 解码（单测与 Node 侧对拍用；助手本身不需要解码）。
#[cfg_attr(not(test), allow(dead_code))]
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0u32;
    for ch in text.bytes() {
        if ch == b'=' || ch == b'\n' || ch == b'\r' || ch == b' ' {
            continue;
        }
        let v = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            buf.push(((acc >> bits) & 0xff) as u8);
        }
    }
    Some(buf)
}

/// 一次截图：窗口（`hwnd > 0`）或屏幕矩形（`rect`）。
///
/// `hwnd` 优先。窗口抓失败或几乎是单色时自动退回屏幕 BitBlt 同一矩形 ——
/// 老程序（DirectX 独占、精简的 WPF）就是靠这条兜住的。
pub fn capture(
    hwnd: i64,
    rect: Option<(i32, i32, i32, i32)>,
    max_edge: u32,
) -> Result<Shot, String> {
    let max_edge = if max_edge == 0 { DEFAULT_MAX_EDGE } else { max_edge };

    let (mut rgba, w, h, method) = if hwnd > 0 {
        let handle = hwnd as usize as HWND;
        let (x, y, w, h) = window_rect(handle).ok_or_else(|| "取不到窗口矩形".to_string())?;
        match grab_window(handle, w, h) {
            Some(pixels) if !is_mostly_blank(&pixels, w as u32, h as u32) => {
                (pixels, w as u32, h as u32, "print_window")
            }
            // PrintWindow 失败或只给了一张纯色 → 从屏幕上那个矩形抓
            _ => {
                let screen = ScreenDc::acquire(std::ptr::null_mut())
                    .ok_or_else(|| "取不到屏幕 DC".to_string())?;
                let pixels = grab_from(screen.raw(), x, y, w, h)
                    .ok_or_else(|| "从屏幕抓窗口区域失败".to_string())?;
                (pixels, w as u32, h as u32, "bitblt")
            }
        }
    } else {
        let (x, y, w, h) = rect.ok_or_else(|| "既没有窗口也没有矩形".to_string())?;
        if w <= 0 || h <= 0 {
            return Err("矩形宽高必须为正".to_string());
        }
        let screen = ScreenDc::acquire(std::ptr::null_mut())
            .ok_or_else(|| "取不到屏幕 DC".to_string())?;
        let pixels = grab_from(screen.raw(), x, y, w, h)
            .ok_or_else(|| "从屏幕抓区域失败".to_string())?;
        (pixels, w as u32, h as u32, "bitblt")
    };

    let (ow, oh) = (w, h);
    let resized = w.max(h) > max_edge;
    if resized {
        let (small, dw, dh) = downscale(&rgba, w, h, max_edge);
        rgba = small;
        return Ok(Shot {
            width: dw,
            height: dh,
            original_width: ow,
            original_height: oh,
            resized: true,
            method,
            rgba,
        });
    }
    Ok(Shot {
        width: w,
        height: h,
        original_width: ow,
        original_height: oh,
        resized: false,
        method,
        rgba,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downscale_keeps_aspect_and_fits_edge() {
        let w = 400u32;
        let h = 200u32;
        let data = vec![128u8; (w as usize) * (h as usize) * 4];
        let (out, dw, dh) = downscale(&data, w, h, 100);
        assert_eq!((dw, dh), (100, 50), "长边收到 100，宽高比不变");
        assert_eq!(out.len(), (dw as usize) * (dh as usize) * 4);
        // 纯色缩完还是纯色
        assert!(out.chunks_exact(4).all(|p| p[0] == 128 && p[3] == 255));
    }

    #[test]
    fn downscale_is_noop_when_within_edge() {
        let (out, dw, dh) = downscale(&[7u8; 16], 2, 2, DEFAULT_MAX_EDGE);
        assert_eq!((dw, dh), (2, 2));
        assert_eq!(out.len(), 16);
    }

    #[test]
    fn downscale_odd_sizes_never_zero() {
        let w = 1601u32;
        let h = 3u32;
        let data = vec![9u8; (w as usize) * (h as usize) * 4];
        let (_, dw, dh) = downscale(&data, w, h, 1600);
        assert!(dw >= 1 && dh >= 1, "窄条也要至少 1px，不能出现 0 宽");
        assert!(dw <= 1600);
    }

    #[test]
    fn blank_detection_covers_black_white_and_gradient() {
        let w = 32u32;
        let h = 32u32;
        let black = vec![0u8; (w as usize) * (h as usize) * 4];
        assert!(is_mostly_blank(&black, w, h), "全黑算空白（老程序 PrintWindow 的典型形态）");

        let mut white = black.clone();
        for px in white.chunks_exact_mut(4) {
            px[0] = 255;
            px[1] = 255;
            px[2] = 255;
            px[3] = 255;
        }
        assert!(is_mostly_blank(&white, w, h), "全白也算空白");

        let mut gradient = black.clone();
        for y in 0..h as usize {
            for x in 0..w as usize {
                let i = (y * w as usize + x) * 4;
                gradient[i] = (x * 8) as u8;
                gradient[i + 1] = (y * 8) as u8;
                gradient[i + 2] = 64;
                gradient[i + 3] = 255;
            }
        }
        assert!(!is_mostly_blank(&gradient, w, h), "真实渐变不是空白");
    }

    #[test]
    fn blank_detection_handles_tiny_images() {
        assert!(is_mostly_blank(&[], 0, 0));
        assert!(is_mostly_blank(&[1, 2, 3, 4], 1, 1), "1×1 没法判断，按空白处理");
    }

    #[test]
    fn png_header_matches_pixels() {
        let w = 5u32;
        let h = 3u32;
        let data = vec![200u8; (w as usize) * (h as usize) * 4];
        let png = encode_png(&data, w, h).expect("编码应成功");
        assert_eq!(&png[1..4], b"PNG", "PNG 魔数");
        // IHDR 的宽高在固定偏移：8(sig) + 4(len) + 4(type) + 4 = 16
        let read_u32 = |at: usize| u32::from_be_bytes([png[at], png[at + 1], png[at + 2], png[at + 3]]);
        assert_eq!(read_u32(16), w, "IHDR 宽要等于实际宽");
        assert_eq!(read_u32(20), h, "IHDR 高要等于实际高");
    }

    #[test]
    fn base64_roundtrip() {
        for sample in [&b""[..], &b"a"[..], &b"ab"[..], &b"abc"[..], &b"hello world"[..]] {
            let enc = base64_encode(sample);
            let dec = base64_decode(&enc).expect("应能解回来");
            assert_eq!(dec, sample.to_vec(), "base64 往返要一致：{enc}");
        }
        assert_eq!(base64_encode(b"abc"), "YWJj");
        assert_eq!(base64_encode(b"ab"), "YWI=");
        assert_eq!(base64_encode(b"a"), "YQ==");
    }
}
