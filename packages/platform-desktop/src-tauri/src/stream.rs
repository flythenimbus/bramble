//! Bodies too large to cross the IPC whole, written a chunk at a time from the webview: a large
//! backup's upload body, or an exported backup file. See docs/cloud-storage-backups.md.
//!
//! A sink is opened with a known size, fed raw IPC chunks, and finished. Only a sink that
//! received exactly its size is finished: a file is renamed into place only then, and a request
//! body that came up short fails at the HTTP layer, so a cut-off write never yields something
//! that looks complete.

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use bytes::Bytes;
use tauri::ipc::{InvokeBody, Request};
use tokio::sync::mpsc;

use crate::net::HttpReply;

type Res<T> = Result<T, String>;

/// Chunks in flight between the webview and the request: enough to keep the upload busy, few
/// enough that memory stays at a few chunks whatever the backup's size.
const CHANNEL_DEPTH: usize = 4;

type Chunk = Result<Bytes, std::io::Error>;

enum Sink {
    Http {
        tx: mpsc::Sender<Chunk>,
        task: tauri::async_runtime::JoinHandle<Res<HttpReply>>,
        size: u64,
        written: u64,
    },
    File {
        file: Arc<Mutex<File>>,
        temp: PathBuf,
        dest: PathBuf,
        size: u64,
        written: u64,
    },
}

static SINKS: OnceLock<Mutex<HashMap<u32, Sink>>> = OnceLock::new();

fn sinks() -> MutexGuard<'static, HashMap<u32, Sink>> {
    SINKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}
static NEXT: AtomicU32 = AtomicU32::new(1);

fn main_only(window: &tauri::Window) -> Res<()> {
    if window.label() != crate::lifetime::MAIN {
        return Err("streams run from the main window only".into());
    }
    Ok(())
}

fn insert(sink: Sink) -> u32 {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    sinks().insert(id, sink);
    id
}

/// Start a request whose body arrives through `stream_write`. The task sends as chunks come in.
pub fn open_http(
    method: String,
    url: reqwest::Url,
    mut headers: Vec<(String, String)>,
    size: u64,
) -> u32 {
    let (tx, mut rx) = mpsc::channel::<Chunk>(CHANNEL_DEPTH);
    let body =
        reqwest::Body::wrap_stream(futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx)));
    // A declared length, not chunked encoding: some WebDAV servers refuse a chunked PUT, and a
    // length is what lets the server, not just us, tell a short body from a whole one.
    headers.retain(|(k, _)| !k.eq_ignore_ascii_case("content-length"));
    headers.push(("Content-Length".to_string(), size.to_string()));
    let task = tauri::async_runtime::spawn(async move {
        crate::net::send_body(
            &method,
            url,
            headers,
            body,
            crate::net::upload_timeout_for(size),
        )
        .await
    });
    insert(Sink::Http {
        tx,
        task,
        size,
        written: 0,
    })
}

/// Start an export to `dest`, written aside and renamed into place at the end.
#[tauri::command]
pub fn shell_export_open(window: tauri::Window, path: String, size: u64) -> Res<u32> {
    main_only(&window)?;
    open_file(PathBuf::from(path), size)
}

fn open_file(dest: PathBuf, size: u64) -> Res<u32> {
    let name = dest
        .file_name()
        .ok_or("export path has no file name")?
        .to_string_lossy()
        .into_owned();
    let temp = dest.with_file_name(format!(".{name}.partial"));
    let file = File::create(&temp).map_err(|e| format!("export: {}", e.kind()))?;
    Ok(insert(Sink::File {
        file: Arc::new(Mutex::new(file)),
        temp,
        dest,
        size,
        written: 0,
    }))
}

