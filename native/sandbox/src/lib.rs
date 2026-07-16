//! @neuronest/native-sandbox — napi-rs entrypoint
//!
//! Provides `spawn_confined` which applies OS-level process confinement:
//! - Linux: Landlock filesystem rules + optional seccomp network blocking
//! - macOS: Generated Seatbelt profiles via sandbox-exec
//! - Windows: Returns NotSupported error for TS fallback

#[macro_use]
extern crate napi_derive;

mod platform;

use napi::{bindgen_prelude::*, Error, Status};
use serde::Deserialize;
use std::collections::HashMap;

/// Sandbox profile defining filesystem and network constraints.
#[derive(Debug, Deserialize)]
#[napi(object)]
pub struct SandboxProfile {
    /// Paths the child process is allowed to read
    pub readable_paths: Vec<String>,
    /// Paths the child process is allowed to write
    pub writable_paths: Vec<String>,
    /// Glob patterns that are always denied (overrides allows)
    pub deny_globs: Vec<String>,
    /// Whether the child process is allowed to create network connections
    pub allow_child_network: bool,
}

/// Options for spawning a confined process.
#[derive(Debug, Deserialize)]
#[napi(object)]
pub struct ConfinedSpawnOptions {
    /// Command to execute
    pub command: String,
    /// Arguments to pass to the command
    pub args: Vec<String>,
    /// Working directory for the child process
    pub cwd: String,
    /// Environment variables
    pub env: HashMap<String, String>,
    /// Sandbox profile to apply
    pub profile: SandboxProfile,
}

/// Handle to a spawned confined child process.
#[napi]
pub struct ChildHandle {
    inner: platform::PlatformChildHandle,
}

#[napi]
impl ChildHandle {
    /// Get the process ID of the spawned child
    #[napi(getter)]
    pub fn pid(&self) -> u32 {
        self.inner.pid()
    }

    /// Write data to the child's stdin. Returns bytes written.
    #[napi]
    pub fn write_stdin(&mut self, data: Buffer) -> Result<u32> {
        self.inner
            .write_stdin(&data)
            .map(|n| n as u32)
            .map_err(|e| Error::new(Status::GenericFailure, format!("stdin write failed: {e}")))
    }

    /// Close the child's stdin stream.
    #[napi]
    pub fn close_stdin(&mut self) {
        self.inner.close_stdin();
    }

    /// Read available stdout data (non-blocking). Returns null if no data available.
    #[napi]
    pub fn read_stdout(&mut self) -> Result<Option<Buffer>> {
        self.inner
            .read_stdout()
            .map(|opt| opt.map(|bytes| Buffer::from(bytes)))
            .map_err(|e| Error::new(Status::GenericFailure, format!("stdout read failed: {e}")))
    }

    /// Read available stderr data (non-blocking). Returns null if no data available.
    #[napi]
    pub fn read_stderr(&mut self) -> Result<Option<Buffer>> {
        self.inner
            .read_stderr()
            .map(|opt| opt.map(|bytes| Buffer::from(bytes)))
            .map_err(|e| Error::new(Status::GenericFailure, format!("stderr read failed: {e}")))
    }

    /// Wait for the child to exit. Returns the exit code.
    #[napi]
    pub async fn wait(&mut self) -> Result<i32> {
        self.inner
            .wait()
            .map_err(|e| Error::new(Status::GenericFailure, format!("wait failed: {e}")))
    }

    /// Send a signal to the child process (default: SIGTERM/15).
    #[napi]
    pub fn kill(&self, signal: Option<i32>) -> Result<()> {
        self.inner
            .kill(signal.unwrap_or(15))
            .map_err(|e| Error::new(Status::GenericFailure, format!("kill failed: {e}")))
    }
}

/// Spawn a process confined by OS-level sandbox primitives.
///
/// - Linux: Landlock filesystem rules + optional seccomp network filter
/// - macOS: Generated Seatbelt profile applied via sandbox-exec
/// - Windows: Returns NOT_SUPPORTED error
#[napi]
pub fn spawn_confined(opts: ConfinedSpawnOptions) -> Result<ChildHandle> {
    let inner = platform::spawn_confined_impl(opts)
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

    Ok(ChildHandle { inner })
}
