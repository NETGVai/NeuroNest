//! Platform-specific sandbox implementations.
//!
//! Each platform module provides a `spawn_confined_impl` function and
//! a `PlatformChildHandle` type for managing the spawned child process.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{spawn_confined_impl, PlatformChildHandle};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{spawn_confined_impl, PlatformChildHandle};

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::{spawn_confined_impl, PlatformChildHandle};

// Fallback for other platforms (e.g., FreeBSD)
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod windows; // Reuse the NotSupported stub
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub use windows::{spawn_confined_impl, PlatformChildHandle};
