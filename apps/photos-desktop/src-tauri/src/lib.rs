use base64::Engine as _;

#[derive(serde::Serialize)]
pub struct DownsizeResult {
    pub data: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
}

/// Resize an image to fit within `max_dimension × max_dimension` without
/// enlarging it. Returns base64-encoded JPEG (quality 85) for opaque images
/// and base64-encoded WebP (quality 76) for images with an alpha channel.
#[tauri::command]
fn downsize_image(file_path: String, max_dimension: u32) -> Result<DownsizeResult, String> {
    use image::GenericImageView as _;

    let bytes = std::fs::read(&file_path).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;

    let (orig_w, orig_h) = img.dimensions();

    // Fit-inside resize — CatmullRom, never enlarge
    let resized = if orig_w > max_dimension || orig_h > max_dimension {
        img.resize(max_dimension, max_dimension, image::imageops::FilterType::CatmullRom)
    } else {
        img
    };
    let (new_w, new_h) = resized.dimensions();

    // Detect alpha channel
    let has_alpha = matches!(
        resized.color(),
        image::ColorType::La8
            | image::ColorType::Rgba8
            | image::ColorType::La16
            | image::ColorType::Rgba16
    );

    if has_alpha {
        // WebP quality 76 for images with alpha
        let encoder = webp::Encoder::from_image(&resized).map_err(|e| e.to_string())?;
        let webp_data = encoder.encode(76.0);
        let encoded = base64::engine::general_purpose::STANDARD.encode(&*webp_data);
        Ok(DownsizeResult {
            data: encoded,
            mime_type: "image/webp".to_string(),
            width: new_w,
            height: new_h,
        })
    } else {
        // JPEG quality 85 for opaque images
        use image::ImageEncoder as _;
        let rgb = resized.to_rgb8();
        let (w, h) = (rgb.width(), rgb.height());
        let mut out: Vec<u8> = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85)
            .write_image(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .map_err(|e| e.to_string())?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&out);
        Ok(DownsizeResult {
            data: encoded,
            mime_type: "image/jpeg".to_string(),
            width: w,
            height: h,
        })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![downsize_image])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
