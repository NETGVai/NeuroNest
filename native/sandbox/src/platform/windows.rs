//! Windows sandbox implementation — returns NotSupported.
//!
//! Full Windows native sandbox is out of scope for phase one (see Non-Goals in design).
//! The TS fallback in src/security/kernel-sandbox.ts handles process spawning on Windows
//! using the current spawn path with `sandbox: 'unavailable'` in the execution trace.

use crate::ConfinedSpawnOptions;

/// Result type for sandbox operations.
type SandboxResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// Stub child handle for Windows — never actually constructed.
pub struct PlatformChildHandle;

impl PlatformChildHandle {
    pub fn pid(&self) -> u32 {
        0
    }

    pub fn write_stdin(&mut self, _data: &[u8]) -> SandboxResult<usize> {
        Err("Not supported on this platform".into())
    }

    pub fn close_stdin(&mut self) {}

    pub fn read_stdout(&mut self) -> SandboxResult<Option<Vec<u8>>> {
        Err("Not supported on this platform".into())
    }

    pub fn read_stderr(&mut self) -> SandboxResult<Option<Vec<u8>>> {
        Err("Not supported on this platform".into())
    }

    pub fn wait(&mut self) -> SandboxResult<i32> {
        Err("Not supported on this platform".into())
    }

    pub fn kill(&self, _signal: i32) -> SandboxResult<()> {
        Err("Not supported on this platform".into())
    }
}

/// On Windows (and other unsupported platforms), return a NOT_SUPPORTED error.
/// The TypeScript wrapper (kernel-sandbox.ts) catches this and uses its fallback path.
pub fn spawn_confined_impl(
    _opts: ConfinedSpawnOptions,
) -> SandboxResult<PlatformChildHandle> {
    Err("NOT_SUPPORTED: Native process confinement is not available on Windows. \
         Use the TypeScript fallback (kernel-sandbox.ts) which spawns without OS-level confinement \
         and records sandbox: 'unavailable' in the execution trace."
        .into())
}
