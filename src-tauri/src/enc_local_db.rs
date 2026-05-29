//! Virtual database path [`ENC_LOCAL_DB_SENTINEL`] lists games from `EnCroissantEngineGames.db`.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use dashmap::DashMap;
use log::info;
use rusqlite::params;
use shakmaty::san::SanPlus;
use shakmaty::uci::UciMove;
use shakmaty::{Chess, Color, Position};
use tauri::AppHandle;
use tauri::Emitter;

use crate::db::game_matches_player_filters;
use crate::db::{
    convert_position_query, get_move_after_match_uci, GameResult, NormalizedGame, Outcome, Player,
    DatabaseInfo, GameOutcome, GameQuery, GameSort, PlayerGameInfo, PlayerQuery, PlayerSort,
    PositionQuery, PositionStats, ProgressPayload, QueryOptions, QueryResponse, SortDirection,
};
use crate::engine_games::{
    load_site_stats, local_engine_games_file_path, open_enc_games_connection,
    parse_stored_moves_json, san_movetext_with_clocks,
};
use crate::error::Error;
use crate::AppState;

pub const ENC_LOCAL_DB_SENTINEL: &str = "__encLocalPlayedGames__";
const ENGINE_SYNTHETIC_PLAYER_ID: i32 = -1000;
const HVH_GAME_ID_OFFSET: i32 = 1_000_000_000;
const STARTPOS_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

pub fn is_enc_local_sentinel(path: &Path) -> bool {
    path.to_str() == Some(ENC_LOCAL_DB_SENTINEL)
}

fn outcome_from_engine_row(result: i32, human_was_white: bool) -> Option<Outcome> {
    let hr = match result {
        0 => GameOutcome::Won,
        1 => GameOutcome::Drawn,
        2 => GameOutcome::Lost,
        _ => return None,
    };
    let s = match hr {
        GameOutcome::Won => {
            if human_was_white {
                "1-0"
            } else {
                "0-1"
            }
        }
        GameOutcome::Lost => {
            if human_was_white {
                "0-1"
            } else {
                "1-0"
            }
        }
        GameOutcome::Drawn => "1/2-1/2",
    };
    std::str::FromStr::from_str(s).ok()
}

fn pgn_result_token(o: &Outcome) -> &'static str {
    match o {
        Outcome::WhiteWin => "1-0",
        Outcome::BlackWin => "0-1",
        Outcome::Draw => "1/2-1/2",
        Outcome::Unknown => "*",
    }
}

fn san_movetext_and_ply(moves: &[String]) -> Option<(String, i32)> {
    let mut chess = Chess::default();
    let mut parts = Vec::new();
    let mut fullmove = 1;
    let mut side = Color::White;
    for uci in moves {
        let u = UciMove::from_ascii(uci.as_bytes()).ok()?;
        let m = u.to_move(&chess).ok()?;
        let san = SanPlus::from_move(chess.clone(), &m);
        if side == Color::White {
            parts.push(format!("{}. {}", fullmove, san));
        } else {
            parts.push(san.to_string());
            fullmove += 1;
        }
        chess.play_unchecked(&m);
        side = !side;
    }
    let ply = moves.len() as i32;
    Some((parts.join(" "), ply))
}

fn date_ok(date: &Option<String>, query: &GameQuery) -> bool {
    let Some(ds) = date else {
        return query.start_date.is_none() && query.end_date.is_none();
    };
    if let Some(ref start) = query.start_date {
        if ds.as_str() < start.as_str() {
            return false;
        }
    }
    if let Some(ref end) = query.end_date {
        if ds.as_str() > end.as_str() {
            return false;
        }
    }
    true
}

fn outcome_ok(result: &Outcome, query: &GameQuery) -> bool {
    let Some(ref want) = query.outcome else {
        return true;
    };
    pgn_result_token(result) == want.as_str()
}

fn synthetic_ids_engine(human_was_white: bool, human_pid: i32) -> (i32, i32) {
    if human_was_white {
        (human_pid, ENGINE_SYNTHETIC_PLAYER_ID)
    } else {
        (ENGINE_SYNTHETIC_PLAYER_ID, human_pid)
    }
}

