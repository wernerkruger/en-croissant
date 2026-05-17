//! Chess.com style bots: download rapid games, build move-choice profiles, play by profile.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use log::info;
use rand::Rng;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use shakmaty::{
    fen::Fen, san::SanPlus, uci::UciMove, CastlingMode, Chess, EnPassantMode, FromSetup,
    Position,
};
use specta::Type;
use tauri::{AppHandle, Manager};
use vampirc_uci::UciMessage;

use crate::{
    engine::{BaseEngine, GoMode},
    error::Error,
    progress::update_progress,
    AppState,
};

const BOTS_DIR: &str = "chesscom_bots";
const GAMES_SUBDIR: &str = "games";
const PROFILES_SUBDIR: &str = "profiles";
const MANIFEST_FILE: &str = "manifest.json";
const CHECKPOINTS_SUBDIR: &str = "checkpoints";
/// Skip re-download when an existing games file is at least this large.
const MIN_GAMES_FILE_BYTES: u64 = 64;
const DEFAULT_MAX_GAMES: u32 = 80;
const ANALYSIS_DEPTH: u32 = 14;
const MULTIPV: u16 = 5;
const RATING_BUCKET_HALF: i32 = 75;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChesscomUserEntry {
    pub target_elo: i32,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MoveProfileBucket {
    /// Fraction of moves at engine rank 1..N (index 0 = best move).
    pub rank_rates: Vec<f64>,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChesscomBotProfile {
    pub id: String,
    pub target_elo: i32,
    pub source_username: String,
    pub bot_username: String,
    pub moves: HashMap<String, MoveProfileBucket>,
    pub games_analyzed: u32,
    pub positions_analyzed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChesscomBotManifestEntry {
    pub id: String,
    pub target_elo: i32,
    pub source_username: String,
    pub bot_username: String,
    pub games_file: String,
    pub profile_file: String,
    #[serde(default)]
    pub profile_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChesscomDownloadBatchResult {
    pub bots: Vec<ChesscomBotManifestEntry>,
    pub downloaded: u32,
    pub skipped: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BuildChesscomBotProfilesResult {
    pub profiles: Vec<ChesscomBotProfile>,
    pub players_built: u32,
    pub players_skipped_complete: u32,
    pub players_resumed: u32,
    pub total_positions_analyzed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProfileBuildCheckpoint {
    game_index: usize,
    max_games: u32,
    buckets: HashMap<String, MoveProfileBucket>,
    games_analyzed: u32,
    positions_analyzed: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Manifest {
    bots: Vec<ChesscomBotManifestEntry>,
}

pub fn bots_root(app: &AppHandle) -> Result<PathBuf, Error> {
    let dir = app.path().app_data_dir()?.join(BOTS_DIR);
    fs::create_dir_all(&dir)?;
    fs::create_dir_all(dir.join(GAMES_SUBDIR))?;
    fs::create_dir_all(dir.join(PROFILES_SUBDIR))?;
    fs::create_dir_all(dir.join(CHECKPOINTS_SUBDIR))?;
    Ok(dir)
}

fn checkpoint_path(root: &Path, id: &str) -> PathBuf {
    root.join(CHECKPOINTS_SUBDIR).join(format!("{id}.json"))
}

fn load_checkpoint(root: &Path, id: &str) -> Result<Option<ProfileBuildCheckpoint>, Error> {
    let path = checkpoint_path(root, id);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)?;
    Ok(Some(serde_json::from_str(&raw).map_err(|e| {
        Error::Io(Box::new(std::io::Error::other(e.to_string())))
    })?))
}

fn save_checkpoint(root: &Path, id: &str, cp: &ProfileBuildCheckpoint) -> Result<(), Error> {
    let json = serde_json::to_string_pretty(cp)
        .map_err(|e| Error::Io(Box::new(std::io::Error::other(e.to_string()))))?;
    fs::write(checkpoint_path(root, id), json)?;
    Ok(())
}

fn delete_checkpoint(root: &Path, id: &str) {
    let _ = fs::remove_file(checkpoint_path(root, id));
}

fn games_file_has_data(path: &Path) -> bool {
    fs::metadata(path)
        .map(|m| m.len() >= MIN_GAMES_FILE_BYTES)
        .unwrap_or(false)
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join(MANIFEST_FILE)
}

fn load_manifest(root: &Path) -> Result<Manifest, Error> {
    let path = manifest_path(root);
    if !path.exists() {
        return Ok(Manifest::default());
    }
    let raw = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw).map_err(|e| {
        Error::Io(Box::new(std::io::Error::other(e.to_string())))
    })?)
}

fn save_manifest(root: &Path, manifest: &Manifest) -> Result<(), Error> {
    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| Error::Io(Box::new(std::io::Error::other(e.to_string()))))?;
    fs::write(manifest_path(root), json)?;
    Ok(())
}

pub fn profile_path(root: &Path, id: &str) -> PathBuf {
    root.join(PROFILES_SUBDIR).join(format!("{id}.json"))
}

pub fn load_profile(app: &AppHandle, id: &str) -> Result<ChesscomBotProfile, Error> {
    let root = bots_root(app)?;
    let path = profile_path(&root, id);
    let raw = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw).map_err(|e| {
        Error::Io(Box::new(std::io::Error::other(e.to_string())))
    })?)
}

fn bot_username(target_elo: i32, source: &str) -> String {
    let safe: String = source
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    format!("StyleBot_{}_{}", target_elo, safe)
}

fn profile_id(target_elo: i32, source: &str) -> String {
    format!("{}_{}", target_elo, source.to_lowercase())
}

fn rating_in_bucket(player_elo: i32, target_elo: i32) -> bool {
    (player_elo - target_elo).abs() <= RATING_BUCKET_HALF
}

fn parse_users_file(content: &str) -> Vec<ChesscomUserEntry> {
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (elo, user) = line.split_once(':')?;
            let target_elo = elo.trim().parse().ok()?;
            let username = user.trim().to_string();
            if username.is_empty() {
                return None;
            }
            Some(ChesscomUserEntry {
                target_elo,
                username,
            })
        })
        .collect()
}

