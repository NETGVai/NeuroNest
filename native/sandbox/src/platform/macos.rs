//! macOS sandbox implementation using Seatbelt (sandbox-exec).
//!
//! Generates a Seatbelt profile string from the sandbox profile options
//! and spawns the child process under `sandbox-exec -p <profile>`.

use crate::ConfinedSpawnOptions;
use std::io::{self, Read, Write};
use std::os::unix::io::AsRawFd;
use std::process::{Child, Command, Stdio};

/// Result type for sandbox operations.
type SandboxResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// Handle to a confined child process on macOS.
pub struct PlatformChildHandle {
    child: Child,
    stdin_closed: bool,
}

impl PlatformChildHandle {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn write_stdin(&mut self, data: &[u8]) -> SandboxResult<usize> {
        if self.stdin_closed {
            return Err("stdin is closed".into());
        }
        if let Some(ref mut stdin) = self.child.stdin {
            let n = stdin.write(data)?;
            stdin.flush()?;
            Ok(n)
        } else {
            Err("stdin not available".into())
        }
    }

    pub fn close_stdin(&mut self) {
        self.child.stdin.take();
        self.stdin_closed = true;
    }

    pub fn read_stdout(&mut self) -> SandboxResult<Option<Vec<u8>>> {
        read_nonblocking(&mut self.child.stdout)
    }

    pub fn read_stderr(&mut self) -> SandboxResult<Option<Vec<u8>>> {
        read_nonblocking(&mut self.child.stderr)
    }

    pub fn wait(&mut self) -> SandboxResult<i32> {
        let status = self.child.wait()?;
        Ok(status.code().unwrap_or(-1))
    }

    pub fn kill(&self, signal: i32) -> SandboxResult<()> {
        unsafe {
            let ret = libc::kill(self.child.id() as libc::pid_t, signal);
            if ret != 0 {
                return Err(io::Error::last_os_error().into());
            }
        }
        Ok(())
    }
}

