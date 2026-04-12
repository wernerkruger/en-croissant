import { type Chess, makeUci, parseUci } from "chessops";
import { INITIAL_FEN } from "chessops/fen";
import { parseSan } from "chessops/san";
import { positionFromFen } from "@/utils/chessops";

const OPENING_FILES = ["a", "b", "c", "d", "e"] as const;

export interface OpeningMatch {
    eco: string;
    name: string;
}

type TrieNode = {
    children: Map<string, TrieNode>;
    /** Best (longest total line) opening that reaches this prefix. */
    match?: { eco: string; name: string; lineLen: number };
};

function normalizeUciToken(u: string): string {
    return u.replace(/\+|#/g, "").trim().toLowerCase();
}

/** Movetext fragment only (e.g. `1. e4 e5 2. Nf3`). Returns UCI plies from standard start. */
export function openingMovetextToUci(movetext: string): string[] | null {
    const trimmed = movetext.trim();
    if (!trimmed) return [];

    const [pos0, err] = positionFromFen(INITIAL_FEN);
    if (err || !pos0) return null;

    let pos: Chess = pos0;
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const out: string[] = [];

    for (const raw of tokens) {
        if (/^\d+\.(\.\.)?$/.test(raw)) continue;

        const sanToken = raw.replace(/^\.\.\./, "");
        let move = parseSan(pos, sanToken);
        if (!move) {
            move = parseUci(sanToken);
        }
        if (!move) {
            return null;
        }
        const uci = normalizeUciToken(makeUci(move));
        out.push(uci);
        pos.play(move);
    }

    return out;
}

function splitTsvRow(line: string): { eco: string; name: string; pgn: string } | null {
    const i = line.indexOf("\t");
    if (i < 0) return null;
    const j = line.indexOf("\t", i + 1);
    if (j < 0) return null;
    return {
        eco: line.slice(0, i).trim(),
        name: line.slice(i + 1, j).trim(),
        pgn: line.slice(j + 1).trim(),
    };
}

function insertLine(root: TrieNode, ucis: string[], eco: string, name: string): void {
    const lineLen = ucis.length;
    let node = root;
    for (let d = 0; d < ucis.length; d++) {
        const key = ucis[d]!;
        let next = node.children.get(key);
        if (!next) {
            next = { children: new Map() };
            node.children.set(key, next);
        }
        node = next;
        if (!node.match || lineLen > node.match.lineLen) {
            node.match = { eco, name, lineLen };
        }
    }
}

export class OpeningBookTrie {
    private root: TrieNode = { children: new Map() };

    insertUciLine(ucis: string[], eco: string, name: string): void {
        if (ucis.length === 0) return;
        insertLine(this.root, ucis, eco, name);
    }

    /** Longest registered line that matches this exact UCI prefix (standard start only). */
    lookupPrefix(uciPrefix: string[]): OpeningMatch | null {
        if (uciPrefix.length === 0) return null;
        let node: TrieNode = this.root;
        for (const u of uciPrefix) {
            const key = normalizeUciToken(u);
            const next = node.children.get(key);
            if (!next) return null;
            node = next;
        }
        const m = node.match;
        return m ? { eco: m.eco, name: m.name } : null;
    }
}

let cachedBook: OpeningBookTrie | null = null;
let loadPromise: Promise<OpeningBookTrie> | null = null;

function openingsBaseUrl(): string {
    const b = import.meta.env.BASE_URL;
    return b.endsWith("/") ? b : `${b}/`;
}

async function loadOpeningBookFromPublic(): Promise<OpeningBookTrie> {
    const book = new OpeningBookTrie();
    const base = openingsBaseUrl();

    for (const letter of OPENING_FILES) {
        const url = `${base}openings/${letter}.tsv`;
        let text: string;
        try {
            const res = await fetch(url);
            if (!res.ok) continue;
            text = await res.text();
        } catch {
            continue;
        }

        const lines = text.split(/\r?\n/);
        for (let li = 0; li < lines.length; li++) {
            const line = lines[li]!;
            if (li === 0 && line.toLowerCase().startsWith("eco\t")) continue;
            if (!line.trim()) continue;
            const row = splitTsvRow(line);
            if (!row || !row.pgn) continue;
            const ucis = openingMovetextToUci(row.pgn);
            if (!ucis || ucis.length === 0) continue;
            book.insertUciLine(ucis, row.eco, row.name);
        }
    }

    return book;
}

/** Singleton opening trie from `public/openings/*.tsv`. */
export async function getOpeningBook(): Promise<OpeningBookTrie> {
    if (cachedBook) return cachedBook;
    if (!loadPromise) {
        loadPromise = loadOpeningBookFromPublic().then((b) => {
            cachedBook = b;
            return b;
        });
    }
    return loadPromise;
}

export function isStandardStartFen(fen: string): boolean {
    const a = fen.trim().split(/\s+/).slice(0, 4).join(" ");
    const b = INITIAL_FEN.trim().split(/\s+/).slice(0, 4).join(" ");
    return a === b;
}
