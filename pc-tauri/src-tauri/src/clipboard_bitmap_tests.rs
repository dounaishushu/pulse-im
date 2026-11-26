use super::*;
use image::{DynamicImage, ImageFormat, RgbaImage};
use std::io::Cursor;

fn round_trip(image: &DynamicImage, format: ImageFormat) {
    let mut encoded = Cursor::new(Vec::new());
    image.write_to(&mut encoded, format).unwrap();
    let source = image::load_from_memory(encoded.get_ref())
        .unwrap()
        .to_rgba8();
    let bitmap = decode_image(encoded.into_inner(), CancellationToken::new()).unwrap();
    let decoded = image::load_from_memory_with_format(&bitmap, ImageFormat::Bmp)
        .unwrap()
        .to_rgba8();
    assert_eq!(
        decoded, source,
        "copy must preserve dimensions, orientation, RGB and alpha for {format:?}"
    );
}

#[test]
fn alpha_and_gray_sources_keep_all_pixels_without_a_palette_dependency() {
    let rgba = RgbaImage::from_fn(29, 19, |x, y| {
        image::Rgba([
            (x * 7) as u8,
            (y * 11) as u8,
            150,
            [0, 64, 128, 255][(x % 4) as usize],
        ])
    });
    let color = DynamicImage::ImageRgba8(rgba);
    for source in [
        color.clone(),
        DynamicImage::ImageLuma8(color.to_luma8()),
        DynamicImage::ImageLumaA8(color.to_luma_alpha8()),
        DynamicImage::ImageLuma16(color.to_luma16()),
        DynamicImage::ImageLumaA16(color.to_luma_alpha16()),
        DynamicImage::ImageRgb16(color.to_rgb16()),
        DynamicImage::ImageRgba16(color.to_rgba16()),
    ] {
        round_trip(&source, ImageFormat::Png);
    }
}

#[test]
fn odd_width_and_tall_images_keep_original_resolution_and_orientation() {
    for (width, height) in [(1, 1), (3, 17), (29, 19), (566, 1088)] {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255])
        }));
        round_trip(&image, ImageFormat::Png);
    }
}

#[test]
fn supported_file_formats_copy_their_decoded_pixels_without_another_lossy_encode() {
    let image = DynamicImage::ImageRgba8(RgbaImage::from_fn(31, 21, |x, y| {
        image::Rgba([(x * 7) as u8, (y * 11) as u8, 150, 255])
    }));
    for format in [
        ImageFormat::Png,
        ImageFormat::Bmp,
        ImageFormat::Gif,
        ImageFormat::WebP,
    ] {
        round_trip(&image, format);
    }
    round_trip(&DynamicImage::ImageRgb8(image.to_rgb8()), ImageFormat::Jpeg);
}

#[test]
fn oversized_or_cancelled_input_is_rejected_before_clipboard_publication() {
    let image = DynamicImage::ImageRgb8(image::RgbImage::new(10_001, 1));
    let mut png = Cursor::new(Vec::new());
    image.write_to(&mut png, ImageFormat::Png).unwrap();
    assert!(decode_image(png.into_inner(), CancellationToken::new()).is_err());
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(decode_image(vec![0; 100], cancelled).is_err());
}

#[test]
fn invalid_bitmap_is_rejected_without_opening_or_clearing_the_clipboard() {
    for bytes in [vec![], vec![0; 14], vec![0; 1000]] {
        assert_eq!(write_image(0, &bytes), Err("无法生成剪贴板图片。"));
    }
}