/// Read from a pipe in non-blocking mode.
fn read_nonblocking<R: Read + AsRawFd>(
    stream: &mut Option<R>,
) -> SandboxResult<Option<Vec<u8>>> {
    let stream = match stream.as_mut() {
        Some(s) => s,
        None => return Ok(None),
    };

    let fd = stream.as_raw_fd();

    // Set non-blocking
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }

    let mut buf = vec![0u8; 65536];
    match stream.read(&mut buf) {
        Ok(0) => Ok(None),
        Ok(n) => {
            buf.truncate(n);
            Ok(Some(buf))
        }
        Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Generate a Seatbelt profile string from sandbox options.
///
/// The profile uses Apple's Scheme-based sandbox profile language (SBPL).
/// It starts with `(deny default)` and adds specific allow rules.
fn generate_seatbelt_profile(opts: &ConfinedSpawnOptions) -> String {
    let mut profile = String::with_capacity(2048);

    // Start with version and deny-all default
    profile.push_str("(version 1)\n");
    profile.push_str("(deny default)\n\n");

    // Always allow process execution primitives
    profile.push_str("; Allow basic process operations\n");
    profile.push_str("(allow process-exec)\n");
    profile.push_str("(allow process-fork)\n");
    profile.push_str("(allow signal)\n");
    profile.push_str("(allow sysctl-read)\n\n");

    // Allow mach services needed for basic operation
    profile.push_str("; Allow essential mach services\n");
    profile.push_str("(allow mach-lookup\n");
    profile.push_str("  (global-name \"com.apple.system.logger\")\n");
    profile.push_str("  (global-name \"com.apple.system.notification_center\"))\n\n");

    // Always allow /tmp and system temp directories (Req 9.7)
    profile.push_str("; Allow system temp directories\n");
    profile.push_str("(allow file-read* file-write*\n");
    profile.push_str("  (subpath \"/private/tmp\")\n");
    profile.push_str("  (subpath \"/tmp\")\n");
    profile.push_str("  (subpath \"/var/folders\"))\n\n");

    // Allow reading system libraries and frameworks
    profile.push_str("; Allow system library reads\n");
    profile.push_str("(allow file-read*\n");
    profile.push_str("  (subpath \"/usr/lib\")\n");
    profile.push_str("  (subpath \"/usr/share\")\n");
    profile.push_str("  (subpath \"/System\")\n");
    profile.push_str("  (subpath \"/Library/Frameworks\")\n");
    profile.push_str("  (subpath \"/usr/local/lib\")\n");
    profile.push_str("  (literal \"/dev/null\")\n");
    profile.push_str("  (literal \"/dev/urandom\")\n");
    profile.push_str("  (literal \"/dev/random\"))\n\n");

    // Deny globs take priority (applied as deny rules before allows)
    if !opts.profile.deny_globs.is_empty() {
        profile.push_str("; Explicit deny patterns (override allows)\n");
        for glob in &opts.profile.deny_globs {
            let seatbelt_pattern = glob_to_seatbelt_pattern(glob);
            profile.push_str(&format!(
                "(deny file-read* file-write* ({})) \n",
                seatbelt_pattern
            ));
        }
        profile.push('\n');
    }

    // Readable paths
    if !opts.profile.readable_paths.is_empty() {
        profile.push_str("; Allowed read paths\n");
        profile.push_str("(allow file-read*\n");
        for path in &opts.profile.readable_paths {
            profile.push_str(&format!("  (subpath \"{}\")\n", escape_seatbelt_string(path)));
        }
        profile.push_str(")\n\n");
    }

    // Writable paths
    if !opts.profile.writable_paths.is_empty() {
        profile.push_str("; Allowed write paths\n");
        profile.push_str("(allow file-read* file-write*\n");
        for path in &opts.profile.writable_paths {
            profile.push_str(&format!("  (subpath \"{}\")\n", escape_seatbelt_string(path)));
        }
        profile.push_str(")\n\n");
    }

    // Network access
    if opts.profile.allow_child_network {
        profile.push_str("; Allow network access\n");
        profile.push_str("(allow network*)\n\n");
    } else {
        profile.push_str("; Network access denied (default)\n");
        profile.push_str("(deny network*)\n\n");
    }

    profile
}

/// Convert a glob pattern to a Seatbelt regex/subpath expression.
fn glob_to_seatbelt_pattern(glob: &str) -> String {
    if glob.contains("**") {
        // **/*.pem -> match anything ending in .pem
        let suffix = glob.trim_start_matches("**/").trim_start_matches("**");
        let regex = suffix
            .replace('.', "\\.")
            .replace('*', ".*");
        format!("regex #\".*{}$\"#", regex)
    } else if glob.contains('*') {
        let regex = glob.replace('.', "\\.").replace('*', "[^/]*");
        format!("regex #\"{}\"#", regex)
    } else {
        // Treat as literal path
        format!("literal \"{}\"", escape_seatbelt_string(glob))
    }
}

/// Escape a string for use in Seatbelt profile (SBPL).
fn escape_seatbelt_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Spawn a confined child process on macOS using sandbox-exec.
pub fn spawn_confined_impl(
    opts: ConfinedSpawnOptions,
) -> SandboxResult<PlatformChildHandle> {
    let profile = generate_seatbelt_profile(&opts);

    // Use sandbox-exec to apply the Seatbelt profile
    // sandbox-exec -p '<profile>' <command> <args...>
    let mut cmd = Command::new("/usr/bin/sandbox-exec");
    cmd.arg("-p")
        .arg(&profile)
        .arg(&opts.command)
        .args(&opts.args)
        .current_dir(&opts.cwd)
        .env_clear()
        .envs(&opts.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = cmd.spawn().map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            Box::new(io::Error::new(
                io::ErrorKind::NotFound,
                "sandbox-exec not found — Seatbelt may not be available on this macOS version",
            )) as Box<dyn std::error::Error + Send + Sync>
        } else {
            Box::new(e) as Box<dyn std::error::Error + Send + Sync>
        }
    })?;

    Ok(PlatformChildHandle {
        child,
        stdin_closed: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SandboxProfile;

    #[test]
    fn test_generate_seatbelt_profile_basic() {
        let opts = ConfinedSpawnOptions {
            command: "/bin/echo".to_string(),
            args: vec!["hello".to_string()],
            cwd: "/tmp".to_string(),
            env: std::collections::HashMap::new(),
            profile: SandboxProfile {
                readable_paths: vec!["/Users/test/project".to_string()],
                writable_paths: vec!["/Users/test/project/output".to_string()],
                deny_globs: vec!["**/*.pem".to_string()],
                allow_child_network: false,
            },
        };

        let profile = generate_seatbelt_profile(&opts);
        assert!(profile.contains("(version 1)"));
        assert!(profile.contains("(deny default)"));
        assert!(profile.contains("/Users/test/project"));
        assert!(profile.contains("/Users/test/project/output"));
        assert!(profile.contains("(deny network*)"));
        assert!(profile.contains(".pem"));
    }

    #[test]
    fn test_generate_seatbelt_profile_with_network() {
        let opts = ConfinedSpawnOptions {
            command: "/bin/echo".to_string(),
            args: vec![],
            cwd: "/tmp".to_string(),
            env: std::collections::HashMap::new(),
            profile: SandboxProfile {
                readable_paths: vec![],
                writable_paths: vec![],
                deny_globs: vec![],
                allow_child_network: true,
            },
        };

        let profile = generate_seatbelt_profile(&opts);
        assert!(profile.contains("(allow network*)"));
    }

    #[test]
    fn test_glob_to_seatbelt_pattern() {
        let result = glob_to_seatbelt_pattern("**/*.pem");
        assert!(result.contains("regex"));
        assert!(result.contains("pem"));

        let result = glob_to_seatbelt_pattern("/etc/secrets");
        assert!(result.contains("literal"));
    }
}
