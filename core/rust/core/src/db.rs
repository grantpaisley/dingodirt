use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::Result;

/// Create a connection pool to the database
pub async fn create_pool(database_url: &str) -> Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(database_url)
        .await?;

    Ok(pool)
}
