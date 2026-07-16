//! Linux sandbox implementation using Landlock + seccomp.
//!
//! Landlock provides filesystem access control (available since Linux 5.13).
//! seccomp optionally blocks child network access by filtering socket syscalls.

use crate::ConfinedSpawnOptions;
use std::io::{self, Read, Write};
use std::os::unix::io::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};

/// Result type for sandbox operations.
type SandboxResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// Handle to a confined child process on Linux.
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

/// Read from a pipe in non-blocking mode. Returns None if no data available.
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

/// Build Landlock ruleset access flags for the given profile paths.
/// This uses the landlock crate to construct access rules.
fn build_landlock_rules(
    readable_paths: &[String],
    writable_paths: &[String],
    deny_globs: &[String],
) -> SandboxResult<LandlockRules> {
    Ok(LandlockRules {
        readable_paths: readable_paths.to_vec(),
        writable_paths: writable_paths.to_vec(),
        deny_globs: deny_globs.to_vec(),
    })
}

/// Intermediate representation of Landlock rules to apply pre-exec.
struct LandlockRules {
    readable_paths: Vec<String>,
    writable_paths: Vec<String>,
    deny_globs: Vec<String>,
}

impl LandlockRules {
    /// Apply Landlock rules in the child process (pre-exec).
    /// Uses the landlock crate's ABI to create and enforce a ruleset.
    fn apply(&self) -> SandboxResult<()> {
        use landlock::{
            Access, AccessFs, PathBeneath, PathFd, Ruleset, RulesetAttr,
            RulesetCreatedAttr, RulesetStatus, ABI,
        };

        // Use best-effort ABI versioning
        let abi = ABI::V3;

        let read_access = AccessFs::from_read(abi);
        let write_access = AccessFs::from_all(abi);

        let mut ruleset = Ruleset::default()
            .handle_access(write_access)?
            .create()?;

        // Add readable paths (read-only access)
        for path in &self.readable_paths {
            if std::path::Path::new(path).exists() {
                if let Ok(fd) = PathFd::new(path) {
                    let _ = ruleset.add_rule(PathBeneath::new(fd, read_access));
                }
            }
        }

        // Add writable paths (full access)
        for path in &self.writable_paths {
            if std::path::Path::new(path).exists() {
                if let Ok(fd) = PathFd::new(path) {
                    let _ = ruleset.add_rule(PathBeneath::new(fd, write_access));
                }
            }
        }

        // Always allow /tmp and system temp
        for tmp in &["/tmp", "/var/tmp"] {
            if std::path::Path::new(tmp).exists() {
                if let Ok(fd) = PathFd::new(tmp) {
                    let _ = ruleset.add_rule(PathBeneath::new(fd, write_access));
                }
            }
        }

        // Enforce the ruleset
        let status = ruleset.restrict_self()?;
        match status.ruleset {
            RulesetStatus::FullyEnforced | RulesetStatus::PartiallyEnforced => Ok(()),
            RulesetStatus::NotEnforced => {
                // Landlock not supported on this kernel — graceful degradation
                Ok(())
            }
        }
    }
}