async fn fetch_json(client: &Client, url: &str) -> Result<Value, Error> {
    let resp = client
        .get(url)
        .header("User-Agent", "EnCroissant/1.0")
        .send()
        .await?
        .error_for_status()?;
    Ok(resp.json().await?)
}

async fn download_rapid_pgns<F>(
    client: &Client,
    username: &str,
    mut on_archive_progress: F,
) -> Result<String, Error>
where
    F: FnMut(usize, usize),
{
    let user = username.to_lowercase();
    let archives_url = format!("https://api.chess.com/pub/player/{user}/games/archives");
    let archives = fetch_json(client, &archives_url).await?;
    let Some(archive_list) = archives.get("archives").and_then(|v| v.as_array()) else {
        return Ok(String::new());
    };

    let archive_total = archive_list.len().max(1);
    let mut pgns = Vec::new();
    for (archive_idx, archive) in archive_list.iter().enumerate() {
        on_archive_progress(archive_idx, archive_total);
        let Some(url) = archive.as_str() else { continue };
        let data = fetch_json(client, url).await?;
        let Some(games) = data.get("games").and_then(|v| v.as_array()) else {
            continue;
        };
        for game in games {
            let time_class = game
                .get("time_class")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if time_class != "rapid" {
                continue;
            }
            if let Some(pgn) = game.get("pgn").and_then(|v| v.as_str()) {
                if !pgn.is_empty() {
                    pgns.push(pgn.to_string());
                }
            }
        }
    }
    on_archive_progress(archive_total, archive_total);
    Ok(pgns.join("\n\n"))
}

struct ParsedGame {
    white: String,
    black: String,
    white_elo: Option<i32>,
    black_elo: Option<i32>,
    moves_uci: Vec<String>,
}

struct GameParser {
    white: String,
    black: String,
    white_elo: Option<i32>,
    black_elo: Option<i32>,
    position: Chess,
    moves_uci: Vec<String>,
    skip: bool,
}

impl GameParser {
    fn new() -> Self {
        Self {
            white: String::new(),
            black: String::new(),
            white_elo: None,
            black_elo: None,
            position: Chess::default(),
            moves_uci: Vec::new(),
            skip: false,
        }
    }

    fn reset(&mut self) {
        *self = Self::new();
    }
}

impl pgn_reader::Visitor for GameParser {
    type Result = ();

