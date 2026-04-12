import { describe, expect, it } from "vitest";
import { OpeningBookTrie, openingMovetextToUci } from "@/utils/openingBook";

describe("openingMovetextToUci", () => {
    it("parses e4 e5 Nf3", () => {
        expect(openingMovetextToUci("1. e4 e5 2. Nf3")).toEqual(["e2e4", "e7e5", "g1f3"]);
    });

    it("parses castling", () => {
        const u = openingMovetextToUci("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O");
        expect(u).not.toBeNull();
        expect(u?.length).toBe(9);
        expect(u?.[8]).toMatch(/^e1[g-h]1$/);
    });
});

describe("OpeningBookTrie", () => {
    it("prefers longer matching line at shared prefix", () => {
        const t = new OpeningBookTrie();
        t.insertUciLine(["e2e4", "e7e5"], "X", "Short");
        t.insertUciLine(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"], "Y", "Ruy Lopez");
        expect(t.lookupPrefix(["e2e4", "e7e5"])?.name).toBe("Ruy Lopez");
        expect(t.lookupPrefix(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"])?.name).toBe("Ruy Lopez");
    });

    it("returns null when prefix not in book", () => {
        const t = new OpeningBookTrie();
        t.insertUciLine(["e2e4"], "A", "King's Pawn");
        expect(t.lookupPrefix(["d2d4"])).toBeNull();
    });
});