fn build_name_to_id_map(conn: &rusqlite::Connection) -> Result<HashMap<String, i32>, Error> {
    let mut m = HashMap::new();
    let mut stmt = conn.prepare("SELECT id, username FROM engine_players ORDER BY id")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?))
    })?;
    for r in rows {
        let (id, name) = r?;
        m.insert(name.to_lowercase(), id);
    }
    let max_id: i32 = m.values().copied().max().unwrap_or(0);
    let mut next = max_id + 1;
    let mut stmt = conn.prepare(
        "SELECT DISTINCT white_name FROM human_vs_human_games
         UNION
         SELECT DISTINCT black_name FROM human_vs_human_games",
    )?;
    let names = stmt.query_map([], |row| row.get::<_, String>(0))?;
    for n in names {
        let name = n?;
        let key = name.to_lowercase();
        if !m.contains_key(&key) {
            m.insert(key, next);
            next += 1;
        }
    }
    Ok(m)
}

/// Best current rating across time-control buckets (from `engine_ratings`).
fn player_display_elo(conn: &rusqlite::Connection, player_id: i32) -> Option<i32> {
    if player_id <= 0 || player_id == ENGINE_SYNTHETIC_PLAYER_ID {
        return None;
    }
    conn.query_row(
        "SELECT MAX(rating) FROM engine_ratings WHERE player_id = ?1",
        params![player_id],
        |row| row.get(0),
    )
    .ok()
}

fn roster_players(conn: &rusqlite::Connection) -> Result<Vec<Player>, Error> {
    let eng_n: i32 = conn.query_row("SELECT COUNT(*) FROM engine_games", [], |r| r.get(0))?;
    let mut out: Vec<Player> = Vec::new();
    if eng_n > 0 {
        out.push(Player {
            id: ENGINE_SYNTHETIC_PLAYER_ID,
            name: Some("Engine".into()),
            elo: None,
        });
    }
    let mut stmt = conn.prepare("SELECT id, username FROM engine_players ORDER BY id ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?))
    })?;
    for r in rows {
        let (id, name) = r?;
        out.push(Player {
            id,
            name: Some(name),
            elo: player_display_elo(conn, id),
        });
    }
    let map = build_name_to_id_map(conn)?;
    let mut seen: HashSet<i32> = out.iter().map(|p| p.id).collect();
    let mut stmt = conn.prepare(
        "SELECT DISTINCT white_name FROM human_vs_human_games
         UNION
         SELECT DISTINCT black_name FROM human_vs_human_games
         ORDER BY 1 COLLATE NOCASE",
    )?;
    let names = stmt.query_map([], |row| row.get::<_, String>(0))?;
    for n in names {
        let name = n?;
        let id = *map.get(&name.to_lowercase()).unwrap_or(&0);
        if id > 0 && !seen.contains(&id) {
            seen.insert(id);
            out.push(Player {
                id,
                name: Some(name),
                elo: None,
            });
        }
    }
    Ok(out)
}

