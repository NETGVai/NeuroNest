//! @neuronest/native-fast-worktree — napi-rs entrypoint
//!
//! Provides native-speed git worktree operations for the Ultra execution mode:
//! - `create_worktree` — Creates a new git worktree in `.neuronest/worktrees/<id>`
//! - `remove_worktree` — Removes a worktree and cleans up refs
//! - `promote_worktree` — Atomic rename of worktree content into the main tree
//! - `collect_garbage` — TTL-based cleanup of stale worktrees

#[macro_use]
extern crate napi_derive;

use napi::{bindgen_prelude::*, Error, Status};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Result returned by `create_worktree`.
#[napi(object)]
pub struct WorktreeResult {
    /// Absolute path to the created worktree directory
    pub worktree_path: String,
    /// The worktree identifier
    pub worktree_id: String,
    /// The branch checked out in the worktree
    pub branch: String,
    /// Whether the creation used the native git2 path
    pub native: bool,
}

/// Result returned by `collect_garbage`.
#[napi(object)]
pub struct GcResult {
    /// Number of stale worktrees removed
    pub removed: u32,
    /// Approximate bytes freed
    pub freed_bytes: i64,
    /// Number of worktrees skipped (still in use or not expired)
    pub skipped: u32,
}

/// Creates a new git worktree using libgit2.
///
/// The worktree is created at `.neuronest/worktrees/<worktree_id>` relative
/// to the repository root. A new branch named `neuronest/wt/<worktree_id>`
/// is created from `base_branch`.
///
/// Requirements: 13.1, 13.5
#[napi]
pub fn create_worktree(
    repo_path: String,
    worktree_id: String,
    base_branch: String,
) -> Result<WorktreeResult> {
    let repo = git2::Repository::open(&repo_path)
        .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to open repo: {e}")))?;

    // Resolve the base branch to a commit
    let base_ref = repo
        .find_branch(&base_branch, git2::BranchType::Local)
        .or_else(|_| repo.find_branch(&base_branch, git2::BranchType::Remote))
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to find branch '{base_branch}': {e}"),
            )
        })?;

    let commit = base_ref.get().peel_to_commit().map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to resolve branch to commit: {e}"),
        )
    })?;

    // Determine worktree path
    let repo_root = repo
        .workdir()
        .unwrap_or_else(|| Path::new(&repo_path));
    let worktree_dir = repo_root
        .join(".neuronest")
        .join("worktrees")
        .join(&worktree_id);

    // Ensure parent directory exists
    if let Some(parent) = worktree_dir.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to create worktree parent directory: {e}"),
            )
        })?;
    }

    // Create a new branch for this worktree
    let wt_branch_name = format!("neuronest/wt/{}", worktree_id);
    repo.branch(&wt_branch_name, &commit, false).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to create worktree branch: {e}"),
        )
    })?;

    // Create the worktree via git2
    let wt_ref_name = format!("refs/heads/{}", wt_branch_name);
    let wt_reference = repo.find_reference(&wt_ref_name).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to find worktree branch ref: {e}"),
        )
    })?;

    let mut opts = git2::WorktreeAddOptions::new();
    opts.reference(Some(&wt_reference));

    repo.worktree(&worktree_id, &worktree_dir, Some(&opts))
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to create worktree: {e}"),
            )
        })?;

    Ok(WorktreeResult {
        worktree_path: worktree_dir.to_string_lossy().to_string(),
        worktree_id,
        branch: wt_branch_name,
        native: true,
    })
}

/// Removes a worktree and cleans up associated refs.
///
/// Prunes the worktree from git's internal tracking and removes the
/// worktree directory and its branch ref.
///
/// Requirements: 13.1, 13.5
#[napi]
pub fn remove_worktree(repo_path: String, worktree_id: String) -> Result<()> {
    let repo = git2::Repository::open(&repo_path)
        .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to open repo: {e}")))?;

    // Determine worktree path for cleanup
    let repo_root = repo
        .workdir()
        .unwrap_or_else(|| Path::new(&repo_path));
    let worktree_dir = repo_root
        .join(".neuronest")
        .join("worktrees")
        .join(&worktree_id);

    // Try to prune the worktree from git's internal tracking
    if let Ok(wt) = repo.find_worktree(&worktree_id) {
        // Validate and prune — locked worktrees are force-pruned
        if wt.is_locked() {
            wt.unlock().ok(); // Best-effort unlock
        }
        let mut prune_opts = git2::WorktreePruneOptions::new();
        prune_opts.valid(true);
        prune_opts.working_tree(true);
        wt.prune(Some(&mut prune_opts)).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to prune worktree: {e}"),
            )
        })?;
    }

    // Remove the worktree directory if it still exists
    if worktree_dir.exists() {
        fs::remove_dir_all(&worktree_dir).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to remove worktree directory: {e}"),
            )
        })?;
    }

    // Clean up the branch ref
    let wt_branch_name = format!("neuronest/wt/{}", worktree_id);
    if let Ok(mut branch) = repo.find_branch(&wt_branch_name, git2::BranchType::Local) {
        branch.delete().map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to delete worktree branch: {e}"),
            )
        })?;
    }

    Ok(())
}

