//! Local map-style config files: read and write the editable MapLibre style
//! JSONs under web/public/styles (config `web_styles_path`).
//!
//! The web app's style-layers panel edits a style's pristine text — with the
//! `{MAPTILER_KEY}` placeholder intact — and PUTs it back here. The daemon
//! never substitutes the key; the key-leak guard below rejects bodies that
//! would bake a real key into the community-shareable file.

use axum::extract::Path as UrlPath;
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::{Router, routing::get};
use std::path::PathBuf;

type ApiError = (StatusCode, String);

const MAX_STYLE_BYTES: usize = 2 * 1024 * 1024;
const KEY_PLACEHOLDER: &str = "{MAPTILER_KEY}";

pub fn routes() -> Router {
    Router::new()
        .route("/", get(list_styles))
        .route("/{id}", get(get_style).put(put_style))
}

/// The style manifest (index.json) — lets Dingo Studio, which no longer sits
/// next to the styles dir like the web app does, enumerate editable styles.
async fn list_styles() -> Result<impl IntoResponse, ApiError> {
    let config = dingo_core::Config::load()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let index_path = config.web_styles_path.join("index.json");
    let text = std::fs::read_to_string(&index_path).map_err(|_| {
        (
            StatusCode::NOT_IMPLEMENTED,
            format!(
                "style manifest not found at {} — set DINGO_WEB_STYLES_PATH to the web/public/styles directory",
                index_path.display()
            ),
        )
    })?;
    Ok(([(header::CONTENT_TYPE, "application/json")], text))
}

/// Resolve a style id to its JSON file via the manifest, guarding against
/// path traversal at both the id and the manifest-supplied filename.
fn style_file(id: &str) -> Result<PathBuf, ApiError> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err((StatusCode::BAD_REQUEST, "invalid style id".into()));
    }

    let config = dingo_core::Config::load()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let dir = config.web_styles_path;
    let index_path = dir.join("index.json");
    let index_text = std::fs::read_to_string(&index_path).map_err(|_| {
        (
            StatusCode::NOT_IMPLEMENTED,
            format!(
                "style manifest not found at {} — set DINGO_WEB_STYLES_PATH to the web/public/styles directory",
                index_path.display()
            ),
        )
    })?;
    let entries: Vec<serde_json::Value> = serde_json::from_str(&index_text)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("bad manifest: {e}")))?;

    let url = entries
        .iter()
        .find(|e| e.get("id").and_then(|v| v.as_str()) == Some(id))
        .and_then(|e| e.get("url").and_then(|v| v.as_str()))
        .ok_or((StatusCode::NOT_FOUND, format!("unknown style id '{id}'")))?;

    // Manifest urls look like "/styles/dingo-topo.json" — take the filename
    // component only, and refuse anything that could escape the styles dir.
    let file = url.rsplit('/').next().unwrap_or_default();
    if file.is_empty() || file.contains("..") || !file.ends_with(".json") {
        return Err((StatusCode::BAD_REQUEST, "invalid manifest url".into()));
    }
    Ok(dir.join(file))
}

async fn get_style(UrlPath(id): UrlPath<String>) -> Result<impl IntoResponse, ApiError> {
    let path = style_file(&id)?;
    let text = std::fs::read_to_string(&path)
        .map_err(|_| (StatusCode::NOT_FOUND, format!("style file missing for '{id}'")))?;
    Ok(([(header::CONTENT_TYPE, "application/json")], text))
}

async fn put_style(
    UrlPath(id): UrlPath<String>,
    body: String,
) -> Result<StatusCode, ApiError> {
    let path = style_file(&id)?;
    let existing = std::fs::read_to_string(&path)
        .map_err(|_| (StatusCode::NOT_FOUND, format!("style file missing for '{id}'")))?;

    if body.len() > MAX_STYLE_BYTES {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "style too large".into()));
    }

    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid JSON: {e}")))?;
    if parsed.get("version").and_then(|v| v.as_i64()) != Some(8) {
        return Err((StatusCode::BAD_REQUEST, "style must have version 8".into()));
    }
    match parsed.get("layers").and_then(|v| v.as_array()) {
        Some(layers) if !layers.is_empty() => {}
        _ => return Err((StatusCode::BAD_REQUEST, "style must have layers".into())),
    }

    // Key-leak guards: a style that used the placeholder must keep it, and no
    // body may carry a literal MapTiler api key.
    if existing.contains(KEY_PLACEHOLDER) && !body.contains(KEY_PLACEHOLDER) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("style must keep the {KEY_PLACEHOLDER} placeholder — never save a substituted style"),
        ));
    }
    if has_literal_maptiler_key(&body) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("style contains a literal MapTiler key — use the {KEY_PLACEHOLDER} placeholder"),
        ));
    }

    // Atomic write: temp file in the same directory, then rename over.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &body)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Keep the picker in sync: the manifest entry's label follows the
    // style's display name. Best-effort — the style write already landed.
    if let Some(name) = parsed.get("name").and_then(|v| v.as_str()) {
        let _ = sync_manifest_label(&id, name);
    }

    Ok(StatusCode::NO_CONTENT)
}

fn sync_manifest_label(id: &str, name: &str) -> std::io::Result<()> {
    let config = dingo_core::Config::load().map_err(std::io::Error::other)?;
    let index_path = config.web_styles_path.join("index.json");
    let text = std::fs::read_to_string(&index_path)?;
    let mut entries: Vec<serde_json::Value> =
        serde_json::from_str(&text).map_err(std::io::Error::other)?;
    let mut changed = false;
    for e in entries.iter_mut() {
        if e.get("id").and_then(|v| v.as_str()) == Some(id)
            && e.get("label").and_then(|v| v.as_str()) != Some(name)
        {
            e["label"] = serde_json::Value::String(name.to_string());
            changed = true;
        }
    }
    if changed {
        let tmp = index_path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&entries)?)?;
        std::fs::rename(&tmp, &index_path)?;
    }
    Ok(())
}

/// True if the text contains a maptiler.com URL carrying a real `key=` value
/// (rather than the `{MAPTILER_KEY}` placeholder).
fn has_literal_maptiler_key(text: &str) -> bool {
    let mut rest = text;
    while let Some(at) = rest.find("maptiler.com") {
        rest = &rest[at + "maptiler.com".len()..];
        // Look at the remainder of the URL (up to the closing quote).
        let url_tail = &rest[..rest.find('"').unwrap_or(rest.len())];
        if let Some(kpos) = url_tail.find("key=") {
            let val = &url_tail[kpos + 4..];
            if !val.starts_with(KEY_PLACEHOLDER)
                && val.chars().take(10).filter(|c| c.is_ascii_alphanumeric()).count() >= 10
            {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::has_literal_maptiler_key;

    #[test]
    fn placeholder_key_is_allowed() {
        assert!(!has_literal_maptiler_key(
            r#""https://api.maptiler.com/tiles/v3/tiles.json?key={MAPTILER_KEY}""#
        ));
    }

    #[test]
    fn literal_key_is_rejected() {
        assert!(has_literal_maptiler_key(
            r#""https://api.maptiler.com/tiles/v3/tiles.json?key=notARealKey0123456789""#
        ));
    }

    #[test]
    fn maptiler_url_without_key_is_allowed() {
        assert!(!has_literal_maptiler_key(r#""https://www.maptiler.com/copyright/""#));
    }
}
