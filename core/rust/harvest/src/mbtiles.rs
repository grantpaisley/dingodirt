//! MBTiles archive writer — standard schema so `pmtiles`, `mbutil` and QGIS
//! read the output directly. One file per (owner, region); the harvester
//! writes, Dingo's daemon (phase 2) reads.
//!
//! We store Strava's raw grayscale intensity PNGs, never pre-coloured: colour
//! is a rendering decision, and grayscale is the substrate for the optional
//! vectorise-later pass.

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};

pub struct MbtilesWriter {
    conn: Connection,
    path: PathBuf,
}

impl MbtilesWriter {
    /// Open (creating if needed) an MBTiles file and stamp its metadata.
    /// `bounds` is `[west, south, east, north]`.
    pub fn open(path: &Path, name: &str, description: &str, bounds: [f64; 4]) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("open mbtiles {}", path.display()))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE IF NOT EXISTS tiles (
                 zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB
             );
             CREATE UNIQUE INDEX IF NOT EXISTS tile_index
                 ON tiles (zoom_level, tile_column, tile_row);",
        )?;
        let writer = Self { conn, path: path.to_path_buf() };
        for (k, v) in [
            ("name", name.to_string()),
            ("description", description.to_string()),
            ("format", "png".to_string()),
            ("type", "overlay".to_string()),
            ("version", "1".to_string()),
            ("bounds", format!("{},{},{},{}", bounds[0], bounds[1], bounds[2], bounds[3])),
        ] {
            writer.set_meta(k, &v)?;
        }
        Ok(writer)
    }

    fn set_meta(&self, name: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO metadata (name, value) VALUES (?1, ?2)
             ON CONFLICT (name) DO UPDATE SET value = excluded.value",
            (name, value),
        )?;
        Ok(())
    }

    /// Store a tile addressed in XYZ; MBTiles rows are TMS (y flipped).
    pub fn put(&self, z: u32, x: u32, y: u32, data: &[u8]) -> Result<()> {
        let tms_row = (1u32 << z) - 1 - y;
        self.conn.execute(
            "INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data)
             VALUES (?1, ?2, ?3, ?4)",
            (z, x, tms_row, data),
        )?;
        Ok(())
    }

    /// Does the archive already hold this XYZ tile? (The estimator's
    /// "already have" check, phase 3, reads the same index.)
    pub fn has(&self, z: u32, x: u32, y: u32) -> Result<bool> {
        let tms_row = (1u32 << z) - 1 - y;
        let n: i64 = self.conn.query_row(
            "SELECT count(*) FROM tiles WHERE zoom_level = ?1 AND tile_column = ?2 AND tile_row = ?3",
            (z, x, tms_row),
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// Refresh minzoom/maxzoom metadata from the stored tiles. Call at run
    /// checkpoints — cheap, and keeps the file valid for readers mid-harvest.
    pub fn refresh_zoom_meta(&self) -> Result<()> {
        let row: (Option<i64>, Option<i64>) = self.conn.query_row(
            "SELECT min(zoom_level), max(zoom_level) FROM tiles",
            (),
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if let (Some(min), Some(max)) = row {
            self.set_meta("minzoom", &min.to_string())?;
            self.set_meta("maxzoom", &max.to_string())?;
        }
        Ok(())
    }

    /// (tile count, file size in bytes) — for `status` and progress logs.
    pub fn stats(&self) -> Result<(u64, u64)> {
        let count: i64 = self.conn.query_row("SELECT count(*) FROM tiles", (), |r| r.get(0))?;
        let size = std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        Ok((count as u64, size))
    }
}

/// Read-only view over an MBTiles archive — the daemon's serve path (phase 2).
pub struct MbtilesReader {
    conn: Connection,
}

impl MbtilesReader {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .with_context(|| format!("open mbtiles (ro) {}", path.display()))?;
        Ok(Self { conn })
    }

    /// Fetch one XYZ tile's PNG bytes, flipping to the TMS row MBTiles stores.
    pub fn tile(&self, z: u32, x: u32, y: u32) -> Result<Option<Vec<u8>>> {
        let tms_row = (1u32 << z) - 1 - y;
        let bytes = self
            .conn
            .query_row(
                "SELECT tile_data FROM tiles
                 WHERE zoom_level = ?1 AND tile_column = ?2 AND tile_row = ?3",
                (z, x, tms_row),
                |r| r.get::<_, Vec<u8>>(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_with_tms_flip() {
        let dir = std::env::temp_dir().join(format!("dingo-harvest-test-{}", std::process::id()));
        let path = dir.join("t.mbtiles");
        let _ = std::fs::remove_file(&path);
        let w = MbtilesWriter::open(&path, "test", "test archive", [151.0, -33.6, 151.3, -33.3])
            .unwrap();

        w.put(3, 7, 2, b"tile-bytes").unwrap();
        assert!(w.has(3, 7, 2).unwrap());
        assert!(!w.has(3, 7, 3).unwrap());
        w.refresh_zoom_meta().unwrap();

        // XYZ y=2 at z3 → TMS row 2^3-1-2 = 5, and metadata reflects the zoom.
        let conn = Connection::open(&path).unwrap();
        let row: i64 = conn
            .query_row("SELECT tile_row FROM tiles WHERE zoom_level = 3 AND tile_column = 7", (), |r| r.get(0))
            .unwrap();
        assert_eq!(row, 5);
        let maxzoom: String = conn
            .query_row("SELECT value FROM metadata WHERE name = 'maxzoom'", (), |r| r.get(0))
            .unwrap();
        assert_eq!(maxzoom, "3");

        // Re-put replaces, not duplicates.
        w.put(3, 7, 2, b"newer").unwrap();
        let (count, _) = w.stats().unwrap();
        assert_eq!(count, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
