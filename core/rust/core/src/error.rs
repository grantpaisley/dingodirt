use thiserror::Error;

/// Core error type for Dingo operations
#[derive(Debug, Error)]
pub enum Error {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Configuration error: {0}")]
    Config(Box<figment::Error>),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("{0}")]
    Other(String),
}

impl From<figment::Error> for Error {
    fn from(err: figment::Error) -> Self {
        Error::Config(Box::new(err))
    }
}

pub type Result<T> = std::result::Result<T, Error>;
