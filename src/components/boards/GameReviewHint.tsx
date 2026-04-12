import { Box, type MantineColor } from "@mantine/core";
import type { Color, Square } from "chessops";
import type { MoveReviewKind } from "@/utils/gameReview";
import { squareToCoordinates } from "@/utils/chessops";

const KIND_META: Record<
    MoveReviewKind,
    { abbr: string; color: MantineColor; titleKey: string }
> = {
    book: { abbr: "BK", color: "orange", titleKey: "Book" },
    good: { abbr: "OK", color: "green", titleKey: "Good" },
    excellent: { abbr: "!!", color: "teal", titleKey: "Excellent" },
    best: { abbr: "★", color: "blue", titleKey: "Best" },
    brilliancy: { abbr: "✦", color: "cyan", titleKey: "Brilliant" },
    inaccuracy: { abbr: "?!", color: "yellow", titleKey: "Inaccuracy" },
    mistake: { abbr: "?", color: "orange", titleKey: "Mistake" },
    blunder: { abbr: "⨯", color: "red", titleKey: "Blunder" },
};

export default function GameReviewHint({
    square,
    kind,
    orientation,
    title,
}: {
    square: Square;
    kind: MoveReviewKind;
    orientation: Color;
    title: string;
}) {
    const { file, rank } = squareToCoordinates(square, orientation);
    const meta = KIND_META[kind];

    return (
        <Box
            style={{
                position: "absolute",
                width: "12.5%",
                height: "12.5%",
                left: `${(file - 1) * 12.5}%`,
                bottom: `${(rank - 1) * 12.5}%`,
                pointerEvents: "none",
            }}
        >
            <Box
                pos="absolute"
                pl="78%"
                style={{ transform: "translateY(-35%) translateX(-50%)", zIndex: 120 }}
            >
                <Box
                    w={28}
                    h={28}
                    style={{
                        borderRadius: "50%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: meta.abbr.length > 1 ? "1.5rem" : "1.8rem",
                        fontWeight: 800,
                        color: "white",
                        boxShadow: "0 1px 4px rgba(0,0,0,0.45)",
                        border: "2px solid rgba(255,255,255,0.85)",
                    }}
                    bg={meta.color}
                    title={title}
                >
                    {meta.abbr}
                </Box>
            </Box>
        </Box>
    );
}
