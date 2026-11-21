use serde::Deserialize;

#[derive(Clone, Copy)]
pub(crate) struct Screen {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Deserialize)]
pub struct Selection {
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
}

fn crop_bounds(
    selection: Selection,
    width: u32,
    height: u32,
) -> Result<(u32, u32, u32, u32), &'static str> {
    let Selection {
        left,
        top,
        right,
        bottom,
    } = selection;
    if right > width || bottom > height || left >= right || top >= bottom {
        return Err("截图范围无效，请重新选择。");
    }
    if right - left < 2 || bottom - top < 2 {
        return Err("截图范围太小，请重新选择。");
    }
    Ok((left, top, right, bottom))
}

#[cfg(windows)]
mod platform {
    use image::{
        codecs::{
            jpeg::JpegEncoder,
            png::{CompressionType, FilterType, PngEncoder},
        },
        ExtendedColorType, ImageEncoder,
    };
    use std::{mem, ptr, slice};
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush, GetDC,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
        HBITMAP, HDC, HGDIOBJ, SRCCOPY,
    };

    use super::{crop_bounds, Screen, Selection};
    const FAIL: &str = "无法读取屏幕，请检查系统权限后重试。";
    const MAX_PIXELS: u64 = 80_000_000;
    const MAX_PNG_BYTES: usize = 10 * 1024 * 1024;

    pub(crate) struct Frame {
        screen: Screen,
        bgra: Vec<u8>,
    }

    struct ScreenDc(HDC);
    impl Drop for ScreenDc {
        fn drop(&mut self) {
            unsafe {
                ReleaseDC(ptr::null_mut(), self.0);
            }
        }
    }

    struct MemoryDc(HDC);
    impl Drop for MemoryDc {
        fn drop(&mut self) {
            unsafe {
                DeleteDC(self.0);
            }
        }
    }

    struct Bitmap(HBITMAP);
    impl Drop for Bitmap {
        fn drop(&mut self) {
            unsafe {
                DeleteObject(self.0);
            }
        }
    }

    struct SelectionGuard(HDC, HGDIOBJ);
    impl Drop for SelectionGuard {
        fn drop(&mut self) {
            unsafe {
                SelectObject(self.0, self.1);
            }
        }
    }

    impl Frame {
        pub fn capture(screen: Screen) -> Result<Self, &'static str> {
            let pixels = u64::from(screen.width) * u64::from(screen.height);
            if pixels == 0
                || pixels > MAX_PIXELS
                || screen.width > i32::MAX as u32
                || screen.height > i32::MAX as u32
            {
                return Err("屏幕分辨率超出截图范围。");
            }
            let width = screen.width as i32;
            let height = screen.height as i32;
            // The DIB owns its pixel buffer until after BitBlt and GdiFlush finish.
            let bgra = unsafe {
                let source = GetDC(ptr::null_mut());
                if source.is_null() {
                    return Err(FAIL);
                }
                let source = ScreenDc(source);
                let target = CreateCompatibleDC(source.0);
                if target.is_null() {
                    return Err(FAIL);
                }
                let target = MemoryDc(target);
                let info = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: width,
                        biHeight: -height,
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB,
                        ..BITMAPINFOHEADER::default()
                    },
                    ..BITMAPINFO::default()
                };
                let mut bytes = ptr::null_mut();
                let bitmap = CreateDIBSection(
                    source.0,
                    &info,
                    DIB_RGB_COLORS,
                    &mut bytes,
                    ptr::null_mut(),
                    0,
                );
                if bitmap.is_null() {
                    return Err(FAIL);
                }
                let bitmap = Bitmap(bitmap);
                if bytes.is_null() {
                    return Err(FAIL);
                }
                let selected = SelectObject(target.0, bitmap.0);
                if selected.is_null() || selected as isize == -1 {
                    return Err(FAIL);
                }
                let _selection = SelectionGuard(target.0, selected);
                if BitBlt(
                    target.0,
                    0,
                    0,
                    width,
                    height,
                    source.0,
                    screen.x,
                    screen.y,
                    SRCCOPY | CAPTUREBLT,
                ) == 0
                    || GdiFlush() == 0
                {
                    return Err(FAIL);
                }
                slice::from_raw_parts(bytes.cast::<u8>(), pixels as usize * 4).to_vec()
            };
            Ok(Self { screen, bgra })
        }

        pub fn preview(&self) -> Result<Vec<u8>, &'static str> {
            let width = self.screen.width;
            let height = self.screen.height;
            let longest = width.max(height);
            let preview_width = (width * 1_920 / longest.max(1_920)).max(1);
            let preview_height = (height * 1_920 / longest.max(1_920)).max(1);
            let mut rgb = Vec::with_capacity((preview_width * preview_height * 3) as usize);
            for y in 0..preview_height {
                let row = (y * height / preview_height) as usize * width as usize;
                for x in 0..preview_width {
                    let index = (row + (x * width / preview_width) as usize) * 4;
                    let pixel = &self.bgra[index..index + 3];
                    rgb.extend([pixel[2], pixel[1], pixel[0]]);
                }
            }
            let mut result = Vec::new();
            JpegEncoder::new_with_quality(&mut result, 88)
                .write_image(&rgb, preview_width, preview_height, ExtendedColorType::Rgb8)
                .map_err(|_| "无法生成截图预览。")?;
            Ok(result)
        }

        pub fn crop_png(&self, selection: Selection) -> Result<Vec<u8>, &'static str> {
            let (left, top, right, bottom) =
                crop_bounds(selection, self.screen.width, self.screen.height)?;
            let width = right - left;
            let height = bottom - top;
            let mut rgb = Vec::with_capacity((width * height * 3) as usize);
            let stride = self.screen.width as usize * 4;
            for y in top..bottom {
                let row = y as usize * stride;
                for pixel in
                    self.bgra[row + left as usize * 4..row + right as usize * 4].chunks_exact(4)
                {
                    rgb.extend([pixel[2], pixel[1], pixel[0]]);
                }
            }
            let mut result = Vec::new();
            PngEncoder::new_with_quality(&mut result, CompressionType::Fast, FilterType::Adaptive)
                .write_image(&rgb, width, height, ExtendedColorType::Rgb8)
                .map_err(|_| "无法生成截图文件。")?;
            if result.len() > MAX_PNG_BYTES {
                return Err("截图超过 10 MB，请缩小截图范围。");
            }
            Ok(result)
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub(crate) struct Frame;
    impl Frame {
        pub fn capture(_: super::Screen) -> Result<Self, &'static str> {
            Err("当前系统暂不支持原生截图。")
        }
        pub fn preview(&self) -> Result<Vec<u8>, &'static str> {
            Err("当前系统暂不支持原生截图。")
        }
        pub fn crop_png(&self, _: super::Selection) -> Result<Vec<u8>, &'static str> {
            Err("当前系统暂不支持原生截图。")
        }
    }
}

pub(crate) use platform::Frame;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_preserves_the_exact_displayed_pixel_count() {
        let selection = Selection {
            left: 181,
            top: 205,
            right: 438,
            bottom: 385,
        };
        assert_eq!(
            crop_bounds(selection, 1_920, 1_080).unwrap(),
            (181, 205, 438, 385)
        );
    }

    #[test]
    fn crop_accepts_a_region_up_to_the_screen_edges() {
        let selection = Selection {
            left: 960,
            top: 0,
            right: 1921,
            bottom: 1081,
        };
        assert_eq!(
            crop_bounds(selection, 1_921, 1_081).unwrap(),
            (960, 0, 1_921, 1_081)
        );
    }

    #[test]
    fn crop_rejects_invalid_and_tiny_regions() {
        for selection in [
            Selection {
                left: 25,
                top: 0,
                right: 20,
                bottom: 300,
            },
            Selection {
                left: 25,
                top: 0,
                right: 1_001,
                bottom: 40,
            },
            Selection {
                left: 0,
                top: 0,
                right: 1,
                bottom: 80,
            },
        ] {
            assert!(crop_bounds(selection, 1_000, 1_080).is_err());
        }
    }
}
