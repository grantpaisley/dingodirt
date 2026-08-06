//! Content-addressed file storage
//!
//! Files are stored as `{store_path}/{sha256}.{ext}` where the hash
//! is computed from the file contents, ensuring deduplication.

use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use thiserror::Error;
use tracing::{debug, info};

use dingo_core::FileId;

#[derive(Debug, Error)]
pub enum FileStoreError {
    #[error("IO error: {0}")]
    Io(#[from] io::Error),

    #[error("File not found: {0}")]
    NotFound(PathBuf),

    #[error("Invalid file path: {0}")]
    InvalidPath(String),
}

/// Result of storing a file
#[derive(Debug, Clone)]
pub struct StoredFile {
    /// Unique file ID
    pub id: FileId,
    /// SHA256 hash of file contents
    pub hash: String,
    /// Original filename
    pub original_name: String,
    /// File extension (lowercase)
    pub extension: String,
    /// File size in bytes
    pub size: u64,
    /// Path where file is stored
    pub stored_path: PathBuf,
    /// Whether this was a duplicate (already existed)
    pub was_duplicate: bool,
}

/// Content-addressed file store
pub struct FileStore {
    /// Root directory for stored files
    store_path: PathBuf,
}

impl FileStore {
    /// Create a new file store at the given path
    pub fn new(store_path: impl Into<PathBuf>) -> io::Result<Self> {
        let store_path = store_path.into();
        fs::create_dir_all(&store_path)?;
        Ok(Self { store_path })
    }

    /// Store a file, returning metadata about the stored file
    ///
    /// If the file already exists (same hash), returns the existing
    /// file info with `was_duplicate = true`.
    pub fn store(&self, source_path: impl AsRef<Path>) -> Result<StoredFile, FileStoreError> {
        let source_path = source_path.as_ref();

        if !source_path.exists() {
            return Err(FileStoreError::NotFound(source_path.to_path_buf()));
        }

        // Read file and compute hash
        let mut file = fs::File::open(source_path)?;
        let mut contents = Vec::new();
        file.read_to_end(&mut contents)?;

        let hash = Self::compute_hash(&contents);
        let size = contents.len() as u64;

        // Extract original name and extension
        let original_name = source_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let extension = source_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_lowercase();

        // Construct destination path
        let dest_filename = format!("{hash}.{extension}");
        let dest_path = self.store_path.join(&dest_filename);

        let was_duplicate = Self::is_complete_duplicate(&dest_path, size);

        if was_duplicate {
            debug!(hash = %hash, "File already exists, skipping copy");
        } else {
            Self::write_atomic(&dest_path, &contents)?;
            info!(
                hash = %hash,
                size = size,
                original = %original_name,
                "Stored file"
            );
        }

        Ok(StoredFile {
            id: FileId::new(),
            hash,
            original_name,
            extension,
            size,
            stored_path: dest_path,
            was_duplicate,
        })
    }

    /// Store file from bytes directly
    pub fn store_bytes(
        &self,
        contents: &[u8],
        original_name: &str,
        extension: &str,
    ) -> Result<StoredFile, FileStoreError> {
        let hash = Self::compute_hash(contents);
        let size = contents.len() as u64;
        let extension = extension.to_lowercase();

        let dest_filename = format!("{hash}.{extension}");
        let dest_path = self.store_path.join(&dest_filename);

        let was_duplicate = Self::is_complete_duplicate(&dest_path, size);

        if !was_duplicate {
            Self::write_atomic(&dest_path, contents)?;
            info!(hash = %hash, size = size, "Stored file from bytes");
        }

        Ok(StoredFile {
            id: FileId::new(),
            hash,
            original_name: original_name.to_string(),
            extension,
            size,
            stored_path: dest_path,
            was_duplicate,
        })
    }

    /// Get the path for a file by its hash and extension
    pub fn get_path(&self, hash: &str, extension: &str) -> PathBuf {
        self.store_path.join(format!("{hash}.{extension}"))
    }

    /// Check if a file with the given hash exists
    pub fn exists(&self, hash: &str, extension: &str) -> bool {
        self.get_path(hash, extension).exists()
    }

    /// Read file contents by hash
    pub fn read(&self, hash: &str, extension: &str) -> Result<Vec<u8>, FileStoreError> {
        let path = self.get_path(hash, extension);
        if !path.exists() {
            return Err(FileStoreError::NotFound(path));
        }
        Ok(fs::read(path)?)
    }

    /// True only if `dest_path` already holds a complete copy of content of the
    /// expected size. A truncated file left behind by an interrupted write (its
    /// bytes no longer matching its content-address name) reports `false`, so the
    /// caller rewrites it instead of trusting the corrupt copy forever.
    fn is_complete_duplicate(dest_path: &Path, expected_size: u64) -> bool {
        match fs::metadata(dest_path) {
            Ok(meta) => meta.len() == expected_size,
            Err(_) => false,
        }
    }

    /// Write to a sibling temp file, then atomically rename it into place. A
    /// crash mid-write leaves only the `.tmp` (overwritten on the next attempt),
    /// never a partial file at the content-addressed path.
    fn write_atomic(dest_path: &Path, contents: &[u8]) -> io::Result<()> {
        let tmp_path = dest_path.with_extension(format!(
            "{}.tmp",
            dest_path.extension().and_then(|e| e.to_str()).unwrap_or("bin")
        ));
        fs::write(&tmp_path, contents)?;
        fs::rename(&tmp_path, dest_path)?;
        Ok(())
    }

    /// Compute SHA256 hash of data
    fn compute_hash(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        let result = hasher.finalize();
        hex::encode(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_store_and_retrieve() {
        let temp_dir = TempDir::new().unwrap();
        let store = FileStore::new(temp_dir.path().join("files")).unwrap();

        // Create a test file
        let test_file = temp_dir.path().join("test.gpx");
        fs::write(&test_file, b"<gpx>test content</gpx>").unwrap();

        // Store it
        let stored = store.store(&test_file).unwrap();
        assert!(!stored.was_duplicate);
        assert_eq!(stored.extension, "gpx");
        assert!(stored.stored_path.exists());

        // Store again - should be duplicate
        let stored2 = store.store(&test_file).unwrap();
        assert!(stored2.was_duplicate);
        assert_eq!(stored.hash, stored2.hash);
    }

    #[test]
    fn test_store_bytes() {
        let temp_dir = TempDir::new().unwrap();
        let store = FileStore::new(temp_dir.path().join("files")).unwrap();

        let contents = b"test FIT data";
        let stored = store.store_bytes(contents, "activity.fit", "fit").unwrap();

        assert!(!stored.was_duplicate);
        assert_eq!(stored.extension, "fit");
        assert!(store.exists(&stored.hash, "fit"));

        // Read back
        let read_contents = store.read(&stored.hash, "fit").unwrap();
        assert_eq!(read_contents, contents);
    }
}
