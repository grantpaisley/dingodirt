use figment::{
    Figment,
    providers::{Env, Serialized},
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    pub database_url: String,
    pub log_level: String,
    pub file_store_path: PathBuf,
    /// The browsable GPX library tree (same root `dingo organize --dest`
    /// targets); the daemon places imported tracks here immediately.
    pub library_path: PathBuf,
    pub photo_store_path: PathBuf,
    pub model_path: PathBuf,
    /// Directory holding the web app's editable MapLibre style JSONs
    /// (web/public/styles). The daemon writes style edits back here, so the
    /// default only works when running from the workspace root.
    pub web_styles_path: PathBuf,
    /// Google Routes API key (GOOGLE_MAPS_API_KEY) — powers the Google Maps
    /// URL import. None disables that endpoint with a setup hint.
    pub google_maps_api_key: Option<String>,
}

impl Config {
    /// Load configuration: defaults, overridden by environment variables
    /// (DINGO_ prefix, plus bare DATABASE_URL).
    pub fn load() -> Result<Self, Box<figment::Error>> {
        Figment::from(Serialized::defaults(Config::default()))
            .merge(Env::prefixed("DINGO_"))
            .merge(Env::raw().only(&["DATABASE_URL", "GOOGLE_MAPS_API_KEY"]))
            .extract()
            .map_err(Box::new)
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            database_url: "postgres://dingo:dingo@localhost:5433/dingo".to_string(),
            log_level: "info".to_string(),
            file_store_path: PathBuf::from("./files"),
            library_path: PathBuf::from("./library"),
            photo_store_path: PathBuf::from("./photos"),
            model_path: PathBuf::from("./models"),
            web_styles_path: PathBuf::from("./web/public/styles"),
            google_maps_api_key: None,
        }
    }
}
