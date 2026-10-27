//! The local transport the browser proxy and the app talk over.
//!
//! Two mechanisms behind one type. On unix it is a socket file in the app's data directory,
//! owner-only; on Windows it is a named pipe whose DACL names the current user and nobody
//! else. `socket` is written against this rather than against either, so the protocol above
//! it has no idea which one is under it.
//!
//! Included by the proxy through `#[path]` alongside `socket_addr`, and for the same reason:
//! the proxy must not link Tauri, and two processes agreeing on an address by copying a
//! string is precisely the thing that drifts.
//!
//! ## Why the two halves do not look alike
//!
//! Unix keeps `UnixStream` directly. It is shipped, it is what the tests drive, and wrapping
//! it would buy nothing.
//!
//! Windows cannot be a thin wrapper over `std`, and the reason is the one thing about named
//! pipes that bites everyone: a handle opened *without* `FILE_FLAG_OVERLAPPED` serializes its
//! I/O. A blocking read on such a handle blocks a concurrent write on the same handle, and
//! this protocol needs exactly that concurrency, in both processes. The app's `serve_session`
//! pushes sync frames from a writer thread while the read loop is parked, and the proxy pumps
//! stdin->pipe and pipe->stdout at the same time. So the Windows side is overlapped I/O, which
//! is `interprocess`'s job rather than ours: hand-rolling `OVERLAPPED` at the one boundary
//! where a browser talks to a password manager is not a saving worth taking.
//!
//! See docs/desktop-port.md.

use std::{
    io,
    path::{Path, PathBuf},
};

// `unix_endpoint` is the socket FILE, which only the unix tests have any use for; `Listener`
// is the app's and not the proxy's. Both are unused in some of the four builds this file is
// compiled into.
#[allow(unused_imports)]
#[cfg(unix)]
pub use unix::{endpoint as unix_endpoint, Listener, Stream};

#[allow(unused_imports)]
#[cfg(windows)]
pub use windows::{Listener, Stream};

