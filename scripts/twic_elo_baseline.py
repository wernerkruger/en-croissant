#!/usr/bin/env python3
"""
Build a baseline dataset for estimating "Elo level played at" from game-review stats.

This mirrors En Croissant's frontend heuristics in ``src/utils/gameReview.ts`` and
``src/utils/score.ts`` (classification labels, accuracy / CPL aggregation). Analysis
uses a local UCI engine (Stockfish) at fixed depth, similar to the in-app review.

TWIC / En Croissant databases
---------------------------
En Croissant stores TWIC (and other) games in SQLite with a binary ``Moves`` column
(shakmaty move indices), not raw PGN. This script therefore expects **PGN input**:
  - Unpacked ``.pgn`` files from https://theweekinchess.com weekly zips, or
  - PGN exported from En Croissant for a database.

**Lichess PGN files:** If the input **filename** starts with ``lichess`` (case-insensitive),
reported Elos are multiplied by **0.9** before bucketing (approx. ~10% reduction).

**Multiple PGN files:** Each file is processed independently: up to ``--per-bucket``
games per rating bucket **per file**. Outputs:
  - One ``<same-stem-as-pgn>.json`` next to each PGN (JSON array of row objects).
  - ``rating_calibration.json`` — concatenation of all rows from all files (default: cwd).

Optional ``--sqlite-ratings`` opens an En Croissant ``.sqlite`` file and prints
per-bucket game counts (Elo only).

Usage
-----
  pip install chess

  export STOCKFISH=/path/to/stockfish   # or use --engine

  python scripts/twic_elo_baseline.py \\
      --pgn-glob '/data/twic/**/*.pgn' \\
      --pgn-glob '/data/lichess_export/*.pgn' \\
      --per-bucket 20 \\
      --step 50 \\
      --depth 18

Each row includes ``bucket``, ``white_elo``, ``black_elo``, ``mean_elo``,
``pgn_source``, ``pgn_file``, ``review``, etc., for calibration / nearest-neighbour models.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sqlite3
import sys
from collections import defaultdict
from dataclasses import dataclass
from glob import glob
from pathlib import Path
from typing import Any, Generator, Iterable

import chess
import chess.engine
import chess.pgn


CP_CEILING = 1000

LICHESS_ELO_SCALE = 0.9

PIECE_VALUE = {
    chess.PAWN: 90,
    chess.KNIGHT: 300,
    chess.BISHOP: 300,
    chess.ROOK: 500,
    chess.QUEEN: 1000,
    chess.KING: 0,
}


def pgn_filename_is_lichess(path: Path) -> bool:
    return path.name.lower().startswith("lichess")


def adjust_elo(raw_elo: int, *, lichess_file: bool) -> int:
    if not lichess_file:
        return raw_elo
    return max(1, int(round(raw_elo * LICHESS_ELO_SCALE)))


def win_chance_centipawns(cp: float) -> float:
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def score_value_white_pov(board: chess.Board, s: chess.engine.PovScore) -> dict[str, Any]:
    w = s.white()
    if w.is_mate():
        m = w.mate()
        assert m is not None
        v = CP_CEILING * (1 if m > 0 else -1)
        return {"type": "mate", "value": int(v)}
    sc = w.score()
    assert sc is not None
    return {"type": "cp", "value": int(sc)}


def normalize_score(value: dict[str, Any], color: str) -> float:
    cp = float(value["value"])
    if color == "black":
        cp *= -1
    if value["type"] == "mate":
        cp = CP_CEILING * (1 if cp > 0 else -1)
    return clamp(cp, -CP_CEILING, CP_CEILING)


def sget_win_chance_loss(prev: dict[str, Any], next_: dict[str, Any], color: str) -> float:
    p = normalize_score(prev, color)
    n = normalize_score(next_, color)
    return win_chance_centipawns(p) - win_chance_centipawns(n)


def get_cp_loss(prev: dict[str, Any], next_: dict[str, Any], color: str) -> float:
    p = normalize_score(prev, color)
    n = normalize_score(next_, color)
    return max(0.0, p - n)


def get_accuracy(prev: dict[str, Any], next_: dict[str, Any], color: str) -> float:
    wcl = get_win_chance_loss(prev, next_, color)
    return clamp(103.1668 * math.exp(-0.04354 * wcl) - 3.1669 + 1, 0.0, 100.0)


def material_turn_pov(board: chess.Board) -> int:
    w = sum(PIECE_VALUE[p.piece_type] for _, p in board.piece_map().items() if p.color == chess.WHITE)
    b = sum(PIECE_VALUE[p.piece_type] for _, p in board.piece_map().items() if p.color == chess.BLACK)
    if board.turn == chess.WHITE:
        return w - b
    return b - w


def uci_key(u: str) -> str:
    return u.replace("+", "").replace("#", "").strip().lower()


def played_matches_uci(played: str, candidate: str) -> bool:
    return uci_key(played) == uci_key(candidate)


def top_n_includes_uci(best_lines: list[dict[str, Any]], played: str, n: int) -> bool:
    for line in best_lines[:n]:
        u0 = (line.get("uci_moves") or [None])[0]
        if u0 and played_matches_uci(played, u0):
            return True
    return False


def classify_move_review(
    move_index: int,
    played_uci: str,
    before: dict[str, Any],
    after: dict[str, Any],
    color: str,
) -> str:
    best = before.get("best") or []
    if not best or not (after.get("best") or []):
        return "good"
    b0 = best[0]
    a0 = after["best"][0]
    prev_v = b0["score"]
    next_v = a0["score"]
    cpl = get_cp_loss(prev_v, next_v, color)
    wcl = get_win_chance_loss(prev_v, next_v, color)
    best_uci = (b0.get("uci_moves") or [""])[0]
    is_best = played_matches_uci(played_uci, best_uci)
    full_move_approx = move_index // 2 + 1
    in_book_phase = move_index < 24 and full_move_approx <= 12
    top3 = top_n_includes_uci(best, played_uci, 3)
    # if in_book_phase and top3 and cpl < 35:
    #     return "book"
    if after.get("is_sacrifice") and not is_best and cpl < 12 and wcl < 8:
        return "brilliancy"
    if is_best and cpl < 25:
        return "best"
    if cpl < 35 and wcl < 6:
        return "excellent"
    if cpl < 50 and wcl < 10:
        return "good"
    if wcl > 5 or cpl >= 55:
        return "inaccuracy"
    if wcl > 10 or cpl >= 75:
        return "mistake"
    if wcl > 20 or cpl >= 100:
        return "blunder"
    return "good"


def mean(nums: list[float]) -> float:
    return sum(nums) / len(nums) if nums else 0.0


def harmonic_mean(nums: list[float]) -> float:
    if not nums:
        return 0.0
    s = sum(1.0 / max(n, 0.01) for n in nums)
    return len(nums) / s


def build_fens_and_sacrifice(mainline_uci: list[str], root: chess.Board) -> tuple[list[chess.Board], list[bool]]:
    """Match ``analyze_game`` position list and sacrifice flags (material heuristic)."""
    boards: list[chess.Board] = [root.copy()]
    sacrifice: list[bool] = [False]
    chess_board = root.copy()
    for uci in mainline_uci:
        prev = chess_board.copy()
        prev_eval = material_turn_pov(prev)
        mv = chess.Move.from_uci(uci)
        chess_board.push(mv)
        if chess_board.is_game_over():
            break
        cur_eval = -material_turn_pov(chess_board)
        boards.append(chess_board.copy())
        sacrifice.append(prev_eval > cur_eval + 100)
    return boards, sacrifice


def analyze_board(
    engine: chess.engine.SimpleEngine,
    board: chess.Board,
    *,
    depth: int,
    multipv: int,
) -> dict[str, Any]:
    infos = engine.analyse(board, chess.engine.Limit(depth=depth), multipv=multipv)
    best: list[dict[str, Any]] = []
    for info in infos:
        pv = info.get("pv") or []
        uci_moves = [m.uci() for m in pv]
        sc = score_value_white_pov(board, info["score"])
        best.append(
            {
                "uci_moves": uci_moves,
                "san_moves": [],  # unused by classifier
                "score": sc,
                "depth": info.get("depth", depth),
                "multipv": info.get("multipv", len(best) + 1),
                "nodes": info.get("nodes", 0),
                "nps": info.get("nps", 0),
            }
        )
    return {"best": best, "novelty": False, "is_sacrifice": False}


def build_stored_review(
    analyses: list[dict[str, Any]],
    mainline_uci: list[str],
    sacrifice_flags: list[bool],
) -> dict[str, Any] | None:
    if len(analyses) < 2 or not mainline_uci:
        return None
    for i in range(min(len(analyses), len(sacrifice_flags))):
        analyses[i]["is_sacrifice"] = sacrifice_flags[i]

    entries: list[dict[str, Any]] = []
    white_acc: list[float] = []
    black_acc: list[float] = []
    white_cpl: list[float] = []
    black_cpl: list[float] = []

    for k in range(len(mainline_uci)):
        if k + 1 >= len(analyses):
            break
        before = analyses[k]
        after = analyses[k + 1]
        if not before.get("best") or not after.get("best"):
            continue
        color = "white" if k % 2 == 0 else "black"
        prev_v = before["best"][0]["score"]
        next_v = after["best"][0]["score"]
        cpl = get_cp_loss(prev_v, next_v, color)
        acc = get_accuracy(prev_v, next_v, color)
        kind = classify_move_review(k, mainline_uci[k], before, after, color)
        entries.append({"halfMoves": k + 1, "kind": kind, "cploss": cpl, "accuracy": acc})
        if color == "white":
            white_acc.append(acc)
            white_cpl.append(cpl)
        else:
            black_acc.append(acc)
            black_cpl.append(cpl)

    return {
        "version": 1,
        "entries": entries,
        "whiteAccuracy": round(harmonic_mean(white_acc) * 10) / 10,
        "blackAccuracy": round(harmonic_mean(black_acc) * 10) / 10,
        "whiteCplAvg": round(mean(white_cpl) * 10) / 10,
        "blackCplAvg": round(mean(black_cpl) * 10) / 10,
    }


@dataclass
class RatedGame:
    bucket: int
    white_elo: int
    black_elo: int
    mean_elo: float
    mainline_uci: list[str]
    source: str


def parse_elo(h: chess.pgn.Headers, key: str) -> int | None:
    raw = h.get(key)
    if not raw or raw in ("?", "-"):
        return None
    try:
        v = int(raw)
    except ValueError:
        return None
    if v <= 0:
        return None
    return v


def iter_games_from_pgn_files(paths: Iterable[Path]) -> Generator[tuple[str, chess.pgn.Game], None, None]:
    for path in paths:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            while True:
                offset = f.tell()
                game = chess.pgn.read_game(f)
                if game is None:
                    break
                yield f"{path}:{offset}", game


def mainline_uci_from_game(game: chess.pgn.Game) -> list[str]:
    board = game.board()
    out: list[str] = []
    node = game
    while node.variations:
        node = node.variation(0)
        out.append(node.move.uci())
    return out


def collect_rated_games_for_file(
    pgn_path: Path,
    *,
    step: int,
    max_plies: int,
) -> dict[int, list[RatedGame]]:
    """Games and buckets for a single PGN file only (not pooled with other files)."""
    lichess = pgn_filename_is_lichess(pgn_path)
    by_bucket: dict[int, list[RatedGame]] = defaultdict(list)
    for src, game in iter_games_from_pgn_files([pgn_path]):
        h = game.headers
        we_raw = parse_elo(h, "WhiteElo")
        be_raw = parse_elo(h, "BlackElo")
        if we_raw is None or be_raw is None:
            continue
        we = adjust_elo(we_raw, lichess_file=lichess)
        be = adjust_elo(be_raw, lichess_file=lichess)
        uci = mainline_uci_from_game(game)
        if not uci:
            continue
        if len(uci) > max_plies:
            continue
        mean_elo = (we + be) / 2.0
        bucket = int(mean_elo // step) * step
        by_bucket[bucket].append(
            RatedGame(
                bucket=bucket,
                white_elo=we,
                black_elo=be,
                mean_elo=mean_elo,
                mainline_uci=uci,
                source=src,
            )
        )
    return by_bucket


def eligible_buckets(by_bucket: dict[int, list[RatedGame]], per_bucket: int, step: int) -> list[int]:
    keys = sorted(k for k, games in by_bucket.items() if len(games) >= per_bucket)
    if not keys:
        return []
    return [b for b in range(keys[0], keys[-1] + 1, step) if len(by_bucket.get(b, [])) >= per_bucket]


def sqlite_bucket_counts(db_path: Path, step: int) -> dict[int, int]:
    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute(
            """
            SELECT WhiteElo, BlackElo FROM Games
            WHERE WhiteElo IS NOT NULL AND BlackElo IS NOT NULL
              AND WhiteElo > 0 AND BlackElo > 0
            """
        ).fetchall()
    finally:
        conn.close()
    counts: dict[int, int] = defaultdict(int)
    for w, b in rows:
        mean_elo = (int(w) + int(b)) / 2.0
        bucket = int(mean_elo // step) * step
        counts[bucket] += 1
    return counts


def analyze_sampled_games(
    engine: chess.engine.SimpleEngine,
    sampled: list[RatedGame],
    *,
    pgn_path: Path,
    depth: int,
    multipv: int,
    lichess_adjusted: bool,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    pgn_file_str = str(pgn_path.resolve())
    for g in sampled:
        board = chess.Board()
        fens_boards, sac = build_fens_and_sacrifice(g.mainline_uci, board)
        analyses: list[dict[str, Any]] = []
        for b in fens_boards:
            analyses.append(analyze_board(engine, b, depth=depth, multipv=multipv))
        review = build_stored_review(analyses, g.mainline_uci, sac)
        if not review:
            continue
        rows.append(
            {
                "bucket": g.bucket,
                "white_elo": g.white_elo,
                "black_elo": g.black_elo,
                "mean_elo": g.mean_elo,
                "pgn_source": g.source,
                "pgn_file": pgn_file_str,
                "lichess_elo_adjusted": lichess_adjusted,
                "mainline_uci": g.mainline_uci,
                "review": review,
                "depth": depth,
                "multipv": multipv,
            }
        )
    return rows


def process_one_pgn_file(
    engine: chess.engine.SimpleEngine,
    pgn_path: Path,
    *,
    per_bucket: int,
    step: int,
    max_plies: int,
    depth: int,
    multipv: int,
    seed: int,
) -> tuple[list[dict[str, Any]], bool]:
    """Returns (rows, had_eligible_buckets)."""
    by_bucket = collect_rated_games_for_file(pgn_path, step=step, max_plies=max_plies)
    buckets = eligible_buckets(by_bucket, per_bucket, step)
    if not buckets:
        return [], False
    lichess = pgn_filename_is_lichess(pgn_path)
    random.seed((seed, str(pgn_path.resolve())))
    sampled: list[RatedGame] = []
    for bucket in buckets:
        pool = by_bucket[bucket]
        sampled.extend(random.sample(pool, per_bucket))
    rows = analyze_sampled_games(
        engine,
        sampled,
        pgn_path=pgn_path,
        depth=depth,
        multipv=multipv,
        lichess_adjusted=lichess,
    )
    return rows, True


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pgn-glob", action="append", default=[], help="Glob for PGN files (repeatable).")
    ap.add_argument("--pgn-file", action="append", default=[], help="Single PGN file (repeatable).")
    ap.add_argument("--sqlite-ratings", type=Path, help="En Croissant DB: print bucket counts and exit.")
    ap.add_argument(
        "--calibration-out",
        type=Path,
        default=Path("rating_calibration.json"),
        help="Merged output path (JSON array of all rows from all PGNs). Default: ./rating_calibration.json",
    )
    ap.add_argument("--per-bucket", type=int, default=20)
    ap.add_argument("--step", type=int, default=50)
    ap.add_argument("--depth", type=int, default=18)
    ap.add_argument("--multipv", type=int, default=3)
    ap.add_argument("--max-plies", type=int, default=200)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--engine", default=os.environ.get("STOCKFISH", "stockfish"))
    args = ap.parse_args()

    if args.sqlite_ratings:
        counts = sqlite_bucket_counts(args.sqlite_ratings, args.step)
        for b in sorted(counts):
            print(f"{b}\t{counts[b]}")
        return

    paths: list[Path] = []
    for g in args.pgn_glob:
        paths.extend(Path(p) for p in glob(g, recursive=True))
    for f in args.pgn_file:
        paths.append(Path(f))
    paths = sorted(set(paths))
    if not paths:
        print("No PGN inputs. Use --pgn-glob and/or --pgn-file.", file=sys.stderr)
        sys.exit(1)

    all_rows: list[dict[str, Any]] = []
    any_output = False

    with chess.engine.SimpleEngine.popen_uci(args.engine) as engine:
        engine.configure({"UCI_AnalyseMode": True})
        for pgn_path in paths:
            out_path = pgn_path.with_suffix(".json")
            rows, had_eligible = process_one_pgn_file(
                engine,
                pgn_path,
                per_bucket=args.per_bucket,
                step=args.step,
                max_plies=args.max_plies,
                depth=args.depth,
                multipv=args.multipv,
                seed=args.seed,
            )
            if not had_eligible:
                print(f"No bucket with >={args.per_bucket} games (wrote []): {pgn_path}", file=sys.stderr)
            elif not rows:
                print(f"No rows after analysis: {pgn_path}", file=sys.stderr)
            else:
                any_output = True
            all_rows.extend(rows)
            out_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"Wrote {len(rows)} rows -> {out_path}", file=sys.stderr)

    args.calibration_out.parent.mkdir(parents=True, exist_ok=True)
    args.calibration_out.write_text(json.dumps(all_rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(all_rows)} total rows -> {args.calibration_out.resolve()}", file=sys.stderr)

    if not any_output and not all_rows:
        print("No analyzed rows produced (no file had enough games per bucket).", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
