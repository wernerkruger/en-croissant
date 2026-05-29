//! Chess.com style bots: download rapid games, build move-choice profiles, play by profile.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use log::{info, warn};
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
const DEFAULT_MAX_GAMES: u32 = 150;
/// Depth when labeling human moves during profile build (full-strength engine).
const ANALYSIS_DEPTH_BUILD: u32 = 22;
/// Depth when the style bot chooses among engine lines during play.
pub const ANALYSIS_DEPTH_PLAY: u32 = 20;
const MULTIPV: u16 = 8;
const RATING_BUCKET_HALF: i32 = 75;
/// Profiles with fewer positions than this are rebuilt even if marked complete.
const MIN_POSITIONS_FOR_COMPLETE: u32 = 80;
/// Profile schema: position-keyed buckets + off-book human moves.
pub const PROFILE_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChesscomUserEntry {
    pub target_elo: i32,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MoveProfileBucket {
    /// Fraction at engine rank 1..[`MULTIPV`] (index 0 = best). Last slot = off-book human move.
    pub rank_rates: Vec<f64>,
    /// Human moves that were not in the engine top-[`MULTIPV`] (UCI -> count).
    #[serde(default)]
    pub off_book_moves: HashMap<String, u32>,
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
    #[serde(default = "default_profile_version")]
    pub profile_version: u32,
}

fn default_profile_version() -> u32 {
    PROFILE_VERSION
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
    /// In-bucket games already processed toward `max_games`.
    #[serde(default)]
    matching_games_processed: u32,
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

/// Parse `StyleBot_<elo>_<source>` usernames (see [`bot_username`]).
pub fn parse_style_bot_elo_from_name(name: &str) -> Option<i32> {
    let name = name.trim();
    let rest = name.strip_prefix("StyleBot_")?;
    let (elo_part, _) = rest.split_once('_')?;
    let elo: i32 = elo_part.parse().ok()?;
    if !(500..=5000).contains(&elo) {
        return None;
    }
    Some(elo)
}

fn profile_id(target_elo: i32, source: &str) -> String {
    format!("{}_{}", target_elo, source.to_lowercase())
}

fn rating_in_bucket(player_elo: i32, target_elo: i32) -> bool {
    (player_elo - target_elo).abs() <= RATING_BUCKET_HALF
}

fn game_player_elo(game: &ParsedGame, username: &str) -> Option<i32> {
    let user_lower = username.to_lowercase();
    if game.white.eq_ignore_ascii_case(&user_lower) {
        game.white_elo
    } else if game.black.eq_ignore_ascii_case(&user_lower) {
        game.black_elo
    } else {
        None
    }
}

fn game_matches_rating_bucket(game: &ParsedGame, username: &str, target_elo: i32) -> bool {
    game_player_elo(game, username)
        .is_some_and(|elo| rating_in_bucket(elo, target_elo))
}

fn count_games_in_rating_bucket(games: &[ParsedGame], username: &str, target_elo: i32) -> u32 {
    games
        .iter()
        .filter(|g| game_matches_rating_bucket(g, username, target_elo))
        .count() as u32
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
            if !matches!(time_class, "rapid" | "blitz") {
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
    start_fen: String,
    moves_uci: Vec<String>,
}

struct GameParser {
    white: String,
    black: String,
    white_elo: Option<i32>,
    black_elo: Option<i32>,
    position: Chess,
    start_fen: String,
    moves_uci: Vec<String>,
    skip: bool,
}

fn default_start_fen() -> String {
    Fen::from_position(Chess::default(), EnPassantMode::Legal).to_string()
}

fn apply_uci_move(pos: &mut Chess, uci: &str) -> Result<(), Error> {
    let uci_move = UciMove::from_ascii(uci.as_bytes())?;
    let mv = uci_move.to_move(pos)?;
    pos.play_unchecked(&mv);
    Ok(())
}

impl GameParser {
    fn new() -> Self {
        Self {
            white: String::new(),
            black: String::new(),
            white_elo: None,
            black_elo: None,
            position: Chess::default(),
            start_fen: default_start_fen(),
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
                        self.start_fen =
                            Fen::from_position(self.position.clone(), EnPassantMode::Legal)
                                .to_string();
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
        if self.moves_uci.is_empty() {
            self.start_fen =
                Fen::from_position(self.position.clone(), EnPassantMode::Legal).to_string();
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
            start_fen: visitor.start_fen.clone(),
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
    mut matching_games_processed: u32,
    mut buckets: HashMap<String, MoveProfileBucket>,
    mut games_analyzed: u32,
    mut positions_analyzed: u32,
    progress: F,
    mut on_game_done: G,
) -> Result<(HashMap<String, MoveProfileBucket>, u32, u32), Error>
where
    F: Fn(f32, u32, u32),
    G: FnMut(usize, u32, &HashMap<String, MoveProfileBucket>, u32, u32),
{
    let user_lower = entry.source_username.to_lowercase();
    let max = max_games as usize;
    let in_bucket_total =
        count_games_in_rating_bucket(games, &entry.source_username, entry.target_elo);
    let target_use = max.min(in_bucket_total as usize);
    let target_total = target_use.max(1) as u32;

    info!(
        "Selecting up to {} in-bucket games for {} ({}±{}); {} of {} parsed games match",
        max,
        entry.source_username,
        entry.target_elo,
        RATING_BUCKET_HALF,
        in_bucket_total,
        games.len()
    );

    progress(
        matching_games_processed as f32 / target_total as f32,
        matching_games_processed,
        target_total,
    );

    let mut games_skipped_rating = 0u32;

    for (game_idx, game) in games.iter().enumerate().skip(start_game_index) {
        if matching_games_processed as usize >= max {
            break;
        }

        if !game_matches_rating_bucket(game, &entry.source_username, entry.target_elo) {
            if game_player_elo(game, &entry.source_username).is_some() {
                games_skipped_rating += 1;
            }
            on_game_done(
                game_idx + 1,
                matching_games_processed,
                &buckets,
                games_analyzed,
                positions_analyzed,
            );
            continue;
        }

        matching_games_processed += 1;
        progress(
            matching_games_processed as f32 / target_total as f32,
            matching_games_processed,
            target_total,
        );
        let is_white = game.white.eq_ignore_ascii_case(&user_lower);

        let Ok(mut pos) = crate::engine::parse_fen_to_position(&game.start_fen) else {
            warn!(
                "Skipping in-bucket game {} for {} — invalid start FEN",
                game_idx + 1,
                entry.source_username
            );
            on_game_done(
                game_idx + 1,
                matching_games_processed,
                &buckets,
                games_analyzed,
                positions_analyzed,
            );
            continue;
        };
        let mut prefix: Vec<String> = Vec::new();
        let mut game_positions = 0u32;

        for (ply, played) in game.moves_uci.iter().enumerate() {
            let is_player_turn = (is_white && ply % 2 == 0) || (!is_white && ply % 2 == 1);
            if is_player_turn {
                let pos_key = position_key_from_chess(&pos);
                // UCI `position` expects the game-start FEN plus moves from that position,
                // not the current FEN with the same move list (that double-applies moves).
                match engine_top_moves(engine, &game.start_fen, &prefix, ANALYSIS_DEPTH_BUILD).await {
                    Ok(tops) if !tops.is_empty() => {
                        let rank = move_rank(played, &tops);
                        add_observation(&mut buckets, &pos_key, played, rank);
                        positions_analyzed += 1;
                        game_positions += 1;
                    }
                    Ok(_) => {}
                    Err(e) => {
                        warn!(
                            "Stopping game {} for {} at ply {} — engine position error: {}",
                            game_idx + 1,
                            entry.source_username,
                            ply + 1,
                            e
                        );
                        break;
                    }
                }
            }

            if apply_uci_move(&mut pos, played).is_err() {
                warn!(
                    "Stopping game {} for {} at ply {} — illegal move {}",
                    game_idx + 1,
                    entry.source_username,
                    ply + 1,
                    played
                );
                break;
            }
            prefix.push(played.clone());
        }

        if game_positions > 0 {
            games_analyzed += 1;
        }

        on_game_done(
            game_idx + 1,
            matching_games_processed,
            &buckets,
            games_analyzed,
            positions_analyzed,
        );
    }

    info!(
        "Analyzed {} in-bucket games for {} (used {} of {} requested; {} parsed games outside {}±{} while scanning)",
        games_analyzed,
        entry.source_username,
        matching_games_processed.min(max_games),
        max_games,
        games_skipped_rating,
        entry.target_elo,
        RATING_BUCKET_HALF
    );

    Ok((buckets, games_analyzed, positions_analyzed))
}

/// Normalized FEN key (placement, side, castling, ep) for position-specific profiles.
pub fn position_key_from_fen(fen: &str) -> String {
    let parts: Vec<&str> = fen.split_whitespace().take(4).collect();
    if parts.len() >= 4 {
        format!("p|{}", parts.join(" "))
    } else {
        format!("p|{}", fen.trim())
    }
}

pub fn position_key_from_chess(pos: &Chess) -> String {
    position_key_from_fen(&Fen::from_position(pos.clone(), EnPassantMode::Legal).to_string())
}

fn empty_bucket() -> MoveProfileBucket {
    MoveProfileBucket {
        rank_rates: vec![0.0; MULTIPV as usize + 1],
        off_book_moves: HashMap::new(),
        total: 0,
    }
}

fn off_book_slot_index() -> usize {
    MULTIPV as usize
}

pub fn profile_meets_v2_requirements(profile: &ChesscomBotProfile) -> bool {
    profile.profile_version >= PROFILE_VERSION
        && profile.moves.keys().any(|k| k.starts_with("p|"))
}

/// Limit engine strength to the bot's target rating before searching lines.
pub async fn configure_style_bot_engine(
    engine: &mut BaseEngine,
    target_elo: i32,
) -> Result<(), Error> {
    let elo = target_elo.clamp(500, 2850);
    engine.set_option("UCI_LimitStrength", "true").await?;
    engine.set_option("UCI_Elo", elo).await?;
    engine.set_option("MultiPV", MULTIPV).await?;
    Ok(())
}

pub async fn engine_top_moves(
    engine: &mut BaseEngine,
    fen: &str,
    moves: &[String],
    depth: u32,
) -> Result<Vec<String>, Error> {
    engine.set_option("MultiPV", MULTIPV).await?;
    engine.set_position(fen, moves).await?;
    engine.go(&GoMode::Depth(depth)).await?;

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
    position_key: &str,
    played_uci: &str,
    rank: usize,
) {
    let bucket = buckets
        .entry(position_key.to_string())
        .or_insert_with(empty_bucket);
    let off_slot = off_book_slot_index();
    if rank <= MULTIPV as usize {
        while bucket.rank_rates.len() <= rank {
            bucket.rank_rates.push(0.0);
        }
        bucket.rank_rates[rank - 1] += 1.0;
    } else {
        while bucket.rank_rates.len() <= off_slot {
            bucket.rank_rates.push(0.0);
        }
        bucket.rank_rates[off_slot] += 1.0;
        let uci = played_uci.to_ascii_lowercase();
        *bucket.off_book_moves.entry(uci).or_insert(0) += 1;
    }
    bucket.total += 1;
}

fn finalize_buckets(buckets: &mut HashMap<String, MoveProfileBucket>) {
    for bucket in buckets.values_mut() {
        if bucket.total == 0 {
            continue;
        }
        let target_len = MULTIPV as usize + 1;
        if bucket.rank_rates.len() < target_len {
            bucket.rank_rates.resize(target_len, 0.0);
        }
        let sum: f64 = bucket.rank_rates.iter().sum();
        if sum > 0.0 {
            for r in &mut bucket.rank_rates {
                *r /= sum;
            }
        }
    }
}

fn bucket_lookup<'a>(
    profile: &'a ChesscomBotProfile,
    position_key: &str,
    move_number: u32,
) -> Option<&'a MoveProfileBucket> {
    profile
        .moves
        .get(position_key)
        .or_else(|| profile.moves.get(&move_number.to_string()))
        .or_else(|| profile.moves.get(&format!("mv|{move_number}")))
        .or_else(|| profile.moves.values().max_by_key(|b| b.total))
}

fn pick_off_book_move(off_book: &HashMap<String, u32>, legal_moves: &[String]) -> Option<String> {
    let candidates: Vec<(String, u32)> = off_book
        .iter()
        .filter_map(|(uci, weight)| {
            legal_moves
                .iter()
                .find(|l| l.eq_ignore_ascii_case(uci))
                .map(|l| (l.clone(), *weight))
        })
        .collect();
    if candidates.is_empty() {
        return None;
    }
    let total: u32 = candidates.iter().map(|(_, w)| w).sum();
    if total == 0 {
        return candidates.first().map(|(u, _)| u.clone());
    }
    let mut roll = rand::thread_rng().gen_range(0..total);
    for (uci, weight) in &candidates {
        if roll < *weight {
            return Some(uci.clone());
        }
        roll -= weight;
    }
    candidates.last().map(|(u, _)| u.clone())
}

pub fn pick_move_from_profile(
    profile: &ChesscomBotProfile,
    position_key: &str,
    move_number: u32,
    engine_lines: &[String],
    legal_moves: &[String],
) -> String {
    if engine_lines.is_empty() {
        return String::new();
    }
    let bucket = bucket_lookup(profile, position_key, move_number);
    let off_slot = off_book_slot_index();

    let chosen_idx = if let Some(b) = bucket {
        if b.rank_rates.is_empty() || b.total == 0 {
            0usize
        } else {
            let mut rng = rand::thread_rng();
            let roll: f64 = rng.gen();
            let mut acc = 0.0;
            let mut chosen = 0usize;
            for (i, rate) in b.rank_rates.iter().enumerate() {
                acc += rate;
                if roll <= acc {
                    chosen = i;
                    break;
                }
            }
            chosen
        }
    } else {
        0usize
    };

    if chosen_idx == off_slot {
        if let Some(b) = bucket {
            if let Some(m) = pick_off_book_move(&b.off_book_moves, legal_moves) {
                return m;
            }
        }
        return engine_lines[0].clone();
    }

    let rank = (chosen_idx + 1).min(engine_lines.len());
    engine_lines
        .get(rank - 1)
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
            Some(format!(
                "Downloading {} (player {} of {})",
                entry.username,
                i + 1,
                entries.len()
            )),
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
                let _ = update_progress(
                    &state.progress_state,
                    &app,
                    progress_id.clone(),
                    p,
                    false,
                    Some(format!("Downloading {} (player {} of {})", entry.username, i + 1, entries.len())),
                );
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
            None,
        )?;
    }

    manifest.bots.sort_by_key(|b| (b.target_elo, b.source_username.clone()));
    save_manifest(&root, &manifest)?;
    update_progress(&state.progress_state, &app, progress_id, 100.0, true, None)?;
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
    let player_total = bot_entries.len();
    for (i, entry) in bot_entries.iter().enumerate() {
        let player_base = (i as f32 / player_count) * 100.0;
        let player_weight = 100.0 / player_count;
        let player_no = i + 1;
        let progress_user = entry.source_username.clone();
        let build_progress_message = move |game_current: u32, game_max: u32| -> String {
            format!(
                "Player {player_no} of {player_total}: {progress_user} — game {game_current} of {game_max}"
            )
        };

        if entry.profile_complete && !force_restart {
            if let Ok(existing) = load_profile(&app, &entry.id) {
                if existing.positions_analyzed >= MIN_POSITIONS_FOR_COMPLETE
                    && profile_meets_v2_requirements(&existing)
                {
                    info!(
                        "Skipping profile build for {} — v{} profile complete ({} positions, {} games)",
                        entry.source_username,
                        existing.profile_version,
                        existing.positions_analyzed,
                        existing.games_analyzed
                    );
                    players_skipped_complete += 1;
                    profiles.push(existing);
                    update_progress(
                        &state.progress_state,
                        &app,
                        progress_id.clone(),
                        player_base + player_weight,
                        false,
                        Some(format!(
                            "Skipping {} (player {player_no} of {player_total}) — already complete",
                            entry.source_username
                        )),
                    )?;
                    continue;
                }
                if !profile_meets_v2_requirements(&existing) {
                    info!(
                        "Rebuilding {} — legacy profile (v{}), upgrading to v{}",
                        entry.source_username,
                        existing.profile_version,
                        PROFILE_VERSION
                    );
                } else {
                    info!(
                        "Rebuilding {} — marked complete but only {} positions (need {})",
                        entry.source_username,
                        existing.positions_analyzed,
                        MIN_POSITIONS_FOR_COMPLETE
                    );
                }
            }
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

        update_progress(
            &state.progress_state,
            &app,
            progress_id.clone(),
            player_base,
            false,
            Some(build_progress_message(0, max_games)),
        )?;

        if games.is_empty() {
            update_progress(
                &state.progress_state,
                &app,
                progress_id.clone(),
                player_base + player_weight,
                false,
                Some(format!("{} — no games in PGN", entry.source_username)),
            )?;
            continue;
        }

        let mut start_index = 0usize;
        let mut matching_games_processed = 0u32;
        let mut buckets: HashMap<String, MoveProfileBucket> = HashMap::new();
        let mut games_analyzed = 0u32;
        let mut positions_analyzed = 0u32;

        if !force_restart {
            if let Some(cp) = load_checkpoint(&root, &entry.id)? {
                if cp.max_games == max_games {
                    start_index = cp.game_index;
                    matching_games_processed = cp.matching_games_processed;
                    buckets = cp.buckets;
                    games_analyzed = cp.games_analyzed;
                    positions_analyzed = cp.positions_analyzed;
                    if start_index > 0 || matching_games_processed > 0 {
                        players_resumed += 1;
                        info!(
                            "Resuming {} — {} in-bucket games done, scan index {} ({} positions so far)",
                            entry.source_username,
                            matching_games_processed,
                            start_index,
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

        let (new_buckets, new_games, new_positions) = analyze_player_games(
            &mut engine,
            &entry_clone,
            &games,
            max_games,
            start_index,
            matching_games_processed,
            buckets,
            games_analyzed,
            positions_analyzed,
            |game_frac, game_current, game_max| {
                let p = player_base + player_weight * game_frac;
                let _ = update_progress(
                    &state.progress_state,
                    &app,
                    progress_id.clone(),
                    p,
                    false,
                    Some(build_progress_message(game_current, game_max)),
                );
            },
            |game_idx, matching_done, b, g, pos| {
                let _ = save_checkpoint(
                    &root,
                    &entry_id,
                    &ProfileBuildCheckpoint {
                        game_index: game_idx,
                        max_games,
                        matching_games_processed: matching_done,
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
            profile_version: PROFILE_VERSION,
        };

        let complete = positions_analyzed >= MIN_POSITIONS_FOR_COMPLETE;
        info!(
            "Finished profile for {} — {} games, {} positions analyzed{}",
            entry.source_username,
            games_analyzed,
            positions_analyzed,
            if complete { " (complete)" } else { " (incomplete — will resume)" }
        );
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
            Some(build_progress_message(max_games, max_games)),
        )?;
    }

    save_manifest(&root, &manifest)?;
    update_progress(
        &state.progress_state,
        &app,
        progress_id,
        100.0,
        true,
        Some("Profile build complete".to_string()),
    )?;
    Ok(BuildChesscomBotProfilesResult {
        profiles,
        players_built,
        players_skipped_complete,
        players_resumed,
        total_positions_analyzed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_style_bot_elo_from_username() {
        assert_eq!(
            parse_style_bot_elo_from_name("StyleBot_1660_emircan"),
            Some(1660)
        );
        assert_eq!(parse_style_bot_elo_from_name("Stockfish"), None);
    }

    #[test]
    fn position_key_uses_first_four_fen_fields() {
        let key = position_key_from_fen(
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
        );
        assert_eq!(
            key,
            "p|rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3"
        );
    }

    #[test]
    fn pick_move_can_play_off_book() {
        let mut off_book = HashMap::new();
        off_book.insert("e2e4".to_string(), 3);
        let bucket = MoveProfileBucket {
            rank_rates: vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
            off_book_moves: off_book,
            total: 1,
        };
        let mut moves = HashMap::new();
        moves.insert("p|fen".to_string(), bucket);
        let profile = ChesscomBotProfile {
            id: "t".into(),
            target_elo: 1600,
            source_username: "u".into(),
            bot_username: "StyleBot_1600_u".into(),
            moves,
            games_analyzed: 1,
            positions_analyzed: 1,
            profile_version: PROFILE_VERSION,
        };
        let legal = vec!["e2e4".to_string(), "d2d4".to_string()];
        let tops = vec!["d2d4".to_string()];
        let picked = pick_move_from_profile(&profile, "p|fen", 1, &tops, &legal);
        assert_eq!(picked, "e2e4");
    }
}