/// Promotes a worktree directory's content into the target directory.
///
/// Uses atomic `rename()` when source and target are on the same filesystem.
/// Falls back to recursive copy + delete when a cross-filesystem rename fails.
///
/// Requirements: 13.1, 13.5
#[napi]
pub fn promote_worktree(worktree_dir: String, target_dir: String) -> Result<()> {
    let source = PathBuf::from(&worktree_dir);
    let target = PathBuf::from(&target_dir);

    if !source.exists() {
        return Err(Error::new(
            Status::GenericFailure,
            format!("Worktree directory does not exist: {worktree_dir}"),
        ));
    }

    // Ensure target parent exists
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to create target parent directory: {e}"),
            )
        })?;
    }

    // Remove existing target if present
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to remove existing target directory: {e}"),
            )
        })?;
    }

    // Attempt atomic rename (works on same filesystem)
    match fs::rename(&source, &target) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            // Cross-filesystem: fall back to recursive copy + delete
            if rename_err.raw_os_error() == Some(libc_exdev()) {
                recursive_copy(&source, &target)?;
                fs::remove_dir_all(&source).map_err(|e| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to remove source after copy: {e}"),
                    )
                })?;
                Ok(())
            } else {
                Err(Error::new(
                    Status::GenericFailure,
                    format!("Failed to rename worktree to target: {rename_err}"),
                ))
            }
        }
    }
}

/// Scans for stale worktrees older than the TTL and removes them.
///
/// Iterates `.neuronest/worktrees/` under `base_dir`, checks each entry's
/// modification time, and removes entries that exceed `ttl_seconds`.
///
/// Requirements: 13.1, 13.5
#[napi]
pub fn collect_garbage(base_dir: String, ttl_seconds: u32) -> Result<GcResult> {
    let worktrees_dir = PathBuf::from(&base_dir)
        .join(".neuronest")
        .join("worktrees");

    if !worktrees_dir.exists() {
        return Ok(GcResult {
            removed: 0,
            freed_bytes: 0,
            skipped: 0,
        });
    }

    let ttl = Duration::from_secs(ttl_seconds as u64);
    let now = SystemTime::now();
    let mut removed: u32 = 0;
    let mut freed_bytes: i64 = 0;
    let mut skipped: u32 = 0;

    let entries = fs::read_dir(&worktrees_dir).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read worktrees directory: {e}"),
        )
    })?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        // Check modification time
        let metadata = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        let modified = match metadata.modified() {
            Ok(t) => t,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        let age = now.duration_since(modified).unwrap_or(Duration::ZERO);

        if age < ttl {
            // Not expired yet
            skipped += 1;
            continue;
        }

        // Check if a .lock file exists (indicates active use)
        let lock_file = path.join(".git").join("lock");
        if lock_file.exists() {
            skipped += 1;
            continue;
        }

        // Calculate approximate size before removal
        let size = dir_size(&path);

        // Remove the stale worktree
        match fs::remove_dir_all(&path) {
            Ok(()) => {
                removed += 1;
                freed_bytes += size;
            }
            Err(_) => {
                skipped += 1;
            }
        }
    }

    Ok(GcResult {
        removed,
        freed_bytes,
        skipped,
    })
}

// --- Internal helpers ---

/// Returns the EXDEV errno value (cross-device link) for the current platform.
fn libc_exdev() -> i32 {
    // EXDEV is 18 on Linux, macOS, and most Unix systems
    18
}

/// Recursively copies a directory tree from `src` to `dst`.
fn recursive_copy(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to create directory {}: {e}", dst.display()),
        )
    })?;

    let entries = fs::read_dir(src).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to read directory {}: {e}", src.display()),
        )
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to read directory entry: {e}"),
            )
        })?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            recursive_copy(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|e| {
                Error::new(
                    Status::GenericFailure,
                    format!(
                        "Failed to copy {} -> {}: {e}",
                        src_path.display(),
                        dst_path.display()
                    ),
                )
            })?;
        }
    }

    Ok(())
}

/// Approximates the total size in bytes of a directory tree.
fn dir_size(path: &Path) -> i64 {
    let mut total: i64 = 0;

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                total += dir_size(&entry_path);
            } else if let Ok(metadata) = fs::metadata(&entry_path) {
                total += metadata.len() as i64;
            }
        }
    }

    total
}
