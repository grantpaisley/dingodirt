//! Dingo API server binary

use std::net::SocketAddr;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load .env file manually
    if let Ok(contents) = std::fs::read_to_string(".env") {
        for line in contents.lines() {
            if !line.starts_with('#') && !line.is_empty() {
                if let Some((key, value)) = line.split_once('=') {
                    // Trim the key *before* the precedence check — checking the
                    // untrimmed key ("FOO " for "FOO = bar") always missed, so a
                    // spaced .env line would override a real environment variable.
                    let key = key.trim();
                    if std::env::var(key).is_err() {
                        unsafe { std::env::set_var(key, value.trim()) };
                    }
                }
            }
        }
    }

    // Initialize tracing
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("dingo_daemon=info".parse()?),
        )
        .init();

    // Get database URL from environment
    let database_url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set in .env or environment");

    // Connect to database
    let pool = dingo_core::db::create_pool(&database_url).await?;

    // Run migrations
    sqlx::migrate!("../../../server/migrations").run(&pool).await?;

    // Bind localhost by default — the web UI runs on the same machine, so this
    // changes nothing for normal use but stops the unauthenticated API (and the
    // whole personal GPS history behind it) from being reachable by every device
    // on the LAN. Set DINGO_BIND=0.0.0.0:3000 to opt into network exposure.
    let bind = std::env::var("DINGO_BIND").unwrap_or_else(|_| "127.0.0.1:3000".to_string());
    let addr: SocketAddr = bind.parse()?;
    dingo_daemon::serve(pool, addr).await?;

    Ok(())
}