/// A stable, per-user, per-vault-root name for the endpoint.
///
/// Both ends derive it from the app data directory, which is the one thing they already agree
/// on. That gets three properties at once: two users on one machine do not collide (their
/// profile paths differ), the tests get an endpoint per temporary directory and can run in
/// parallel, and neither end has to be told anything the other was not.
///
/// FNV-1a, not a real hash, because this names an endpoint and is not a security boundary. On
/// unix the containing directory is 0700 and no other account can reach the socket at all; on
/// Windows the DACL is what keeps other accounts out and the Noise handshake in `pairing` is
/// what keeps *this* user's other processes from getting anything. A collision would be an
/// availability bug, not a disclosure.
fn endpoint_tag(root: &Path) -> String {
    let text = root.to_string_lossy();
    // Lowercased on Windows, where paths are case-insensitive and the two ends do not learn
    // this one from the same place: the app is handed it by Tauri, which asks
    // SHGetKnownFolderPath, and the proxy reads %APPDATA%. Those agree on the directory but a
    // hash does not have to agree on the spelling, and a mismatch here is a proxy that dials a
    // pipe nothing is listening on, which looks exactly like the app not running.
    #[cfg(windows)]
    let text = text.to_lowercase();

    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Where the app data directory is, for a client that has to work it out for itself.
///
/// Only the proxy needs this: the app is handed its root by Tauri.
pub fn client_root() -> Option<PathBuf> {
    crate::socket_addr::app_data_dir()
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        fs,
        os::unix::{
            fs::PermissionsExt,
            net::{UnixListener, UnixStream},
        },
    };

    /// One connection. `UnixStream` unchanged: `try_clone` gives the writer thread its own
    /// handle, and reads and writes on a socket never serialized against each other to begin
    /// with.
    pub type Stream = UnixStream;

    pub struct Listener(UnixListener);

    /// The socket file: the data directory plus one name.
    pub fn endpoint(root: &Path) -> PathBuf {
        root.join(crate::socket_addr::SOCKET_NAME)
    }

    impl Listener {
        /// Removes a stale socket first: a crash leaves the file behind and bind would
        /// otherwise fail forever. Safe here because the containing directory is the app's
        /// own data dir, so nothing else has standing to have put a socket there.
        pub fn bind(root: &Path) -> io::Result<Self> {
            let path = endpoint(root);
            if path.exists() {
                fs::remove_file(&path)?;
            }
            let listener = UnixListener::bind(&path)?;
            // Owner-only. Does not stop a process running as this user, which is the threat
            // the pairing handshake exists for; it stops every *other* account on the machine.
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
            Ok(Self(listener))
        }

        pub fn incoming(&self) -> impl Iterator<Item = io::Result<Stream>> + '_ {
            self.0.incoming()
        }
    }

    pub fn connect(root: &Path) -> io::Result<Stream> {
        UnixStream::connect(endpoint(root))
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use interprocess::os::windows::{
        named_pipe::{pipe_mode, DuplexPipeStream, PipeListener, PipeListenerOptions},
        security_descriptor::SecurityDescriptor,
    };
    use widestring::U16CString;

    /// One connection: a duplex byte-mode pipe. `interprocess` opens every instance with
    /// `FILE_FLAG_OVERLAPPED`, which is what makes the concurrent read and write in
    /// `serve_session` and in the proxy legal rather than deadlock-prone.
    pub type Stream = DuplexPipeStream<pipe_mode::Bytes>;

    pub struct Listener(PipeListener<pipe_mode::Bytes, pipe_mode::Bytes>);

    /// `\\.\pipe\` is a single flat machine-wide namespace, so the name carries the tag that
    /// keeps two users (and two tests) apart. Unix gets this for free from the directory the
    /// socket sits in.
    pub fn endpoint(root: &Path) -> String {
        format!(
            r"\\.\pipe\{}.{}",
            crate::socket_addr::APP_IDENTIFIER,
            endpoint_tag(root)
        )
    }

    impl Listener {
        pub fn bind(root: &Path) -> io::Result<Self> {
            let name = endpoint(root);
            // Built before the pipe, and a hard failure: falling back to the default
            // descriptor would silently open the pipe to `Everyone` for read, which is
            // exactly the thing this is here to prevent.
            let sd = owner_only_descriptor()?;
            let listener = PipeListenerOptions::new()
                .path(name.as_str())
                .security_descriptor(Some(sd))
                .create_duplex::<pipe_mode::Bytes>()?;
            Ok(Self(listener))
        }

        pub fn incoming(&self) -> impl Iterator<Item = io::Result<Stream>> + '_ {
            self.0.incoming()
        }
    }

    pub fn connect(root: &Path) -> io::Result<Stream> {
        Stream::connect_by_path(endpoint(root).as_str())
    }

    /// A DACL granting the current user full control and naming nobody else.
    ///
    /// This is not belt and braces. A named pipe created with a null descriptor inherits a
    /// default whose ACEs grant `Everyone` and the anonymous account GENERIC_READ, so on a
    /// shared machine another account could open the pipe and read whatever the app writes
    /// before the handshake refuses it. The unix side has never had that problem: its socket
    /// is 0600 inside a 0700 directory.
    ///
    /// `P` makes the DACL protected, so nothing is inherited into it, and `GA` is generic-all
    /// for the one SID that follows.
    fn owner_only_descriptor() -> io::Result<SecurityDescriptor> {
        let sddl = format!("D:P(A;;GA;;;{})", current_user_sid()?);
        let wide = U16CString::from_str(&sddl)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        SecurityDescriptor::deserialize(&wide)
    }

    /// The current process's user SID, in string form (`S-1-5-21-...`).
    ///
    /// Queried rather than taken from the environment: `%USERNAME%` is whatever the parent
    /// process decided to pass down, and this string is the entire contents of the DACL.
    fn current_user_sid() -> io::Result<String> {
        use std::ptr;
        use windows_sys::Win32::{
            Foundation::{CloseHandle, LocalFree, HANDLE},
            Security::{
                Authorization::ConvertSidToStringSidW, GetTokenInformation, TokenUser, TOKEN_QUERY,
                TOKEN_USER,
            },
            System::Threading::{GetCurrentProcess, OpenProcessToken},
        };

        // SAFETY: every call below is checked, every handle and allocation is released on
        // both paths, and the two GetTokenInformation calls follow the documented
        // size-then-fill protocol.
        unsafe {
            let mut token: HANDLE = ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }

            // First call fails with ERROR_INSUFFICIENT_BUFFER and reports the size it wants.
            let mut needed: u32 = 0;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed);
            if needed == 0 {
                let e = io::Error::last_os_error();
                CloseHandle(token);
                return Err(e);
            }

            let mut buffer = vec![0u8; needed as usize];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            );
            // Read before closing the handle: CloseHandle sets the thread's last error too, so
            // the other order reports whatever it did instead of what actually failed.
            let failure = (ok == 0).then(io::Error::last_os_error);
            CloseHandle(token);
            if let Some(e) = failure {
                return Err(e);
            }

            let user = buffer.as_ptr().cast::<TOKEN_USER>();
            let mut raw: *mut u16 = ptr::null_mut();
            if ConvertSidToStringSidW((*user).User.Sid, &mut raw) == 0 {
                return Err(io::Error::last_os_error());
            }
            let sid = U16CString::from_ptr_str(raw).to_string_lossy();
            LocalFree(raw.cast());
            Ok(sid)
        }
    }
}

