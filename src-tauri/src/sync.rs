//! SFTP-backed cloud sync for the embedded library (PDF books) and pinned games.
//!
//! The webview cannot speak SFTP, so all transport happens here over a
//! pure-Rust SSH/SFTP stack (`russh` + `russh-sftp`). Each command opens a
//! fresh, short-lived connection which keeps the surface stateless and robust
//! for a personal-scale library.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    /// Remote base directory, e.g. `chess-data`.
    pub remote_dir: String,
}

struct Client;

#[async_trait::async_trait]
impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // This is a personal sync target; trust the host key.
        Ok(true)
    }
}

async fn authenticate(
    handle: &mut client::Handle<Client>,
    username: &str,
    password: &str,
) -> Result<(), String> {
    use client::KeyboardInteractiveAuthResponse;

    if handle
        .authenticate_password(username, password)
        .await
        .map_err(|e| format!("Authentication error: {e}"))?
    {
        return Ok(());
    }

    // Some hosts accept the password only via keyboard-interactive prompts.
    let mut resp = handle
        .authenticate_keyboard_interactive_start(username, None)
        .await
        .map_err(|e| format!("Authentication error: {e}"))?;

    loop {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure => {
                return Err(
                    "Authentication failed: wrong username or password (SFTP uses port 22, not FTP port 21)".to_string(),
                );
            }
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let responses: Vec<String> = prompts
                    .iter()
                    .map(|prompt| {
                        if prompt.echo {
                            username.to_string()
                        } else {
                            password.to_string()
                        }
                    })
                    .collect();
                resp = handle
                    .authenticate_keyboard_interactive_respond(responses)
                    .await
                    .map_err(|e| format!("Authentication error: {e}"))?;
            }
        }
    }
}

async fn connect(opts: &SyncOptions) -> Result<(client::Handle<Client>, SftpSession), String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(60)),
        ..Default::default()
    });

    let mut handle = client::connect(config, (opts.host.as_str(), opts.port), Client)
        .await
        .map_err(|e| format!("Could not connect to {}:{} ({e})", opts.host, opts.port))?;

    authenticate(&mut handle, &opts.username, &opts.password).await?;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Could not open SSH channel: {e}"))?;

    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("Could not start SFTP subsystem: {e}"))?;

    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("Could not initialise SFTP session: {e}"))?;

    Ok((handle, sftp))
}

/// Create a directory if it does not exist yet.
async fn ensure_dir(sftp: &SftpSession, path: &str) -> Result<(), String> {
    if sftp.read_dir(path).await.is_ok() {
        return Ok(());
    }
    sftp.create_dir(path)
        .await
        .map_err(|e| format!("Could not create remote folder {path}: {e}"))
}

fn books_dir(opts: &SyncOptions) -> String {
    format!("{}/books", opts.remote_dir.trim_end_matches('/'))
}

fn manifest_path(opts: &SyncOptions) -> String {
    format!("{}/manifest.json", opts.remote_dir.trim_end_matches('/'))
}

/// Connect, authenticate and make sure the base layout (`chess-data/books`)
/// exists. Used by the "Test connection" button and before every sync.
#[tauri::command]
#[specta::specta]
pub async fn sync_test(opts: SyncOptions) -> Result<(), String> {
    let (_handle, sftp) = connect(&opts).await?;
    ensure_dir(&sftp, opts.remote_dir.trim_end_matches('/')).await?;
    ensure_dir(&sftp, &books_dir(&opts)).await?;
    Ok(())
}

/// Read `chess-data/manifest.json`. Returns `None` when the file does not exist
/// yet (first ever sync).
#[tauri::command]
#[specta::specta]
pub async fn sync_read_manifest(opts: SyncOptions) -> Result<Option<String>, String> {
    let (_handle, sftp) = connect(&opts).await?;
    let path = manifest_path(&opts);
    match sftp.open(&path).await {
        Ok(mut file) => {
            let mut buf = String::new();
            file.read_to_string(&mut buf)
                .await
                .map_err(|e| format!("Could not read manifest: {e}"))?;
            Ok(Some(buf))
        }
        Err(_) => Ok(None),
    }
}

/// Overwrite `chess-data/manifest.json` with the merged manifest.
#[tauri::command]
#[specta::specta]
pub async fn sync_write_manifest(opts: SyncOptions, content: String) -> Result<(), String> {
    let (_handle, sftp) = connect(&opts).await?;
    ensure_dir(&sftp, opts.remote_dir.trim_end_matches('/')).await?;
    let path = manifest_path(&opts);
    let mut file = sftp
        .create(&path)
        .await
        .map_err(|e| format!("Could not create manifest: {e}"))?;
    file.write_all(content.as_bytes())
        .await
        .map_err(|e| format!("Could not write manifest: {e}"))?;
    let _ = file.flush().await;
    let _ = file.shutdown().await;
    Ok(())
}

/// List the PDF file names present under `chess-data/books`.
#[tauri::command]
#[specta::specta]
pub async fn sync_list_books(opts: SyncOptions) -> Result<Vec<String>, String> {
    let (_handle, sftp) = connect(&opts).await?;
    ensure_dir(&sftp, opts.remote_dir.trim_end_matches('/')).await?;
    let dir = books_dir(&opts);
    ensure_dir(&sftp, &dir).await?;
    let entries = sftp
        .read_dir(&dir)
        .await
        .map_err(|e| format!("Could not list books: {e}"))?;
    let mut names = Vec::new();
    for entry in entries {
        names.push(entry.file_name());
    }
    Ok(names)
}

/// Upload a local file to `chess-data/books/<remote_name>`.
#[tauri::command]
#[specta::specta]
pub async fn sync_upload_book(
    opts: SyncOptions,
    local_path: String,
    remote_name: String,
) -> Result<(), String> {
    let data = tokio::fs::read(&local_path)
        .await
        .map_err(|e| format!("Could not read local book: {e}"))?;

    let (_handle, sftp) = connect(&opts).await?;
    ensure_dir(&sftp, opts.remote_dir.trim_end_matches('/')).await?;
    ensure_dir(&sftp, &books_dir(&opts)).await?;

    let remote = format!("{}/{}", books_dir(&opts), remote_name);
    let mut file = sftp
        .create(&remote)
        .await
        .map_err(|e| format!("Could not create remote book: {e}"))?;
    file.write_all(&data)
        .await
        .map_err(|e| format!("Could not upload book: {e}"))?;
    let _ = file.flush().await;
    let _ = file.shutdown().await;
    Ok(())
}

/// Download `chess-data/books/<remote_name>` to `local_path`.
#[tauri::command]
#[specta::specta]
pub async fn sync_download_book(
    opts: SyncOptions,
    remote_name: String,
    local_path: String,
) -> Result<(), String> {
    let (_handle, sftp) = connect(&opts).await?;
    let remote = format!("{}/{}", books_dir(&opts), remote_name);
    let mut file = sftp
        .open(&remote)
        .await
        .map_err(|e| format!("Could not open remote book: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .await
        .map_err(|e| format!("Could not download book: {e}"))?;

    if let Some(parent) = Path::new(&local_path).parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    tokio::fs::write(&local_path, buf)
        .await
        .map_err(|e| format!("Could not save book locally: {e}"))?;
    Ok(())
}