/// One chunk, as raw bytes, for the sink named in `x-stream-id`. Waits until there is room.
#[tauri::command]
pub async fn stream_write(window: tauri::Window, request: Request<'_>) -> Res<()> {
    main_only(&window)?;
    let InvokeBody::Raw(chunk) = request.body() else {
        return Err("expected a raw body".into());
    };
    let id: u32 = request
        .headers()
        .get("x-stream-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or("missing stream id")?;
    write(id, chunk).await
}

async fn write(id: u32, chunk: &[u8]) -> Res<()> {
    let len = chunk.len() as u64;
    enum Target {
        Http(mpsc::Sender<Chunk>),
        File(Arc<Mutex<File>>),
    }
    let target = {
        let mut sinks = sinks();
        let sink = sinks.get_mut(&id).ok_or("no such stream")?;
        match sink {
            Sink::Http {
                tx, size, written, ..
            } => {
                if *written + len > *size {
                    return Err("more bytes than the stream was opened for".into());
                }
                *written += len;
                Target::Http(tx.clone())
            }
            Sink::File {
                file,
                size,
                written,
                ..
            } => {
                if *written + len > *size {
                    return Err("more bytes than the stream was opened for".into());
                }
                *written += len;
                Target::File(file.clone())
            }
        }
    };
    match target {
        Target::Http(tx) => tx
            .send(Ok(Bytes::copy_from_slice(chunk)))
            .await
            .map_err(|_| "the request ended before its body was sent".to_string()),
        Target::File(file) => file
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .write_all(chunk)
            .map_err(|e| format!("export: {}", e.kind())),
    }
}

/// End a stream. A request returns its reply; a file is renamed into place, but only if it holds
/// every byte it was opened for.
#[tauri::command]
pub async fn stream_finish(window: tauri::Window, id: u32) -> Res<Option<HttpReply>> {
    main_only(&window)?;
    finish(id).await
}

async fn finish(id: u32) -> Res<Option<HttpReply>> {
    let sink = sinks().remove(&id).ok_or("no such stream")?;
    match sink {
        Sink::Http {
            tx,
            task,
            size,
            written,
        } => {
            // Closing the channel ends the body. If it is short, the declared length makes the
            // request fail rather than land as a complete upload.
            drop(tx);
            let reply = task.await.map_err(|e| format!("upload task: {e}"))??;
            if written != size {
                return Err(format!("upload stopped at {written} of {size} bytes"));
            }
            Ok(Some(reply))
        }
        Sink::File {
            file,
            temp,
            dest,
            size,
            written,
        } => {
            let result = (|| {
                if written != size {
                    return Err(format!("export stopped at {written} of {size} bytes"));
                }
                let f = file.lock().unwrap_or_else(|e| e.into_inner());
                f.sync_all().map_err(|e| format!("export: {}", e.kind()))?;
                std::fs::rename(&temp, &dest).map_err(|e| format!("export: {}", e.kind()))
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(&temp);
            }
            result.map(|_| None)
        }
    }
}

/// Abandon a stream: the request is cancelled, a partial file deleted.
#[tauri::command]
pub fn stream_abort(window: tauri::Window, id: u32) -> Res<()> {
    main_only(&window)?;
    stream_abort_id(id);
    Ok(())
}

fn stream_abort_id(id: u32) {
    let sink = sinks().remove(&id);
    match sink {
        Some(Sink::Http { task, .. }) => task.abort(),
        Some(Sink::File { temp, .. }) => {
            let _ = std::fs::remove_file(temp);
        }
        None => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
    use std::net::TcpListener;

    /// A one-request HTTP server: reads the headers and exactly Content-Length bytes, answers
    /// 201, and hands back what it got.
    /// The request's header lines and body, once the server has read them.
    type Received = std::thread::JoinHandle<(Vec<String>, Vec<u8>)>;

    fn one_request_server() -> (String, Received) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/dav/x.bramble", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut headers = Vec::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                headers.push(line.trim_end().to_string());
            }
            let len: usize = headers
                .iter()
                .find_map(|h| {
                    let (k, v) = h.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse().unwrap())
                })
                .expect("a declared length");
            let mut body = vec![0u8; len];
            reader.read_exact(&mut body).unwrap();
            let mut out = stream;
            out.write_all(b"HTTP/1.1 201 Created\r\ncontent-length: 2\r\n\r\nok")
                .unwrap();
            (headers, body)
        });
        (url, handle)
    }

    #[test]
    fn streams_an_upload_body_with_its_declared_length() {
        tauri::async_runtime::block_on(async {
            let (url, server) = one_request_server();
            let body: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
            let id = open_http(
                "PUT".into(),
                reqwest::Url::parse(&url).unwrap(),
                vec![("Authorization".into(), "Basic x".into())],
                body.len() as u64,
            );
            for chunk in body.chunks(64 * 1024) {
                write(id, chunk).await.unwrap();
            }
            let reply = finish(id).await.unwrap().unwrap();
            assert_eq!(reply.status, 201);
            let (headers, got) = server.join().unwrap();
            assert!(headers
                .iter()
                .any(|h| h.eq_ignore_ascii_case("authorization: Basic x")));
            assert!(!headers
                .iter()
                .any(|h| h.to_ascii_lowercase().starts_with("transfer-encoding")));
            assert_eq!(got, body);
        });
    }

    #[test]
    fn refuses_more_than_the_declared_length() {
        tauri::async_runtime::block_on(async {
            let dir = std::env::temp_dir().join(format!("bramble-stream-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let id = open_file(dir.join("over.bramble"), 3).unwrap();
            assert!(write(id, &[1, 2, 3, 4]).await.is_err());
            stream_abort_id(id);
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    #[test]
    fn renames_an_export_into_place_only_when_whole() {
        tauri::async_runtime::block_on(async {
            let dir = std::env::temp_dir().join(format!("bramble-export-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let dest = dir.join("backup.bramble");

            let short = open_file(dest.clone(), 10).unwrap();
            write(short, &[1, 2, 3]).await.unwrap();
            assert!(finish(short).await.is_err());
            assert!(
                !dest.exists(),
                "a short export must not take the chosen name"
            );
            assert!(!dir.join(".backup.bramble.partial").exists());

            let whole = open_file(dest.clone(), 4).unwrap();
            write(whole, &[1, 2]).await.unwrap();
            write(whole, &[3, 4]).await.unwrap();
            finish(whole).await.unwrap();
            assert_eq!(std::fs::read(&dest).unwrap(), vec![1, 2, 3, 4]);
            std::fs::remove_dir_all(&dir).ok();
        });
    }
}