    fn header(&mut self, key: &[u8], value: pgn_reader::RawHeader<'_>) {
        let v = value.decode_utf8_lossy();
        match key {
            b"White" => self.white = v.into_owned(),
            b"Black" => self.black = v.into_owned(),
            b"WhiteElo" => self.white_elo = v.parse().ok(),
            b"BlackElo" => self.black_elo = v.parse().ok(),
            b"FEN" => {
                if let Ok(fen) = Fen::from_ascii(v.as_bytes()) {
                    let setup = fen.into_setup();
                    let mode = CastlingMode::detect(&setup);
                    if let Ok(pos) = Chess::from_setup(setup, mode) {
                        self.position = pos;
                    }
                }
            }
            _ => {}
        }
    }

    fn san(&mut self, san: SanPlus) {
        if self.skip {
            return;
        }
        let Ok(mv) = san.san.to_move(&self.position) else {
            self.skip = true;
            return;
        };
        let setup = self.position.clone().into_setup(EnPassantMode::Legal);
        let castling = CastlingMode::detect(&setup);
        let uci = UciMove::from_move(&mv, castling).to_string();
        self.moves_uci.push(uci);
        self.position.play_unchecked(&mv);
    }

    fn begin_variation(&mut self) -> pgn_reader::Skip {
        pgn_reader::Skip(true)
    }

    fn end_game(&mut self) {}
}

fn parse_games_for_user(pgn_text: &str, username: &str) -> Vec<ParsedGame> {
    let user_lower = username.to_lowercase();
    let mut out = Vec::new();
    let mut visitor = GameParser::new();
    let mut reader = pgn_reader::BufferedReader::new_cursor(pgn_text.as_bytes());

    loop {
        visitor.reset();
        let Ok(Some(())) = reader.read_game(&mut visitor) else {
            break;
        };
        if visitor.skip || visitor.moves_uci.is_empty() {
            continue;
        }
        let is_white = visitor.white.eq_ignore_ascii_case(&user_lower);
        let is_black = visitor.black.eq_ignore_ascii_case(&user_lower);
        if !is_white && !is_black {
            continue;
        }
        out.push(ParsedGame {
            white: visitor.white.clone(),
            black: visitor.black.clone(),
            white_elo: visitor.white_elo,
            black_elo: visitor.black_elo,
            moves_uci: visitor.moves_uci.clone(),
        });
    }
    out
}

async fn analyze_player_games<F, G>(
    engine: &mut BaseEngine,
    entry: &ChesscomBotManifestEntry,
    games: &[ParsedGame],
    max_games: u32,
    start_game_index: usize,
    mut buckets: HashMap<String, MoveProfileBucket>,
    mut games_analyzed: u32,
    mut positions_analyzed: u32,
    progress: F,
    mut on_game_done: G,
) -> Result<(HashMap<String, MoveProfileBucket>, u32, u32), Error>
where
    F: Fn(f32),
    G: FnMut(usize, &HashMap<String, MoveProfileBucket>, u32, u32),
{
    let user_lower = entry.source_username.to_lowercase();
    let limit = games.len().min(max_games as usize);
    let slice = &games[..limit];

    for (game_idx, game) in slice.iter().enumerate().skip(start_game_index) {
        progress((game_idx as f32 + 1.0) / limit.max(1) as f32);

        let is_white = game.white.eq_ignore_ascii_case(&user_lower);
        let player_elo = if is_white {
            game.white_elo
        } else {
            game.black_elo
        };
        let Some(elo) = player_elo else {
            continue;
        };
        if !rating_in_bucket(elo, entry.target_elo) {
            continue;
        }

        let mut fen = Fen::from_position(Chess::default(), EnPassantMode::Legal).to_string();
        let mut prefix: Vec<String> = Vec::new();
        let mut game_positions = 0u32;

        for (ply, played) in game.moves_uci.iter().enumerate() {
            let is_player_turn = (is_white && ply % 2 == 0) || (!is_white && ply % 2 == 1);
            if is_player_turn {
                let move_no = (ply as u32 / 2) + 1;
                let tops = engine_top_moves(engine, &fen, &prefix).await?;
                if !tops.is_empty() {
                    let rank = move_rank(played, &tops);
                    add_observation(&mut buckets, move_no, rank);
                    positions_analyzed += 1;
                    game_positions += 1;
                }
            }
            prefix.push(played.clone());
            if let Ok(pos) = crate::engine::parse_fen_and_apply_moves(&fen, &prefix) {
                fen = Fen::from_position(pos, EnPassantMode::Legal).to_string();
            }
        }

        if game_positions > 0 {
            games_analyzed += 1;
        }

        on_game_done(game_idx + 1, &buckets, games_analyzed, positions_analyzed);
    }

    Ok((buckets, games_analyzed, positions_analyzed))
}

