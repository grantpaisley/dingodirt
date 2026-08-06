use sqlx::PgPool;
use std::env;
use std::fs;
use std::io::{self, Write};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load .env file manually
    if let Ok(contents) = fs::read_to_string(".env") {
        for line in contents.lines() {
            if let Some((key, value)) = line.split_once('=') {
                unsafe { env::set_var(key.trim(), value.trim()) };
            }
        }
    }

    let url = env::var("DATABASE_URL")?;

    // This binary wipes every table. Refuse anything that isn't an obviously
    // local dev database, and require the operator to type the database name so
    // a stray `cargo run --bin truncate` can't nuke real data unprompted.
    let (host, db_name) = parse_host_and_db(&url);
    if !matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1") {
        return Err(format!(
            "Refusing to truncate: host {host:?} is not local. This binary is for dev databases only."
        )
        .into());
    }

    println!("⚠️  About to TRUNCATE every table in database {db_name:?} on {host}.");
    print!("Type the database name to confirm: ");
    io::stdout().flush()?;
    let mut typed = String::new();
    io::stdin().read_line(&mut typed)?;
    if typed.trim() != db_name {
        println!("❌ Confirmation did not match. Nothing was changed.");
        return Ok(());
    }

    let pool = PgPool::connect(&url).await?;

    println!("🗑️  Truncating all tables...");

    sqlx::query("TRUNCATE runs, segment_dir_stats, segment_dir_dingo_score, segment_dirs, segments, rides, files, areas CASCADE")
        .execute(&pool)
        .await?;

    println!("✅ All tables truncated");
    Ok(())
}

/// Extract (host, database-name) from a `postgres://user:pass@host:port/db` URL,
/// falling back to sensible defaults when a component is absent.
fn parse_host_and_db(url: &str) -> (String, String) {
    let after_scheme = url.splitn(2, "://").nth(1).unwrap_or(url);
    let after_auth = after_scheme.rsplit('@').next().unwrap_or(after_scheme);
    let (hostport, db) = after_auth.split_once('/').unwrap_or((after_auth, ""));
    let host = hostport.split(':').next().unwrap_or("").to_string();
    let db_name = db.split(['?', '/']).next().unwrap_or("").to_string();
    (host, db_name)
}
