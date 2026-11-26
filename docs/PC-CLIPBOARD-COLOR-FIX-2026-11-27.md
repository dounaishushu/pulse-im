# PC 图片复制失败与偏色修复（2026-11-27）

## 1. 计划

用户要求检查 PC 偶发“无法写入图片到剪贴板，请重试。”及复制后变蓝、失真的问题。本轮范围是指定的 `E:/多窗口项目/IM开发/go-rewrite`，沿用当前 Tauri + Vue + Go v2 客户端。已有 PC 修复与剪贴板备份、临时测试、恢复授权继续有效。

先只读检查图片来源、解码与 Windows 写入；用受授权控制器复现；修复同一格式缺陷并留下回归；核对真实 Windows Ctrl+V 与原图；在隔离副本生成安装包。该请求和前续修复授权覆盖本轮，不重复请求相同授权。没有改后端、协议、新依赖或 Android。

## 2. 每个 Bug：根因、文件及理由

本轮两个可见现象来自同一处缺陷：`clipboard-win 5.4.3` 的 `set_bitmap_inner` 把 BMP 信息头复制到只有 40 字节的 `BITMAPINFOHEADER`，再将这个局部结构传入 `CreateDIBitmap`。旧客户端的 BMP 编码可能输出带 108 字节头及颜色掩码的 RGBA 图，或带调色板的灰度图；额外信息未随局部头完整传入 GDI。真实 Windows 基线中 RGB 正常，RGBA 写入失败，灰度及灰度加 alpha 各 551/551 像素错误。

修改 `pc-tauri/src-tauri/src/archive_reader.rs`：解码后将各种颜色模式规范到 RGBA8，以完整 124 字节 `BITMAPV5HEADER`、明确的 BGRA 掩码、sRGB 和从上到下的行生成内存位图，直接发表 CF_DIBV5。保留原始宽高，无截图、缩放或 JPEG 再编码。先准备好数据再开剪贴板，仍以真实 HWND 在同一锁内清除旧 PNG/HTML 等格式，防止旧图片残留。Windows 可自动提供兼容的 CF_BITMAP。

透明图片另提供当前图片的无损 PNG：实际测试发现仅发表 DIBV5 时，Chrome 粘贴会把 alpha 变为 255；加当前 PNG 后透明度与颜色通过完整像素核对。不透明图片不增加 PNG 编码。