fn load_engine_games(conn: &rusqlite::Connection) -> Result<Vec<NormalizedGame>, Error> {
    let mut stmt = conn.prepare(
        "SELECT g.id, g.human_was_white, g.player_elo_before, g.opponent_elo, g.rated, g.result, \
         g.time_control, g.date, g.opening, g.moves_uci_json, p.username, g.opponent_name \
         FROM engine_games g \
         JOIN engine_players p ON g.player_id = p.id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i32>(0)?,
            row.get::<_, i32>(1)?,
            row.get::<_, i32>(2)?,
            row.get::<_, Option<i32>>(3)?,
            row.get::<_, i32>(4)?,
            row.get::<_, i32>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, String>(9)?,
            row.get::<_, String>(10)?,
            row.get::<_, Option<String>>(11)?,
        ))
    })?;
    let mut list = Vec::new();
    for r in rows {
        let (
            gid,
            human_was_white,
            player_elo_before,
            opponent_elo,
            rated,
            result,
            time_control,
            date,
            opening,
            moves_json,
            username,
            opponent_name,
        ) = r?;
        let hw = human_was_white != 0;
        let Some(outcome) = outcome_from_engine_row(result, hw) else {
            continue;
        };
        let stored_moves = parse_stored_moves_json(&moves_json);
        let (movetext, ply_count) = if stored_moves.is_empty() {
            (String::new(), 0)
        } else {
            san_movetext_with_clocks(&stored_moves)
                .unwrap_or((String::new(), stored_moves.len() as i32))
        };
        let result_tok = pgn_result_token(&outcome);
        let moves = if movetext.is_empty() {
            result_tok.to_string()
        } else {
            format!("{movetext} {result_tok}")
        };
        let opponent_label = opponent_name
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Engine".to_string());
        let opponent_elo = opponent_elo.or_else(|| {
            crate::chesscom_bots::parse_style_bot_elo_from_name(&opponent_label)
        });
        let (white, black) = if hw {
            (username.clone(), opponent_label)
        } else {
            (opponent_label, username.clone())
        };
        let (white_elo, black_elo) = if hw {
            (Some(player_elo_before), opponent_elo)
        } else {
            (opponent_elo, Some(player_elo_before))
        };
        let human_pid: i32 = conn.query_row(
            "SELECT id FROM engine_players WHERE username = ?1 COLLATE NOCASE",
            params![username],
            |row| row.get(0),
        )?;
        let (white_id, black_id) = synthetic_ids_engine(hw, human_pid);
        let event = if rated != 0 {
            "Rated vs engine"
        } else {
            "Casual vs engine"
        };
        list.push(NormalizedGame {
            id: gid,
            fen: STARTPOS_FEN.to_string(),
            event: event.into(),
            event_id: 1,
            site: "En Croissant".into(),
            site_id: 1,
            date: Some(date),
            time: None,
            round: None,
            white,
            white_id,
            white_elo,
            black,
            black_id,
            black_elo,
            result: outcome,
            time_control: Some(time_control),
            eco: if opening.is_empty() {
                None
            } else {
                Some(opening)
            },
            ply_count: Some(ply_count),
            moves,
        });
    }
    Ok(list)
}

fn load_hvh_games(conn: &rusqlite::Connection) -> Result<Vec<NormalizedGame>, Error> {
    let map = build_name_to_id_map(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, white_name, black_name, result_pgn, time_control, date, opening, moves_uci_json \
         FROM human_vs_human_games",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i32>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
        ))
    })?;
    let mut list = Vec::new();
    for r in rows {
        let (hid, wn, bn, pgn, tc, date, opening, mj) = r?;
        let Ok(outcome) = std::str::FromStr::from_str(&pgn) else {
            continue;
        };
        let stored_moves = parse_stored_moves_json(&mj);
        let (movetext, ply_count) = if stored_moves.is_empty() {
            (String::new(), 0)
        } else {
            san_movetext_with_clocks(&stored_moves)
                .unwrap_or((String::new(), stored_moves.len() as i32))
        };
        let result_tok = pgn_result_token(&outcome);
        let moves = if movetext.is_empty() {
            result_tok.to_string()
        } else {
            format!("{movetext} {result_tok}")
        };
        let wid = *map.get(&wn.to_lowercase()).unwrap_or(&0);
        let bid = *map.get(&bn.to_lowercase()).unwrap_or(&0);
        list.push(NormalizedGame {
            id: HVH_GAME_ID_OFFSET + hid,
            fen: STARTPOS_FEN.to_string(),
            event: "Local game".into(),
            event_id: 1,
            site: "En Croissant".into(),
            site_id: 1,
            date: Some(date),
            time: None,
            round: None,
            white: wn.clone(),
            white_id: wid,
            white_elo: None,
            black: bn.clone(),
            black_id: bid,
            black_elo: None,
            result: outcome,
            time_control: Some(tc),
            eco: if opening.is_empty() {
                None
            } else {
                Some(opening)
            },
            ply_count: Some(ply_count),
            moves,
        });
    }
    Ok(list)
}

fn filter_enc_games(mut games: Vec<NormalizedGame>, query: &GameQuery) -> Vec<NormalizedGame> {
    if query.tournament_id.is_some() || query.position.is_some() {
        return vec![];
    }
    games.retain(|g| date_ok(&g.date, query) && outcome_ok(&g.result, query));
    games.retain(|g| {
        game_matches_player_filters(g.white_id, g.black_id, query)
    });
    games
}