/// Build a seccomp BPF filter that blocks socket creation (network access).
/// This is a minimal seccomp-bpf program that blocks AF_INET/AF_INET6 socket calls.
fn build_seccomp_network_filter() -> Vec<libc::sock_filter> {
    // BPF program to block socket(AF_INET, ...) and socket(AF_INET6, ...)
    // This is intentionally minimal — blocks new socket creation only.
    use libc::*;

    const AUDIT_ARCH_X86_64: u32 = 0xc000003e;

    #[cfg(target_arch = "x86_64")]
    const SYS_SOCKET: u32 = 41;
    #[cfg(target_arch = "aarch64")]
    const SYS_SOCKET: u32 = 198;

    vec![
        // Load architecture
        sock_filter {
            code: (BPF_LD | BPF_W | BPF_ABS) as u16,
            jt: 0,
            jf: 0,
            k: 4, // offsetof(seccomp_data, arch)
        },
        // Verify architecture (allow non-matching through)
        #[cfg(target_arch = "x86_64")]
        sock_filter {
            code: (BPF_JMP | BPF_JEQ | BPF_K) as u16,
            jt: 1,
            jf: 5, // skip to ALLOW
            k: AUDIT_ARCH_X86_64,
        },
        #[cfg(target_arch = "aarch64")]
        sock_filter {
            code: (BPF_JMP | BPF_JEQ | BPF_K) as u16,
            jt: 1,
            jf: 5,
            k: 0xc00000b7, // AUDIT_ARCH_AARCH64
        },
        // Load syscall number
        sock_filter {
            code: (BPF_LD | BPF_W | BPF_ABS) as u16,
            jt: 0,
            jf: 0,
            k: 0, // offsetof(seccomp_data, nr)
        },
        // Check if syscall is socket()
        sock_filter {
            code: (BPF_JMP | BPF_JEQ | BPF_K) as u16,
            jt: 0,
            jf: 3, // skip to ALLOW if not socket
            k: SYS_SOCKET,
        },
        // Load first argument (domain/family)
        sock_filter {
            code: (BPF_LD | BPF_W | BPF_ABS) as u16,
            jt: 0,
            jf: 0,
            k: 16, // offsetof(seccomp_data, args[0])
        },
        // Block AF_INET (2)
        sock_filter {
            code: (BPF_JMP | BPF_JEQ | BPF_K) as u16,
            jt: 1, // -> ERRNO
            jf: 0,
            k: libc::AF_INET as u32,
        },
        // Block AF_INET6 (10)
        sock_filter {
            code: (BPF_JMP | BPF_JEQ | BPF_K) as u16,
            jt: 0, // -> ERRNO
            jf: 1, // -> ALLOW
            k: libc::AF_INET6 as u32,
        },
        // ERRNO: return EPERM
        sock_filter {
            code: (BPF_RET | BPF_K) as u16,
            jt: 0,
            jf: 0,
            k: 0x00050001, // SECCOMP_RET_ERRNO | EPERM
        },
        // ALLOW
        sock_filter {
            code: (BPF_RET | BPF_K) as u16,
            jt: 0,
            jf: 0,
            k: 0x7fff0000, // SECCOMP_RET_ALLOW
        },
    ]
}

/// Apply seccomp filter to block network in child process.
fn apply_seccomp_network_block() -> SandboxResult<()> {
    let filter = build_seccomp_network_filter();

    let prog = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_ptr() as *mut libc::sock_filter,
    };

    unsafe {
        // Set NO_NEW_PRIVS required for unprivileged seccomp
        let ret = libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
        if ret != 0 {
            return Err(io::Error::last_os_error().into());
        }

        // Install the seccomp filter
        let ret = libc::prctl(
            libc::PR_SET_SECCOMP,
            2, // SECCOMP_MODE_FILTER
            &prog as *const libc::sock_fprog as libc::c_ulong,
            0,
            0,
        );
        if ret != 0 {
            return Err(io::Error::last_os_error().into());
        }
    }

    Ok(())
}

/// Spawn a confined child process on Linux using Landlock + optional seccomp.
pub fn spawn_confined_impl(
    opts: ConfinedSpawnOptions,
) -> SandboxResult<PlatformChildHandle> {
    let rules = build_landlock_rules(
        &opts.profile.readable_paths,
        &opts.profile.writable_paths,
        &opts.profile.deny_globs,
    )?;

    let deny_network = !opts.profile.allow_child_network;

    let mut cmd = Command::new(&opts.command);
    cmd.args(&opts.args)
        .current_dir(&opts.cwd)
        .env_clear()
        .envs(&opts.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Apply sandbox rules in the child process before exec.
    // pre_exec runs after fork() but before exec(), so Landlock and seccomp
    // apply only to the child process.
    unsafe {
        cmd.pre_exec(move || {
            // Apply Landlock filesystem restrictions
            if let Err(e) = rules.apply() {
                // Log but don't fail — Landlock may not be available on older kernels
                // (< 5.13) and we fall back gracefully
                eprintln!("[sandbox] Landlock apply warning: {e}");
            }

            // Apply seccomp network filter if network is denied
            if deny_network {
                if let Err(e) = apply_seccomp_network_block() {
                    // Log but don't fail — seccomp may not be fully available
                    eprintln!("[sandbox] seccomp network block warning: {e}");
                }
            }

            Ok(())
        });
    }

    let child = cmd.spawn()?;

    Ok(PlatformChildHandle {
        child,
        stdin_closed: false,
    })
}
