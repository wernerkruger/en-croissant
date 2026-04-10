import { createFileRoute } from "@tanstack/react-router";
import TournamentPage from "@/components/tournaments/TournamentPage";

export const Route = createFileRoute("/tournaments/")({
    component: TournamentPage,
});
