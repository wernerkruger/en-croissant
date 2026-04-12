//! Persistent cache for full-game move reviews (classification + accuracy).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde::Deserialize;
use specta::Type;
use tauri::{AppHandle, Manager};

use crate::error::Error;

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveGameMoveReviewArgs {
    pub game_key: String,
    pub payload: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LoadGameMoveReviewArgs {
    pub game_key: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppendGameReviewBuildLogArgs {
    /// One JSON object per line (NDJSON / JSONL), appended to `game_review_build_logs.jsonl`.
    pub payload: String,
}

fn db_path(app: &AppHandle) -> Result<PathBuf, Error> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("game_move_review_cache.sqlite"))
}

fn open_conn(app: &AppHandle) -> Result<Connection, Error> {
    let path = db_path(app)?;
    let conn = Connection::open(path)?;
    conn.execute_batch(
        r"
        CREATE TABLE IF NOT EXISTS game_move_reviews (
            game_key TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        ",
    )?;
    Ok(conn)
}

#[tauri::command]
#[specta::specta]
pub fn save_game_move_review(app: AppHandle, args: SaveGameMoveReviewArgs) -> Result<(), Error> {
    let conn = open_conn(&app)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    conn.execute(
        r"
        INSERT INTO game_move_reviews (game_key, payload, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(game_key) DO UPDATE SET
            payload = excluded.payload,
            updated_at = excluded.updated_at;
        ",
        params![args.game_key, args.payload, now],
    )?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn load_game_move_review(app: AppHandle, args: LoadGameMoveReviewArgs) -> Result<Option<String>, Error> {
    let conn = open_conn(&app)?;
    let mut stmt = conn.prepare(
        r"
        SELECT payload FROM game_move_reviews WHERE game_key = ?1
        ",
    )?;
    let mut rows = stmt.query(params![args.game_key])?;
    if let Some(row) = rows.next()? {
        let payload: String = row.get(0)?;
        return Ok(Some(payload));
    }
    Ok(None)
}

#[tauri::command]
#[specta::specta]
pub fn append_game_review_build_log(
    app: AppHandle,
    args: AppendGameReviewBuildLogArgs,
) -> Result<(), Error> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("game_review_build_logs.jsonl");
    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    let line = args.payload.trim();
    if line.is_empty() {
        return Ok(());
    }
    writeln!(f, "{line}")?;
    Ok(())
}