fn sort_enc_games(games: &mut [NormalizedGame], opts: &QueryOptions<GameSort>) {
    let cmp_id = |a: &NormalizedGame, b: &NormalizedGame| a.id.cmp(&b.id);
    let cmp_date = |a: &NormalizedGame, b: &NormalizedGame| {
        let da = a.date.as_deref().unwrap_or("");
        let db = b.date.as_deref().unwrap_or("");
        da.cmp(db)
    };
    let cmp_we = |a: &NormalizedGame, b: &NormalizedGame| {
        a.white_elo.unwrap_or(0).cmp(&b.white_elo.unwrap_or(0))
    };
    let cmp_be = |a: &NormalizedGame, b: &NormalizedGame| {
        a.black_elo.unwrap_or(0).cmp(&b.black_elo.unwrap_or(0))
    };
    let cmp_ply = |a: &NormalizedGame, b: &NormalizedGame| {
        a.ply_count.unwrap_or(0).cmp(&b.ply_count.unwrap_or(0))
    };
    match opts.sort {
        GameSort::Id => match opts.direction {
            SortDirection::Asc => games.sort_by(|a, b| cmp_id(a, b)),
            SortDirection::Desc => games.sort_by(|a, b| cmp_id(b, a)),
        },
        GameSort::Date => match opts.direction {
            SortDirection::Asc => games.sort_by(|a, b| cmp_date(a, b)),
            SortDirection::Desc => games.sort_by(|a, b| cmp_date(b, a)),
        },
        GameSort::WhiteElo => match opts.direction {
            SortDirection::Asc => games.sort_by(|a, b| cmp_we(a, b)),
            SortDirection::Desc => games.sort_by(|a, b| cmp_we(b, a)),
        },
        GameSort::BlackElo => match opts.direction {
            SortDirection::Asc => games.sort_by(|a, b| cmp_be(a, b)),
            SortDirection::Desc => games.sort_by(|a, b| cmp_be(b, a)),
        },
        GameSort::PlyCount => match opts.direction {
            SortDirection::Asc => games.sort_by(|a, b| cmp_ply(a, b)),
            SortDirection::Desc => games.sort_by(|a, b| cmp_ply(b, a)),
        },
    }
}

pub fn enc_local_database_info(app: &AppHandle) -> Result<DatabaseInfo, Error> {
    let conn = open_enc_games_connection(app)?;
    let eng_count: i32 = conn.query_row("SELECT COUNT(*) FROM engine_games", [], |r| r.get(0))?;
    let hvh_count: i32 =
        conn.query_row("SELECT COUNT(*) FROM human_vs_human_games", [], |r| r.get(0))?;
    let game_count = eng_count + hvh_count;
    let mut names = HashSet::new();
    let mut stmt = conn.prepare("SELECT username FROM engine_players")?;
    for n in stmt.query_map([], |r| r.get::<_, String>(0))? {
        names.insert(n?.to_lowercase());
    }
    let mut stmt = conn.prepare("SELECT white_name, black_name FROM human_vs_human_games")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (w, b) = row?;
        names.insert(w.to_lowercase());
        names.insert(b.to_lowercase());
    }
    let mut player_count = names.len() as i32;
    if eng_count > 0 {
        player_count += 1;
    }
    let path = local_engine_games_file_path(app)?;
    let storage_size = if path.exists() {
        path.metadata()?.len()
    } else {
        0
    };
    Ok(DatabaseInfo::enc_croissant_local(
        storage_size,
        game_count,
        player_count.max(0),
    ))
}

pub fn enc_local_get_games(app: &AppHandle, query: GameQuery) -> Result<QueryResponse<Vec<NormalizedGame>>, Error> {
    let conn = open_enc_games_connection(app)?;
    let mut eng = load_engine_games(&conn)?;
    let mut hvh = load_hvh_games(&conn)?;
    eng.append(&mut hvh);
    let filtered = filter_enc_games(eng, &query);
    let count = filtered.len() as i64;
    let opts = query.options.clone().unwrap_or_default();
    let mut sorted = filtered;
    sort_enc_games(&mut sorted, &opts);
    let page = opts.page.unwrap_or(1).max(1);
    let page_size = opts.page_size.unwrap_or(25).max(1);
    let start = ((page - 1) * page_size) as usize;
    let page_data: Vec<NormalizedGame> = sorted.into_iter().skip(start).take(page_size as usize).collect();
    let count_out = if opts.skip_count {
        None
    } else {
        Some(count as i32)
    };
    Ok(QueryResponse {
        data: page_data,
        count: count_out,
    })
}