/// Dial the endpoint under `root`. The proxy's entire use of this module, plus the tests'.
pub fn connect(root: &Path) -> io::Result<Stream> {
    #[cfg(unix)]
    {
        unix::connect(root)
    }
    #[cfg(windows)]
    {
        windows::connect(root)
    }
}

/// A second handle onto the same connection, so one thread can write while another is parked
/// in a read.
///
/// A free function rather than a method because the two platforms spell it differently:
/// `UnixStream` has it inherently, and `interprocess` puts it on a trait. Neither spelling
/// should leak into the protocol code.
pub fn try_clone(stream: &Stream) -> io::Result<Stream> {
    #[cfg(unix)]
    {
        stream.try_clone()
    }
    #[cfg(windows)]
    {
        interprocess::TryClone::try_clone(stream)
    }
}

/// The pipe itself, which is the half that cannot be reasoned about from a cross-compile.
///
/// Everything here exercises code that only runs on Windows and only fails at runtime: a
/// malformed SDDL string, a SID lookup that returns something `ConvertStringSecurityDescriptor`
/// will not take, an endpoint name the two ends spell differently. A green `cargo check` says
/// nothing about any of it, which is why the CI job runs these on a real Windows runner.
#[cfg(all(test, windows))]
mod tests_windows {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn bytes_round_trip_over_the_pipe() {
        // Covers the whole creation path: the SID lookup, the SDDL parse, the pipe, and a
        // client dialing the name the other end derived independently.
        let dir = tempfile::tempdir().unwrap();
        let listener = Listener::bind(dir.path()).expect("bind");

        let server = std::thread::spawn(move || {
            let mut conn = listener
                .incoming()
                .next()
                .expect("a connection")
                .expect("accepted");
            let mut buf = [0u8; 5];
            conn.read_exact(&mut buf).unwrap();
            conn.write_all(&buf).unwrap();
            conn.flush().unwrap();
        });

        let mut client = connect(dir.path()).expect("connect");
        client.write_all(b"hello").unwrap();
        client.flush().unwrap();
        let mut back = [0u8; 5];
        client.read_exact(&mut back).unwrap();

        assert_eq!(&back, b"hello");
        server.join().unwrap();
    }

    #[test]
    fn the_pipe_name_cannot_be_taken_twice() {
        // FILE_FLAG_FIRST_PIPE_INSTANCE, which interprocess sets for us. It matters because
        // `\\.\pipe\` is machine-wide: without it another local process could create the name
        // first and the browser proxy would hand its traffic to that instead. With it, the
        // second binder is refused, so an occupied name is a loud failure rather than a silent
        // interception. Unix has no equivalent problem, since its socket lives in a directory
        // no other account can enter.
        let dir = tempfile::tempdir().unwrap();
        let _first = Listener::bind(dir.path()).expect("bind");
        assert!(
            Listener::bind(dir.path()).is_err(),
            "a second listener took a name that was already bound"
        );
    }

    #[test]
    fn two_roots_are_two_pipes() {
        // Two vaults, two users, or two tests at once. A shared name would have one app's
        // browser link answered by the other's.
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let _first = Listener::bind(a.path()).expect("bind a");
        let _second = Listener::bind(b.path()).expect("bind b");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn the_tag_ignores_path_case() {
        // The app and the proxy learn this path from two different Windows APIs. They agree on
        // the directory; nothing guarantees they agree on its capitalisation.
        assert_eq!(
            endpoint_tag(Path::new(
                r"C:\Users\Someone\AppData\Roaming\app.bramble.desktop"
            )),
            endpoint_tag(Path::new(
                r"c:\users\someone\appdata\roaming\app.bramble.desktop"
            ))
        );
    }

    #[test]
    fn the_tag_is_stable_and_root_specific() {
        // Both ends derive it independently on every launch, so an unstable tag would be a
        // proxy that dials an endpoint nothing is listening on.
        assert_eq!(
            endpoint_tag(Path::new("/a/b")),
            endpoint_tag(Path::new("/a/b"))
        );
        assert_ne!(
            endpoint_tag(Path::new("/a/b")),
            endpoint_tag(Path::new("/a/c"))
        );
    }
}