pub async fn engine_top_moves(
    engine: &mut BaseEngine,
    fen: &str,
    moves: &[String],
) -> Result<Vec<String>, Error> {
    engine.set_option("MultiPV", MULTIPV).await?;
    engine.set_position(fen, moves).await?;
    engine.go(&GoMode::Depth(ANALYSIS_DEPTH)).await?;

    let reader = engine.reader_mut().ok_or(Error::EngineDisconnected)?;
    let mut by_pv: HashMap<u16, (u32, String)> = HashMap::new();

    while let Some(line) = reader.next_line().await? {
        let msg = vampirc_uci::parse_one(&line);
        match msg {
            UciMessage::Info(attrs) => {
                let mut pv = 1u16;
                let mut depth = 0u32;
                let mut first_uci: Option<String> = None;
                for a in attrs {
                    match a {
                        vampirc_uci::UciInfoAttribute::MultiPv(m) => pv = m,
                        vampirc_uci::UciInfoAttribute::Depth(d) => depth = d,
                        vampirc_uci::UciInfoAttribute::Pv(moves_pv) => {
                            if let Some(m) = moves_pv.first() {
                                first_uci = Some(m.to_string());
                            }
                        }
                        _ => {}
                    }
                }
                if let Some(uci) = first_uci {
                    let entry = by_pv.entry(pv).or_insert((0, uci.clone()));
                    if depth >= entry.0 {
                        *entry = (depth, uci);
                    }
                }
            }
            UciMessage::BestMove { .. } => break,
            _ => {}
        }
    }

    let mut pvs: Vec<_> = by_pv.into_iter().collect();
    pvs.sort_by_key(|(pv, _)| *pv);
    Ok(pvs.into_iter().map(|(_, (_, uci))| uci).collect())
}

fn move_rank(played: &str, tops: &[String]) -> usize {
    for (i, uci) in tops.iter().enumerate() {
        if uci.eq_ignore_ascii_case(played) {
            return i + 1;
        }
    }
    tops.len() + 1
}

fn add_observation(
    buckets: &mut HashMap<String, MoveProfileBucket>,
    move_no: u32,
    rank: usize,
) {
    let key = move_no.to_string();
    let bucket = buckets.entry(key).or_insert_with(|| MoveProfileBucket {
        rank_rates: vec![0.0; MULTIPV as usize + 1],
        total: 0,
    });
    while bucket.rank_rates.len() <= rank {
        bucket.rank_rates.push(0.0);
    }
    bucket.rank_rates[rank - 1] += 1.0;
    bucket.total += 1;
}

fn finalize_buckets(buckets: &mut HashMap<String, MoveProfileBucket>) {
    for bucket in buckets.values_mut() {
        if bucket.total == 0 {
            continue;
        }
        let sum: f64 = bucket.rank_rates.iter().sum();
        if sum > 0.0 {
            for r in &mut bucket.rank_rates {
                *r /= sum;
            }
        }
    }
}

pub fn pick_move_from_profile(
    profile: &ChesscomBotProfile,
    move_number: u32,
    engine_lines: &[String],
) -> String {
    if engine_lines.is_empty() {
        return String::new();
    }
    let key = move_number.to_string();
    let bucket = profile
        .moves
        .get(&key)
        .or_else(|| profile.moves.values().next());

    let rank = if let Some(b) = bucket {
        if b.rank_rates.is_empty() || b.total == 0 {
            1
        } else {
            let mut rng = rand::thread_rng();
            let roll: f64 = rng.gen();
            let mut acc = 0.0;
            let mut chosen = b.rank_rates.len();
            for (i, rate) in b.rank_rates.iter().enumerate() {
                acc += rate;
                if roll <= acc {
                    chosen = i + 1;
                    break;
                }
            }
            chosen.min(engine_lines.len())
        }
    } else {
        1
    };

    engine_lines
        .get(rank.saturating_sub(1))
        .cloned()
        .unwrap_or_else(|| engine_lines[0].clone())
}