pub fn enc_local_get_players(app: &AppHandle, query: PlayerQuery) -> Result<QueryResponse<Vec<Player>>, Error> {
    let conn = open_enc_games_connection(app)?;
    let mut players = roster_players(&conn)?;
    if let Some(ref name) = query.name {
        let n = name.to_lowercase();
        players.retain(|p| {
            p.name
                .as_ref()
                .map(|x| x.to_lowercase().contains(&n))
                .unwrap_or(false)
        });
    }
    if let Some((lo, hi)) = query.range {
        players.retain(|p| {
            p.elo
                .map(|e| e >= lo && e <= hi)
                .unwrap_or(false)
        });
    }
    let count = players.len() as i64;
    let opts = query.options;
    match opts.sort {
        PlayerSort::Id => match opts.direction {
            SortDirection::Asc => players.sort_by_key(|p| p.id),
            SortDirection::Desc => players.sort_by_key(|p| std::cmp::Reverse(p.id)),
        },
        PlayerSort::Name => match opts.direction {
            SortDirection::Asc => players.sort_by(|a, b| a.name.cmp(&b.name)),
            SortDirection::Desc => players.sort_by(|a, b| b.name.cmp(&a.name)),
        },
        PlayerSort::Elo => match opts.direction {
            SortDirection::Asc => players.sort_by_key(|p| p.elo.unwrap_or(0)),
            SortDirection::Desc => players.sort_by_key(|p| std::cmp::Reverse(p.elo.unwrap_or(0))),
        },
    }
    let page = opts.page.unwrap_or(1).max(1);
    let page_size = opts.page_size.unwrap_or(10).max(1);
    let start = ((page - 1) * page_size) as usize;
    let data: Vec<Player> = players.into_iter().skip(start).take(page_size as usize).collect();
    let count_out = if opts.skip_count {
        None
    } else {
        Some(count as i32)
    };
    Ok(QueryResponse { data, count: count_out })
}

pub fn enc_local_get_player(app: &AppHandle, id: i32) -> Result<Option<Player>, Error> {
    let conn = open_enc_games_connection(app)?;
    let players = roster_players(&conn)?;
    Ok(players.into_iter().find(|p| p.id == id))
}

pub fn enc_local_get_players_game_info(app: &AppHandle, id: i32) -> Result<PlayerGameInfo, Error> {
    if id == ENGINE_SYNTHETIC_PLAYER_ID {
        return Ok(PlayerGameInfo::default());
    }
    let conn = open_enc_games_connection(app)?;
    let players = roster_players(&conn)?;
    let Some(player) = players.into_iter().find(|p| p.id == id) else {
        return Ok(PlayerGameInfo::default());
    };
    let name = player.name.as_deref().unwrap_or("").trim();
    if name.is_empty() {
        return Ok(PlayerGameInfo::default());
    }
    let mut info = PlayerGameInfo::default();
    if let Some(stats) = load_site_stats(app, name)? {
        info.site_stats_data.push(stats);
    }
    Ok(info)
}

struct EncPositionSearchRow {
    id: i32,
    white_id: i32,
    black_id: i32,
    white_elo: i16,
    black_elo: i16,
    date: Option<String>,
    result: GameResult,
    moves_uci: Vec<String>,
}

fn outcome_to_game_result_search(o: &Outcome) -> GameResult {
    match o {
        Outcome::WhiteWin => GameResult::WhiteWin,
        Outcome::BlackWin => GameResult::BlackWin,
        Outcome::Draw => GameResult::Draw,
        Outcome::Unknown => GameResult::Other,
    }
}

fn enc_wanted_result_ok(result: GameResult, query: &GameQuery) -> bool {
    let wanted = query.wanted_result.as_ref().and_then(|r| match r.as_str() {
        "whitewon" => Some(GameResult::WhiteWin),
        "blackwon" => Some(GameResult::BlackWin),
        "draw" => Some(GameResult::Draw),
        _ => None,
    });
    match wanted {
        None => true,
        Some(w) => result == w,
    }
}