格式依据见 [Microsoft BITMAPV5HEADER](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-bitmapv5header) 与 [Clipboard Formats](https://learn.microsoft.com/en-gb/windows/win32/dataxchg/clipboard-formats)。这两份规范分别定义掩码、色彩空间、行方向及建议的 DIB 剪贴板格式；本轮通过本机实测确认代码行为。

主聊天、独立会话、聊天记录和图片窗口沿用同一 Reader 入口，因此共用修复。新增 `pc-tauri/src-tauri/src/clipboard_bitmap_tests.rs` 覆盖颜色模式、16 位来源归一、透明度、奇数宽度/竖图、PNG/JPEG/WebP/GIF/BMP、上限与无效输入；新增 `web-vue/tests/image-clipboard-system-paste.e2e.cjs` 用生产 Vue 输入框执行真实键盘粘贴，读取 OS 交付的 File 并核对全部像素摘要，再核对放大预览。其 192 像素缩略图按既有逻辑显示，未改产品 UI。

## 3. 完整 diff

下面包含全部产品及测试差异，不包含本报告本身。产品改动集中在原有解码/写入处；其余为测试及测试保护控制器复用，没有重构其他功能。版本只在隔离构建副本升至 2.4.233，工作区五个既有版本文件保持 2.4.232。

```diff
diff --git a/pc-tauri/src-tauri/src/archive_reader.rs b/pc-tauri/src-tauri/src/archive_reader.rs
index 9bb51bc..fcbd85e 100644
--- a/pc-tauri/src-tauri/src/archive_reader.rs
+++ b/pc-tauri/src-tauri/src/archive_reader.rs
@@ -475,4 +475 @@ fn decode_image(bytes: Vec<u8>, cancel: CancellationToken) -> Result<Vec<u8>, &'
-    let mut bitmap = Cursor::new(Vec::new());
-    image
-        .write_to(&mut bitmap, image::ImageFormat::Bmp)
-        .map_err(|_| "无法生成剪贴板图片。")?;
+    let bitmap = clipboard_bitmap(&image.to_rgba8());
@@ -482 +479,40 @@ fn decode_image(bytes: Vec<u8>, cancel: CancellationToken) -> Result<Vec<u8>, &'
-    Ok(bitmap.into_inner())
+    Ok(bitmap)
+}
+
+#[cfg(windows)]
+fn clipboard_bitmap(image: &image::RgbaImage) -> Vec<u8> {
+    // A complete BITMAPV5HEADER: fixed BGRA masks, sRGB and top-down rows.
+    // Do not pass a truncated BITMAPINFOHEADER to a GDI bitmap setter: PNGs
+    // with alpha or a gray palette require information beyond its 40 bytes.
+    const PIXELS: usize = 14 + 124;
+    let mut bitmap = vec![0u8; PIXELS + image.as_raw().len()];
+    bitmap[..2].copy_from_slice(b"BM");
+    let size = bitmap.len() as u32;
+    bitmap[2..6].copy_from_slice(&size.to_le_bytes());
+    bitmap[10..14].copy_from_slice(&(PIXELS as u32).to_le_bytes());
+    let dib = &mut bitmap[14..];
+    dib[..4].copy_from_slice(&124u32.to_le_bytes());
+    dib[4..8].copy_from_slice(&(image.width() as i32).to_le_bytes());
+    dib[8..12].copy_from_slice(&(-(image.height() as i32)).to_le_bytes());
+    dib[12..14].copy_from_slice(&1u16.to_le_bytes());
+    dib[14..16].copy_from_slice(&32u16.to_le_bytes());
+    dib[16..20].copy_from_slice(&3u32.to_le_bytes()); // BI_BITFIELDS
+    dib[20..24].copy_from_slice(&(image.as_raw().len() as u32).to_le_bytes());
+    for (offset, mask) in [
+        (40, 0x00ff0000u32),
+        (44, 0x0000ff00),
+        (48, 0x000000ff),
+        (52, 0xff000000),
+    ] {
+        dib[offset..offset + 4].copy_from_slice(&mask.to_le_bytes());
+    }
+    dib[56..60].copy_from_slice(&0x73524742u32.to_le_bytes()); // LCS_sRGB
+    dib[108..112].copy_from_slice(&4u32.to_le_bytes()); // LCS_GM_IMAGES
+    for (rgba, bgra) in image
+        .as_raw()
+        .chunks_exact(4)
+        .zip(dib[124..].chunks_exact_mut(4))
+    {
+        bgra.copy_from_slice(&[rgba[2], rgba[1], rgba[0], rgba[3]]);
+    }
+    bitmap
@@ -486,0 +523,19 @@ fn write_image(owner: usize, bytes: &[u8]) -> Result<(), &'static str> {
+    let dib = bytes
+        .get(14..)
+        .filter(|dib| dib.len() > 124 && dib[..4] == 124u32.to_le_bytes())
+        .ok_or("无法生成剪贴板图片。")?;
+    // Some paste targets discard DIB alpha. Offer a lossless PNG for those
+    // images, prepared before opening the clipboard; opaque copies need no
+    // additional image encoding.
+    let png = if dib[124..].chunks_exact(4).any(|pixel| pixel[3] != 255) {
+        let mut png = std::io::Cursor::new(Vec::new());
+        image::load_from_memory_with_format(bytes, image::ImageFormat::Bmp)
+            .and_then(|image| image.write_to(&mut png, image::ImageFormat::Png))
+            .map_err(|_| "无法生成剪贴板图片。")?;
+        let format = clipboard_win::register_format("PNG")
+            .ok_or("无法生成剪贴板图片。")?
+            .get();
+        Some((format, png.into_inner()))
+    } else {
+        None
+    };
@@ -489,3 +544,3 @@ fn write_image(owner: usize, bytes: &[u8]) -> Result<(), &'static str> {
-    // Bitmap's default setter appends CF_BITMAP, leaving older PNG/DIB/HTML
-    // formats that WebView2 can prefer when pasting. Replace all formats under
-    // one lock with a real window owner so EmptyClipboard/SetClipboardData work.
+    // Publish the entire device-independent header and pixels. Windows can
+    // synthesize legacy bitmap formats without losing the masks or palette.
+    // Replace previous PNG/HTML formats under one lock and a real window owner.
@@ -493 +548,6 @@ fn write_image(owner: usize, bytes: &[u8]) -> Result<(), &'static str> {
-    clipboard_win::raw::set_bitmap(bytes).map_err(|_| "无法写入图片到剪贴板，请重试。")
+    if let Some((format, png)) = png {
+        clipboard_win::raw::set_without_clear(format, &png)
+            .map_err(|_| "无法写入图片到剪贴板，请重试。")?;
+    }
+    clipboard_win::raw::set_without_clear(clipboard_win::formats::CF_DIBV5, dib)
+        .map_err(|_| "无法写入图片到剪贴板，请重试。")
@@ -505,0 +566,4 @@ fn write_image(_owner: usize, _bytes: &[u8]) -> Result<(), &'static str> {
+#[cfg(all(test, windows))]
+#[path = "clipboard_bitmap_tests.rs"]
+mod clipboard_bitmap_tests;
+
@@ -510,3 +574,11 @@ mod image_tests {
-    #[test]
-    #[ignore = "requires an isolated clipboard or explicit user-authorized backup/restore controller"]
-    fn windows_clipboard_replaces_previous_image_formats() {
+    struct TestOwner(windows_sys::Win32::Foundation::HWND);
+
+    impl Drop for TestOwner {
+        fn drop(&mut self) {
+            unsafe {
+                windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(self.0);
+            }
+        }
+    }
+
+    fn test_clipboard_owner() -> TestOwner {
@@ -555,11 +627 @@ mod image_tests {
-        use windows_sys::Win32::UI::WindowsAndMessaging::{
-            CreateWindowExW, DestroyWindow, HWND_MESSAGE,
-        };
-        struct Owner(windows_sys::Win32::Foundation::HWND);
-        impl Drop for Owner {
-            fn drop(&mut self) {
-                unsafe {
-                    DestroyWindow(self.0);
-                }
-            }
-        }
+        use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, HWND_MESSAGE};
@@ -567 +629 @@ mod image_tests {
-        let owner = Owner(unsafe {
+        let owner = TestOwner(unsafe {
@@ -583,0 +646,109 @@ mod image_tests {
+        owner
+    }
+
+    #[test]
+    #[ignore = "requires an isolated clipboard or explicit user-authorized backup/restore controller"]
+    fn windows_clipboard_color_modes() {
+        let owner = test_clipboard_owner();
+        let rgb = image::RgbImage::from_fn(29, 19, |x, y| {
+            image::Rgb([(x * 7) as u8, (y * 11) as u8, 150])
+        });
+        let variants = [
+            ("rgb", image::DynamicImage::ImageRgb8(rgb.clone())),
+            (
+                "rgba",
+                image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(29, 19, |x, y| {
+                    image::Rgba([(x * 7) as u8, (y * 11) as u8, 150, 255])
+                })),
+            ),
+            (
+                "gray",
+                image::DynamicImage::ImageLuma8(image::GrayImage::from_fn(29, 19, |x, y| {
+                    image::Luma([((x + y) * 5) as u8])
+                })),
+            ),
+            (
+                "gray-alpha",
+                image::DynamicImage::ImageLumaA8(image::GrayAlphaImage::from_fn(29, 19, |x, y| {
+                    image::LumaA([((x + y) * 5) as u8, 255])
+                })),
+            ),
+            (
+                "transparent",
+                image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(29, 19, |x, y| {
+                    image::Rgba([
+                        (x * 7) as u8,
+                        (y * 11) as u8,
+                        150,
+                        [0, 64, 128, 255][(x % 4) as usize],
+                    ])
+                })),
+            ),
+            (
+                "large-rgba",
+                image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(566, 1088, |x, y| {
+                    image::Rgba([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255])
+                })),
+            ),
+        ];
+        let mut failed = Vec::new();
+        for (name, selected) in variants {
+            if std::env::var("PULSE_CLIPBOARD_COLOR_CASE").is_ok_and(|value| value != name) {
+                continue;
+            }
+            let mut png = std::io::Cursor::new(Vec::new());
+            selected
+                .write_to(&mut png, image::ImageFormat::Png)
+                .unwrap();
+            if let Some(output) = std::env::var_os("PULSE_CLIPBOARD_TEST_OUTPUT") {
+                std::fs::write(
+                    std::path::Path::new(&output).join("selected.png"),
+                    png.get_ref(),
+                )
+                .unwrap();
+            }
+            let bitmap = decode_image(png.get_ref().clone(), CancellationToken::new()).unwrap();
+            let result = write_image(owner.0 as usize, &bitmap);
+            if let Err(error) = result {
+                println!("COLOR {name}: write failed: {error}");
+                failed.push(name);
+                continue;
+            }
+            let _clipboard = clipboard_win::Clipboard::new_attempts(10).unwrap();
+            let dib: Vec<u8> = clipboard_win::get(clipboard_win::formats::RawData(
+                clipboard_win::formats::CF_DIBV5,
+            ))
+            .unwrap();
+            assert_eq!(
+                dib,
+                bitmap[14..],
+                "native DIBV5 must preserve all masks, colors and alpha"
+            );
+            let actual: Vec<u8> = clipboard_win::get(clipboard_win::formats::Bitmap).unwrap();
+            let actual = image::load_from_memory_with_format(&actual, image::ImageFormat::Bmp)
+                .unwrap()
+                .to_rgb8();
+            let expected = selected.to_rgb8();
+            let differences = actual
+                .pixels()
+                .zip(expected.pixels())
+                .filter(|(a, b)| a != b)
+                .count();
+            println!(
+                "COLOR {name}: dimensions={:?}, pixel mismatches={differences}",
+                actual.dimensions()
+            );
+            if differences != 0 || actual.dimensions() != expected.dimensions() {
+                failed.push(name);
+            }
+        }
+        assert!(
+            failed.is_empty(),
+            "clipboard corrupts color modes: {failed:?}"
+        );
+    }
+
+    #[test]
+    #[ignore = "requires an isolated clipboard or explicit user-authorized backup/restore controller"]
+    fn windows_clipboard_replaces_previous_image_formats() {
+        let owner = test_clipboard_owner();
diff --git a/pc-tauri/src-tauri/src/clipboard_bitmap_tests.rs b/pc-tauri/src-tauri/src/clipboard_bitmap_tests.rs
new file mode 100644
--- /dev/null
+++ b/pc-tauri/src-tauri/src/clipboard_bitmap_tests.rs
@@ -0,0 +1,87 @@
+use super::*;
+use image::{DynamicImage, ImageFormat, RgbaImage};
+use std::io::Cursor;
+
+fn round_trip(image: &DynamicImage, format: ImageFormat) {
+    let mut encoded = Cursor::new(Vec::new());
+    image.write_to(&mut encoded, format).unwrap();
+    let source = image::load_from_memory(encoded.get_ref())
+        .unwrap()
+        .to_rgba8();
+    let bitmap = decode_image(encoded.into_inner(), CancellationToken::new()).unwrap();
+    let decoded = image::load_from_memory_with_format(&bitmap, ImageFormat::Bmp)
+        .unwrap()
+        .to_rgba8();
+    assert_eq!(
+        decoded, source,
+        "copy must preserve dimensions, orientation, RGB and alpha for {format:?}"
+    );
+}
+
+#[test]
+fn alpha_and_gray_sources_keep_all_pixels_without_a_palette_dependency() {
+    let rgba = RgbaImage::from_fn(29, 19, |x, y| {
+        image::Rgba([
+            (x * 7) as u8,
+            (y * 11) as u8,
+            150,
+            [0, 64, 128, 255][(x % 4) as usize],
+        ])
+    });
+    let color = DynamicImage::ImageRgba8(rgba);
+    for source in [
+        color.clone(),
+        DynamicImage::ImageLuma8(color.to_luma8()),
+        DynamicImage::ImageLumaA8(color.to_luma_alpha8()),
+        DynamicImage::ImageLuma16(color.to_luma16()),
+        DynamicImage::ImageLumaA16(color.to_luma_alpha16()),
+        DynamicImage::ImageRgb16(color.to_rgb16()),
+        DynamicImage::ImageRgba16(color.to_rgba16()),
+    ] {
+        round_trip(&source, ImageFormat::Png);
+    }
+}
+
+#[test]
+fn odd_width_and_tall_images_keep_original_resolution_and_orientation() {
+    for (width, height) in [(1, 1), (3, 17), (29, 19), (566, 1088)] {
+        let image = DynamicImage::ImageRgba8(RgbaImage::from_fn(width, height, |x, y| {
+            image::Rgba([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255])
+        }));
+        round_trip(&image, ImageFormat::Png);
+    }
+}
+
+#[test]
+fn supported_file_formats_copy_their_decoded_pixels_without_another_lossy_encode() {
+    let image = DynamicImage::ImageRgba8(RgbaImage::from_fn(31, 21, |x, y| {
+        image::Rgba([(x * 7) as u8, (y * 11) as u8, 150, 255])
+    }));
+    for format in [
+        ImageFormat::Png,
+        ImageFormat::Bmp,
+        ImageFormat::Gif,
+        ImageFormat::WebP,
+    ] {
+        round_trip(&image, format);
+    }
+    round_trip(&DynamicImage::ImageRgb8(image.to_rgb8()), ImageFormat::Jpeg);
+}
+
+#[test]
+fn oversized_or_cancelled_input_is_rejected_before_clipboard_publication() {
+    let image = DynamicImage::ImageRgb8(image::RgbImage::new(10_001, 1));
+    let mut png = Cursor::new(Vec::new());
+    image.write_to(&mut png, ImageFormat::Png).unwrap();
+    assert!(decode_image(png.into_inner(), CancellationToken::new()).is_err());
+    let cancelled = CancellationToken::new();
+    cancelled.cancel();
+    assert!(decode_image(vec![0; 100], cancelled).is_err());
+}
+
+#[test]
+fn invalid_bitmap_is_rejected_without_opening_or_clearing_the_clipboard() {
+    for bytes in [vec![], vec![0; 14], vec![0; 1000]] {
+        assert_eq!(write_image(0, &bytes), Err("无法生成剪贴板图片。"));
+    }
+}
diff --git a/web-vue/tests/image-clipboard-system-paste.e2e.cjs b/web-vue/tests/image-clipboard-system-paste.e2e.cjs
new file mode 100644
--- /dev/null
+++ b/web-vue/tests/image-clipboard-system-paste.e2e.cjs
@@ -0,0 +1,65 @@
+// Read-only OS clipboard probe. A separate authorized controller seeds/restores
+// the clipboard; this test uses a genuine Ctrl+V in the production composer.
+const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
+const { pathToFileURL } = require('node:url');
+const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
+const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
+const expectedFile = process.env.PULSE_CLIPBOARD_EXPECTED_PNG;
+const output = process.env.PULSE_CLIPBOARD_PASTE_OUTPUT;
+assert(expectedFile && output, 'explicit expected PNG and output directory are required');
+const name = process.env.PULSE_CLIPBOARD_COLOR_CASE || 'selected';
+let server, browser;
+(async () => {
+  fs.mkdirSync(output, { recursive: true });
+  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
+  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(output, 'vite-cache'), logLevel: 'error',
+    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }, plugins: [{
+      name: 'real-clipboard-color-paste', configureServer(vite) {
+        vite.middlewares.use('/__colors', (_req, res) => {
+          res.setHeader('Content-Type', 'text/html; charset=utf-8');
+          res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/composer-images-fixture.ts"></script></html>');
+        });
+      },
+    }],
+  });
+  await server.listen();
+  browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--window-position=-32000,-32000'] });
+  const page = await browser.newPage({ viewport: { width: 1180, height: 800 } }), errors = [];
+  page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
+  await page.route('**/api/v2/**', route => route.fulfill({ json: { items: [] } }));
+  await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/__colors');
+  const input = page.getByRole('textbox', { name: '输入消息', exact: true }); await input.waitFor();
+  await page.evaluate(() => {
+    window.clipboardPixelDigest = async img => {
+      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth || img.width; canvas.height = img.naturalHeight || img.height;
+      const context = canvas.getContext('2d'); context.drawImage(img, 0, 0);
+      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
+      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
+      return { width: canvas.width, height: canvas.height, sha256 };
+    };
+    document.addEventListener('paste', async event => {
+      const file = event.clipboardData.files[0];
+      if (file) {
+        const image = await createImageBitmap(file);
+        try { window.clipboardSourcePixels = await window.clipboardPixelDigest(image); }
+        finally { image.close(); }
+      }
+    }, true);
+  });
+  await input.focus(); const start = Date.now(); await page.keyboard.press('Control+V');
+  const thumb = page.getByRole('button', { name: /^预览 / }).first(); await thumb.waitFor();
+  const elapsed = Date.now() - start;
+  await page.waitForFunction(() => !!window.clipboardSourcePixels);
+  const expected = await page.evaluate(async source => {
+    const image = new Image(); image.src = source; await image.decode(); return window.clipboardPixelDigest(image);
+  }, 'data:image/png;base64,' + fs.readFileSync(expectedFile).toString('base64'));
+  assert.deepEqual(await page.evaluate(() => window.clipboardSourcePixels), expected, 'OS clipboard file must retain every pixel and original resolution');
+  await thumb.click(); const preview = page.getByRole('dialog', { name: '图片预览', exact: true }); await preview.waitFor();
+  const full = await preview.locator('img').evaluate(async image => { await image.decode(); return window.clipboardPixelDigest(image); });
+  assert.deepEqual(full, expected, 'composer full preview must retain every pixel and original resolution');
+  assert.equal(await page.evaluate(() => window.composerFixture.sent.value.length), 0); assert.deepEqual(errors, []);
+  await page.screenshot({ path: path.join(output, 'paste-' + name + '.png') });
+  const result = { passed: true, case: name, real_windows_clipboard: true, real_keyboard_paste: true, actual_vue_composer: true,
+    width: full.width, height: full.height, pixels_compared: full.width * full.height, full_preview_matches: true, paste_thumbnail_ms: elapsed, production_messages_sent: 0 };
+  fs.writeFileSync(path.join(output, 'paste-' + name + '.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
+})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await server?.close(); });

```

## 4. 测试代码与实际输出

测试代码全文见第 3 节。原生默认测试中 2 项写系统剪贴板的测试保持 ignored 防止无授权执行；本轮通过先备份、再写入一次性控制标记的控制器显式运行，7 组均通过。没有伪造 ClipboardEvent、没有发送生产消息；每组结束均校验恢复原 16 个可保存格式。初次失败与后续成功分别保留。

### 修复前真实 Windows 基线

```text

running 1 test
test archive_reader::image_tests::windows_clipboard_color_modes ... COLOR rgb: dimensions=(29, 19), pixel mismatches=0
COLOR rgba: write failed: 无法写入图片到剪贴板，请重试。
COLOR gray: dimensions=(29, 19), pixel mismatches=551
COLOR gray-alpha: dimensions=(29, 19), pixel mismatches=551

thread 'archive_reader::image_tests::windows_clipboard_color_modes' (28416) panicked at src\archive_reader.rs:625:9:
clipboard corrupts color modes: ["rgba", "gray", "gray-alpha"]
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
FAILED

failures:

failures:
    archive_reader::image_tests::windows_clipboard_color_modes

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 21 filtered out; finished in 0.02s


```

### 修复后原生完整单测

命令：`cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --bin pulse-im-desktop -- --nocapture`，MSVC 环境，当前 `pc-tauri` 工程。结果 25 通过、0 失败；两项受保护的系统剪贴板测试随后单独通过。

```text
warning: unused import: `Manager`
 --> src\upload_stage.rs:5:38
  |
5 | use tauri::{ipc::Request, AppHandle, Manager, State, WebviewWindow};
  |                                      ^^^^^^^
  |
  = note: `#[warn(unused_imports)]` (part of `#[warn(unused)]`) on by default

warning: `pulse-im-desktop` (bin "pulse-im-desktop" test) generated 1 warning
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.27s
     Running unittests src\main.rs (src-tauri\target\debug\build\pulse-im-desktop/6c3eb0bd32f1220d\out\pulse_im_desktop-6c3eb0bd32f1220d.exe)

running 27 tests
test archive_reader::image_tests::windows_clipboard_color_modes ... ignored, requires an isolated clipboard or explicit user-authorized backup/restore controller
test archive_reader::image_tests::windows_clipboard_replaces_previous_image_formats ... ignored, requires an isolated clipboard or explicit user-authorized backup/restore controller
test archive_reader::clipboard_bitmap_tests::invalid_bitmap_is_rejected_without_opening_or_clearing_the_clipboard ... ok
test screen_pixels::tests::crop_accepts_a_region_up_to_the_screen_edges ... ok
test screen_pixels::tests::crop_preserves_the_exact_displayed_pixel_count ... ok
test network_settings::location_tests::ippure_location_preserves_actual_fields_and_missing_district ... ok
test network_settings::location_tests::ippure_location_does_not_fabricate_or_forward_invalid_fields ... ok
test screen_pixels::tests::crop_rejects_invalid_and_tiny_regions ... ok
test tray_accounts::tests::window_name_uses_only_its_current_signed_in_account ... ok
test image_copy::tests::cancellation_does_not_leave_an_old_copy_waiting_for_the_worker ... ok
test workspace_groups::tests::account_name_strips_controls_bidi_and_unbounded_text ... ok
test image_copy::tests::cancelled_scope_and_failed_write_preserve_clipboard ... ok
test archive_reader::clipboard_bitmap_tests::oversized_or_cancelled_input_is_rejected_before_clipboard_publication ... ok
test image_copy::tests::repeated_selected_image_reuses_only_successful_pixels ... ok
test archive_reader::image_tests::original_pixels_decode_without_any_preview_or_os_clipboard ... ok
test image_copy::tests::account_or_message_changes_do_not_reuse_pixels ... ok
test image_copy::tests::later_selection_cancels_old_download_and_cannot_be_overwritten ... ok
test workspace_groups::tests::new_window_ordinals_do_not_duplicate_after_deletion ... ok
test archive_reader::image_tests::cache_key_does_not_cross_accounts_messages_or_media ... ok
test workspace_groups::tests::existing_window_registry_needs_no_migration ... ok
test workspace_groups::tests::account_names_survive_restart_and_remain_scoped_to_their_window ... ok
test workspace_groups::tests::removal_is_persistent_and_preserves_other_windows_and_account_data ... ok
test archive_reader::clipboard_bitmap_tests::alpha_and_gray_sources_keep_all_pixels_without_a_palette_dependency ... ok
test archive_reader::clipboard_bitmap_tests::supported_file_formats_copy_their_decoded_pixels_without_another_lossy_encode ... ok
test archive_reader::image_tests::cached_copy_still_checks_message_and_grant_but_skips_original_download ... ok
test image_copy::tests::cache_has_a_hard_size_limit_and_releases_expired_pixels ... ok
test archive_reader::clipboard_bitmap_tests::odd_width_and_tall_images_keep_original_resolution_and_orientation ... ok

test result: ok. 25 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.45s


```

### 七组真实剪贴板与 Ctrl+V

| 来源/场景 | 原图宽高 | 核对像素 | 粘贴到缩略图可用耗时 | 原文件/放大预览像素核对 |
|---|---|---:|---:|---|
| rgb | 29×19 | 551 | 94 ms | 通过 |
| rgba | 29×19 | 551 | 100 ms | 通过 |
| gray | 29×19 | 551 | 97 ms | 通过 |
| gray-alpha | 29×19 | 551 | 100 ms | 通过 |
| transparent | 29×19 | 551 | 93 ms | 通过 |
| large-rgba | 566×1088 | 615808 | 135 ms | 通过 |
| stale | 29×19 | 551 | 107 ms | 通过 |

共核对 619,114 个像素。原图与粘贴后 File、放大预览分别在浏览器中取 RGBA 像素计算 SHA-256，宽高与摘要全部相同。耗时只代表本地粘贴到缩略图，不包含服务器下载或复制授权请求；不是网络性能承诺。

受保护原生测试的实际输出：

```text

running 1 test
test archive_reader::image_tests::windows_clipboard_color_modes ... COLOR rgb: dimensions=(29, 19), pixel mismatches=0
ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 26 filtered out; finished in 0.03s



running 1 test
test archive_reader::image_tests::windows_clipboard_color_modes ... COLOR rgba: dimensions=(29, 19), pixel mismatches=0
ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 26 filtered out; finished in 0.04s



running 1 test
test archive_reader::image_tests::windows_clipboard_color_modes ... COLOR gray: dimensions=(29, 19), pixel mismatches=0
ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 26 filtered out; finished in 0.04s



running 1 test
test archive_reader::image_tests::windows_clipboard_color_modes ... COLOR gray-alpha: dimensions=(29, 19), pixel mismatches=0
ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 26 filtered out; finished in 0.03s



running 1 test
test archive_reader::image_tests::windows_clipboard_color_modes ... COLOR transparent: dimensions=(29, 19), pixel mismatches=0
ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 26 filtered out; finished in 0.04s



running 1 test
test archive_reader::image_tests::windows_clipboard_color_modes ... COLOR large-rgba: dimensions=(566, 1088), pixel mismatches=0
ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 26 filtered out; finished in 0.46s



running 1 test
test archive_reader::image_tests::windows_clipboard_replaces_previous_image_formats ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 26 filtered out; finished in 0.01s


```

生产 Vue 消息菜单 5 项检查结果：

```json
{
  "passed": true,
  "checks": [
    "an unloaded image copies by its exact Go message ID without opening a preview and shows immediate progress",
    "successful copy closes the menu after native completion",
    "a late first copy cannot close or update the second selected image menu",
    "conversation and account locking clear old progress and suppress late errors",
    "a failed download allows retry and recalled images do not offer copying"
  ],
  "errors": [],
  "production_requests": 0,
  "os_clipboard_modified": false
}
```

前端 `vue-tsc --noEmit` 通过，新系统粘贴测试 `node --check` 通过；隔离安装包构建再次运行 `vue-tsc --noEmit && vite build --mode desktop` 并校验资源。Release + NSIS 构建尾部原始输出：

```text
   Compiling pulse-im-desktop v2.4.233 (E:\多窗口项目\IM开发\go-rewrite\.local\pc-clipboard-colors-20261127-030031\source\pc-tauri\src-tauri)
warning: unused import: `Manager`
 --> src\upload_stage.rs:5:38
  |
5 | use tauri::{ipc::Request, AppHandle, Manager, State, WebviewWindow};
  |                                      ^^^^^^^
  |
  = note: `#[warn(unused_imports)]` (part of `#[warn(unused)]`) on by default

warning: `pulse-im-desktop` (bin "pulse-im-desktop") generated 1 warning
    Finished `release` profile [optimized] target(s) in 1m 36s
       Built application at: E:\多窗口项目\IM开发\go-rewrite\.local\pc-clipboard-colors-20261127-030031\source\pc-tauri\src-tauri\target\release\pulse-im-desktop.exe
        Info Patching E:\多窗口项目\IM开发\go-rewrite\.local\pc-clipboard-colors-20261127-030031\source\pc-tauri\src-tauri\target\release\pulse-im-desktop.exe with bundle type information: nsis
        Info Target: x64
     Running makensis to produce E:\多窗口项目\IM开发\go-rewrite\.local\pc-clipboard-colors-20261127-030031\source\pc-tauri\src-tauri\target\release\bundle\nsis\Pulse IM_2.4.233_x64-setup.exe
    Finished 1 bundle at:
        E:\多窗口项目\IM开发\go-rewrite\.local\pc-clipboard-colors-20261127-030031\source\pc-tauri\src-tauri\target\release\bundle\nsis\Pulse IM_2.4.233_x64-setup.exe (18.47 MiB)

```

### 保留的失败及校验修正

1. 修复前基线真实失败，见上文，未计为通过。
2. 第一次 DIBV5 单格式透明图检查失败，浏览器粘贴丢 alpha。记录保留于 `E:/多窗口项目/IM开发/go-rewrite/.local/pc-clipboard-colors-20261127-030031/fixed/browser-transparent-dib-only-failed.log`。增加当前无损 PNG 后相同透明图通过。
3. 大图探针最初错误地要求 100×192 的输入框缩略图与 566×1088 原图逐像素相同，首次输出巨大数组差异而超时，缩小诊断后明确这两个尺寸。产品本来就生成 192 像素缩略图。探针改为比较系统 File 和原文件、再比较全尺寸预览，并在浏览器内计算全像素摘要；最终大图 615,808 像素通过，没有修改缩略图产品代码或放宽原图标准。
4. 提取安装包后，初次严格整文件 SHA 比较失败。二进制比较确认仅 Tauri 的 `__TAURI_BUNDLE_TYPE_VAR_UNK` → `__TAURI_BUNDLE_TYPE_VAR_NSS` 三个字节变化；本机 `tauri-utils-2.10.4/src/platform.rs` 明确 NSS 表示 NSIS。校验该唯一标记替换后全部字节相同，没有忽略其他差异。包内实际程序 SHA256：`438ad698b1674abae0c69d609e76d9c476d4c80057712cac852ac67a0aeb9053`。

### 安装包与源码完整性

安装包：`E:\多窗口项目\IM开发\go-rewrite\.local\pc-clipboard-colors-20261127-030031\PC-Tauri\Pulse-IM-2.4.233-Windows-x64-setup.exe`，版本 2.4.233，Windows x64 Tauri 安装版，标识 `com.pulseim.desktop.tauri`，默认 Go 接口 `https://api.imapi.shop/api/v2`。文件 19,369,515 字节；SHA256 `b0f8c24e3277eb478680d17774f7d147af075d120a1cc280b8d2e0a18cbd06a0`。沿用原项目未配置 Authenticode 签名的状态。

构建中 7809 个工作区源文件核对未变化，隔离副本 6434 个输入文件核对一致，3037 个前端文件校验通过。全部 575 个服务器源文件与开始快照相同。提取安装器验证包内原生程序与构建产物等价，版本资源和 NSIS 输入一致。未执行安装器、未覆盖用户正在使用的客户端、未使用真人账号进行手工聊天回归、未部署或推送 Git。

本地证据目录：`E:/多窗口项目/IM开发/go-rewrite/.local/pc-clipboard-colors-20261127-030031`，完整机器结果 `package-verification.json`、构建输入 `build-snapshot.json`、发布校验 `delivery-verification.json`。原始剪贴板备份在确认恢复后删除，结果与合成测试图保留。

## 5. 兼容性检查

- 账号切换：原有 session/route/message/media 缓存键、权限复核、取消范围和最新选择提交规则均保持。`account_or_message_changes_do_not_reuse_pixels`、`cache_key_does_not_cross_accounts_messages_or_media`、已取消范围不得写入和缓存仍检查授权的测试通过。未用真人账号切换做额外手工验收。
- 进程退出与重启：不增加磁盘或账号状态，20 秒/64 MiB 进程内缓存规则保持。每组原生写入测试进程退出后才启动浏览器 Ctrl+V，仍能获得完整图片，数据不依赖已退出写入进程。没有验证“写入瞬间强杀”的原子性，也没有对用户客户端做强杀。
- 多会话并发：保留单 worker、后选取消先选及提交校验。`later_selection_cancels_old_download_and_cannot_be_overwritten`、`cancellation_does_not_leave_an_old_copy_waiting_for_the_worker` 及两个菜单请求交错的 Vue 回归通过。主窗口和各独立窗口共用该原生写入入口；未改变窗口或聊天协议。

## 6. 发现但未修改

- `src/upload_stage.rs:5` 原有未使用 `Manager` 导入警告，本轮 Debug 测试和 Release 构建均提示，未修改其他上传代码。
- 当前聊天复制仍按既有图像库读取静态帧并归一到 RGBA8；未新增动图全部帧、HDR 或 16 位剪贴板工作流，也未宣称这些扩展能力完成。
- 原生读取上限仍为 30 MiB、最大单边 10,000 / 总像素 20,000,000；长期被其他应用占用的系统剪贴板仍会按既有错误反馈，不吞失败或把旧图当成功。
- 本轮完成图片复制专项验收，不代表既有 PC 全量迁移清单全部签验；Windows 上其他第三方粘贴目标与真人多账号手工回归未覆盖。