#[tauri::command]
#[specta::specta]
pub async fn get_chesscom_bots_directory(app: AppHandle) -> Result<String, Error> {
    Ok(bots_root(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
#[specta::specta]
pub async fn parse_chesscom_users_file(content: String) -> Result<Vec<ChesscomUserEntry>, Error> {
    Ok(parse_users_file(&content))
}

#[tauri::command]
#[specta::specta]
pub async fn list_chesscom_bot_profiles(app: AppHandle) -> Result<Vec<ChesscomBotManifestEntry>, Error> {
    let root = bots_root(&app)?;
    let manifest = load_manifest(&root)?;
    Ok(manifest.bots)
}

#[tauri::command]
#[specta::specta]
pub async fn download_chesscom_rapid_games_batch(
    app: AppHandle,
    entries: Vec<ChesscomUserEntry>,
    progress_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<ChesscomDownloadBatchResult, Error> {
    let root = bots_root(&app)?;
    let mut manifest = load_manifest(&root)?;
    let client = Client::new();
    let player_count = entries.len().max(1) as f32;
    let mut downloaded = 0u32;
    let mut skipped = 0u32;

    for (i, entry) in entries.iter().enumerate() {
        let player_base = (i as f32 / player_count) * 100.0;
        let player_weight = 100.0 / player_count;

        update_progress(
            &state.progress_state,
            &app,
            progress_id.clone(),
            player_base,
            false,
        )?;

        let games_path = root
            .join(GAMES_SUBDIR)
            .join(format!("{}.pgn", entry.username.to_lowercase()));

        if games_file_has_data(&games_path) {
            info!(
                "Skipping chess.com download for {} — games file already exists ({})",
                entry.username,
                games_path.display()
            );
            skipped += 1;
        } else {
            let pgns = download_rapid_pgns(&client, &entry.username, |archive_idx, archive_total| {
                let frac = archive_idx as f32 / archive_total.max(1) as f32;
                let p = player_base + player_weight * frac;
                let _ =
                    update_progress(&state.progress_state, &app, progress_id.clone(), p, false);
            })
            .await?;
            fs::write(&games_path, &pgns)?;
            downloaded += 1;
            info!(
                "Downloaded rapid games for {} ({} bytes)",
                entry.username,
                pgns.len()
            );
        }

        let id = profile_id(entry.target_elo, &entry.username);
        let bot_name = bot_username(entry.target_elo, &entry.username);
        let profile_file = profile_path(&root, &id);
        let existing_complete = manifest
            .bots
            .iter()
            .find(|b| b.id == id)
            .map(|b| b.profile_complete)
            .unwrap_or(false);
        let item = ChesscomBotManifestEntry {
            id: id.clone(),
            target_elo: entry.target_elo,
            source_username: entry.username.clone(),
            bot_username: bot_name,
            games_file: games_path.to_string_lossy().into_owned(),
            profile_file: profile_file.to_string_lossy().into_owned(),
            profile_complete: existing_complete,
        };
        manifest.bots.retain(|b| b.id != id);
        manifest.bots.push(item);

        update_progress(
            &state.progress_state,
            &app,
            progress_id.clone(),
            player_base + player_weight,
            false,
        )?;
    }

    manifest.bots.sort_by_key(|b| (b.target_elo, b.source_username.clone()));
    save_manifest(&root, &manifest)?;
    update_progress(&state.progress_state, &app, progress_id, 100.0, true)?;
    Ok(ChesscomDownloadBatchResult {
        bots: manifest.bots,
        downloaded,
        skipped,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn build_chesscom_bot_profiles_batch(
    app: AppHandle,
    engine_path: String,
    max_games_per_user: Option<u32>,
    force_restart: bool,
    progress_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<BuildChesscomBotProfilesResult, Error> {
    let root = bots_root(&app)?;
    let mut manifest = load_manifest(&root)?;
    let max_games = max_games_per_user.unwrap_or(DEFAULT_MAX_GAMES);
    let mut profiles = Vec::new();
    let player_count = manifest.bots.len().max(1) as f32;
    let mut players_built = 0u32;
    let mut players_skipped_complete = 0u32;
    let mut players_resumed = 0u32;
    let mut total_positions_analyzed = 0u32;

    let mut engine = BaseEngine::spawn(PathBuf::from(&engine_path)).await?;
    engine.init_uci().await?;

    let bot_entries = manifest.bots.clone();
    for (i, entry) in bot_entries.iter().enumerate() {
        let player_base = (i as f32 / player_count) * 100.0;
        let player_weight = 100.0 / player_count;

        if entry.profile_complete && !force_restart {
            info!(
                "Skipping profile build for {} — already complete",
                entry.source_username
            );
            players_skipped_complete += 1;
            update_progress(
                &state.progress_state,
                &app,
                progress_id.clone(),
                player_base + player_weight,
                false,
            )?;
            if let Ok(existing) = load_profile(&app, &entry.id) {
                profiles.push(existing);
            }
            continue;
        }

        if force_restart {
            delete_checkpoint(&root, &entry.id);
        }

        let pgn = fs::read_to_string(&entry.games_file).unwrap_or_default();
        let games = parse_games_for_user(&pgn, &entry.source_username);
        info!(
            "Parsed {} games from PGN for {} (max analyze {})",
            games.len(),
            entry.source_username,
            max_games
        );

        if games.is_empty() {
            update_progress(
                &state.progress_state,
                &app,
                progress_id.clone(),
                player_base + player_weight,
                false,
            )?;
            continue;
        }

        let mut start_index = 0usize;
        let mut buckets: HashMap<String, MoveProfileBucket> = HashMap::new();
        let mut games_analyzed = 0u32;
        let mut positions_analyzed = 0u32;

        if !force_restart {
            if let Some(cp) = load_checkpoint(&root, &entry.id)? {
                if cp.max_games == max_games {
                    start_index = cp.game_index;
                    buckets = cp.buckets;
                    games_analyzed = cp.games_analyzed;
                    positions_analyzed = cp.positions_analyzed;
                    if start_index > 0 {
                        players_resumed += 1;
                        info!(
                            "Resuming {} at game {}/{} ({} positions so far)",
                            entry.source_username,
                            start_index,
                            games.len().min(max_games as usize),
                            positions_analyzed
                        );
                    }
                } else {
                    delete_checkpoint(&root, &entry.id);
                }
            }
        }

        let entry_id = entry.id.clone();
        let entry_clone = entry.clone();
        let games_limit = games.len().min(max_games as usize);

        let (new_buckets, new_games, new_positions) = analyze_player_games(
            &mut engine,
            &entry_clone,
            &games,
            max_games,
            start_index,
            buckets,
            games_analyzed,
            positions_analyzed,
            |game_frac| {
                let p = player_base + player_weight * game_frac;
                let _ = update_progress(
                    &state.progress_state,
                    &app,
                    progress_id.clone(),
                    p,
                    false,
                );
            },
            |game_idx, b, g, pos| {
                let _ = save_checkpoint(
                    &root,
                    &entry_id,
                    &ProfileBuildCheckpoint {
                        game_index: game_idx,
                        max_games,
                        buckets: b.clone(),
                        games_analyzed: g,
                        positions_analyzed: pos,
                    },
                );
            },
        )
        .await?;

        buckets = new_buckets;
        games_analyzed = new_games;
        positions_analyzed = new_positions;
        total_positions_analyzed += positions_analyzed;

        finalize_buckets(&mut buckets);
        let profile = ChesscomBotProfile {
            id: entry.id.clone(),
            target_elo: entry.target_elo,
            source_username: entry.source_username.clone(),
            bot_username: entry.bot_username.clone(),
            moves: buckets,
            games_analyzed,
            positions_analyzed,
        };

        let complete = positions_analyzed > 0 && games_limit > 0 && games_analyzed >= 1;
        let path = profile_path(&root, &entry.id);
        let json = serde_json::to_string_pretty(&profile)
            .map_err(|e| Error::Io(Box::new(std::io::Error::other(e.to_string()))))?;
        fs::write(&path, json)?;
        profiles.push(profile.clone());
        players_built += 1;

        if complete {
            delete_checkpoint(&root, &entry.id);
        }

        if let Some(slot) = manifest.bots.iter_mut().find(|b| b.id == entry.id) {
            slot.profile_complete = complete;
        }

        let _ = crate::engine_games::register_encroissant_engine_player(
            app.clone(),
            entry.bot_username.clone(),
        )
        .await;

        update_progress(
            &state.progress_state,
            &app,
            progress_id.clone(),
            player_base + player_weight,
            false,
        )?;
    }

    save_manifest(&root, &manifest)?;
    update_progress(&state.progress_state, &app, progress_id, 100.0, true)?;
    Ok(BuildChesscomBotProfilesResult {
        profiles,
        players_built,
        players_skipped_complete,
        players_resumed,
        total_positions_analyzed,
    })
}