fn load_enc_position_search_rows(conn: &rusqlite::Connection) -> Result<Vec<EncPositionSearchRow>, Error> {
    let mut out = Vec::new();

    let mut stmt = conn.prepare(
        "SELECT g.id, g.human_was_white, g.player_elo_before, g.opponent_elo, g.result, \
         g.date, g.moves_uci_json, p.username \
         FROM engine_games g \
         JOIN engine_players p ON g.player_id = p.id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i32>(0)?,
            row.get::<_, i32>(1)?,
            row.get::<_, i32>(2)?,
            row.get::<_, Option<i32>>(3)?,
            row.get::<_, i32>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
        ))
    })?;
    for r in rows {
        let (
            gid,
            human_was_white,
            player_elo_before,
            opponent_elo,
            result,
            date,
            moves_json,
            username,
        ) = r?;
        let hw = human_was_white != 0;
        let Some(outcome) = outcome_from_engine_row(result, hw) else {
            continue;
        };
        let moves_uci: Vec<String> = parse_stored_moves_json(&moves_json)
            .into_iter()
            .map(|m| m.uci)
            .collect();
        if moves_uci.is_empty() {
            continue;
        }
        let gr = outcome_to_game_result_search(&outcome);
        let human_pid: i32 = conn.query_row(
            "SELECT id FROM engine_players WHERE username = ?1 COLLATE NOCASE",
            params![username],
            |row| row.get(0),
        )?;
        let (white_id, black_id) = synthetic_ids_engine(hw, human_pid);
        let (we, be) = if hw {
            (player_elo_before as i16, opponent_elo.unwrap_or(0) as i16)
        } else {
            (opponent_elo.unwrap_or(0) as i16, player_elo_before as i16)
        };
        out.push(EncPositionSearchRow {
            id: gid,
            white_id,
            black_id,
            white_elo: we,
            black_elo: be,
            date: Some(date),
            result: gr,
            moves_uci,
        });
    }

    let map = build_name_to_id_map(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, white_name, black_name, result_pgn, date, moves_uci_json \
         FROM human_vs_human_games",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i32>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    for r in rows {
        let (hid, wn, bn, pgn, date, mj) = r?;
        let Ok(outcome) = std::str::FromStr::from_str(&pgn) else {
            continue;
        };
        let moves_uci: Vec<String> = parse_stored_moves_json(&mj)
            .into_iter()
            .map(|m| m.uci)
            .collect();
        if moves_uci.is_empty() {
            continue;
        }
        let gr = outcome_to_game_result_search(&outcome);
        let wid = *map.get(&wn.to_lowercase()).unwrap_or(&0);
        let bid = *map.get(&bn.to_lowercase()).unwrap_or(&0);
        out.push(EncPositionSearchRow {
            id: HVH_GAME_ID_OFFSET + hid,
            white_id: wid,
            black_id: bid,
            white_elo: 0,
            black_elo: 0,
            date: Some(date),
            result: gr,
            moves_uci,
        });
    }

    Ok(out)
}

fn enc_push_elo_sample(heap: &mut BinaryHeap<Reverse<(i16, i32)>>, elo: i16, id: i32, cap: usize) {
    if heap.len() < cap {
        heap.push(Reverse((elo, id)));
    } else if let Some(&Reverse((min_elo, _))) = heap.peek() {
        if elo > min_elo {
            heap.pop();
            heap.push(Reverse((elo, id)));
        }
    }
}

fn enc_push_recent_date_sample(
    heap: &mut BinaryHeap<Reverse<(String, i32)>>,
    date: &str,
    id: i32,
    cap: usize,
) {
    if heap.len() < cap {
        heap.push(Reverse((date.to_string(), id)));
    } else if let Some(Reverse((min_date, _))) = heap.peek() {
        if date > min_date.as_str() {
            heap.pop();
            heap.push(Reverse((date.to_string(), id)));
        }
    }
}

pub async fn search_position_enc_local(
    app: AppHandle,
    query: GameQuery,
    tab_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(Vec<PositionStats>, Vec<NormalizedGame>), Error> {
    let file = PathBuf::from(ENC_LOCAL_DB_SENTINEL);

    let collision_lock = {
        let entry = state
            .search_collisions
            .entry((query.clone(), file.clone()))
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())));
        entry.value().clone()
    };

    let _guard = collision_lock.lock().await;

    if let Some(pos) = state.line_cache.get(&(query.clone(), file.clone())) {
        return Ok(pos.clone());
    }

    let parsed_position_query: Option<PositionQuery> = match &query.position {
        Some(pq) => Some(convert_position_query(pq.clone())?),
        None => None,
    };

    let Some(ref pq) = parsed_position_query else {
        return Ok((vec![], vec![]));
    };

    let start = Instant::now();
    info!("enc local: start position search");

    let permit = state.new_request.acquire().await.unwrap();

    let conn = open_enc_games_connection(&app)?;
    let rows = load_enc_position_search_rows(&conn)?;
    let game_count = rows.len().max(1);

    const MAX_SAMPLES_ELO: usize = 500;
    const MAX_SAMPLES_RECENT: usize = 500;
    let openings: DashMap<String, PositionStats> = DashMap::new();
    let top_by_elo: Mutex<BinaryHeap<Reverse<(i16, i32)>>> =
        Mutex::new(BinaryHeap::with_capacity(MAX_SAMPLES_ELO + 1));
    let top_by_recent_date: Mutex<BinaryHeap<Reverse<(String, i32)>>> =
        Mutex::new(BinaryHeap::with_capacity(MAX_SAMPLES_RECENT + 1));

    for (idx, row) in rows.iter().enumerate() {
        if idx.is_multiple_of(500) && idx > 0 {
            let _ = app.emit(
                "search_progress",
                ProgressPayload {
                    progress: (idx as f64 / game_count as f64) * 100.0,
                    id: tab_id.clone(),
                    finished: false,
                },
            );
        }

        if !game_matches_player_filters(row.white_id, row.black_id, &query) {
            continue;
        }
        if !date_ok(&row.date, &query) {
            continue;
        }
        if !enc_wanted_result_ok(row.result, &query) {
            continue;
        }

        if let Some(m) = get_move_after_match_uci(&row.moves_uci, pq) {
            let elo_key = row.white_elo.max(row.black_elo);
            {
                let mut heap = top_by_elo.lock().unwrap();
                enc_push_elo_sample(&mut heap, elo_key, row.id, MAX_SAMPLES_ELO);
            }
            if let Some(ref d) = row.date {
                if !d.is_empty() && !d.contains('?') {
                    let mut heap = top_by_recent_date.lock().unwrap();
                    enc_push_recent_date_sample(&mut heap, d, row.id, MAX_SAMPLES_RECENT);
                }
            }

            let res = row.result;
            openings
                .entry(m)
                .and_modify(|opening| match res {
                    GameResult::WhiteWin => opening.white += 1,
                    GameResult::BlackWin => opening.black += 1,
                    GameResult::Draw | GameResult::None | GameResult::Other => opening.draw += 1,
                })
                .or_insert_with(|| PositionStats {
                    black: i32::from(res == GameResult::BlackWin),
                    white: i32::from(res == GameResult::WhiteWin),
                    draw: i32::from(matches!(
                        res,
                        GameResult::Draw | GameResult::None | GameResult::Other
                    )),
                    move_: String::new(),
                });
        }
    }

    let openings_vec: Vec<PositionStats> = openings
        .into_iter()
        .map(|(k, mut v)| {
            v.move_ = k;
            v
        })
        .collect();
    let mut id_set: HashSet<i32> = HashSet::new();
    for Reverse((_, id)) in top_by_elo.into_inner().unwrap() {
        id_set.insert(id);
    }
    for Reverse((_, id)) in top_by_recent_date.into_inner().unwrap() {
        id_set.insert(id);
    }

    let _ = app.emit(
        "search_progress",
        ProgressPayload {
            progress: 100.0,
            id: tab_id.clone(),
            finished: true,
        },
    );

    info!("enc local: finished search in {:?}", start.elapsed());

    let mut eng = load_engine_games(&conn)?;
    let mut hvh = load_hvh_games(&conn)?;
    eng.append(&mut hvh);
    let normalized_games: Vec<NormalizedGame> = eng.into_iter().filter(|g| id_set.contains(&g.id)).collect();

    let file_path = file.clone();
    state.line_cache.insert(
        (query.clone(), file),
        (openings_vec.clone(), normalized_games.clone()),
    );
    state.search_collisions.remove(&(query, file_path));

    drop(permit);

    Ok((openings_vec, normalized_games))
}
