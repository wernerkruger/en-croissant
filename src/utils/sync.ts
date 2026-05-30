import { resolve } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { getDefaultStore } from "jotai";
import { commands, type SyncOptions } from "@/bindings";
import { libraryBooksAtom, pinnedGamesAtom, syncConfigAtom } from "@/state/atoms";
import { getLibraryDir } from "@/utils/directories";
import {
    type Book,
    type PinnedGame,
    type SyncConfig,
    type SyncManifest,
    syncManifestSchema,
} from "@/utils/library";

export type SyncResult = {
    booksTotal: number;
    pinnedTotal: number;
    downloaded: number;
    uploaded: number;
};

function optionsFromConfig(config: SyncConfig): SyncOptions {
    return {
        host: config.host.trim(),
        port: config.port,
        username: config.username.trim(),
        password: config.password,
        remoteDir: config.remoteDir.trim() || "chess-data",
    };
}

function configIsComplete(config: SyncConfig): boolean {
    return (
        config.host.trim().length > 0 &&
        config.username.trim().length > 0 &&
        config.password.length > 0
    );
}

/** Unwrap a tauri-specta command result, throwing on the error variant. */
function unwrap<T>(res: { status: "ok"; data: T } | { status: "error"; error: string }): T {
    if (res.status === "error") {
        throw new Error(res.error);
    }
    return res.data;
}

/** Merge two lists keyed by `id`, keeping whichever item has the newer timestamp. */
function mergeById<T extends { id: string }>(
    local: T[],
    remote: T[],
    timestamp: (item: T) => number,
): T[] {
    const byId = new Map<string, T>();
    for (const item of [...local, ...remote]) {
        const existing = byId.get(item.id);
        if (!existing || timestamp(item) >= timestamp(existing)) {
            byId.set(item.id, item);
        }
    }
    return [...byId.values()];
}

/** Verify the connection and that the `chess-data` folder layout exists. */
export async function testSync(config: SyncConfig): Promise<void> {
    unwrap(await commands.syncTest(optionsFromConfig(config)));
}

/**
 * Two-way sync of the library and pinned games against the SFTP server:
 * downloads books missing locally, uploads books missing remotely, merges the
 * manifest (newest wins per item) and writes it back. Updates local Jotai state.
 */
export async function runSync(): Promise<SyncResult> {
    const store = getDefaultStore();
    const config = store.get(syncConfigAtom);

    if (!configIsComplete(config)) {
        throw new Error("Sync is not fully configured (host, username and password are required).");
    }

    const opts = optionsFromConfig(config);

    unwrap(await commands.syncTest(opts));

    let remote: SyncManifest = { books: [], pinnedGames: [] };
    const raw = unwrap(await commands.syncReadManifest(opts));
    if (raw) {
        try {
            remote = syncManifestSchema.parse(JSON.parse(raw));
        } catch {
            remote = { books: [], pinnedGames: [] };
        }
    }

    const localBooks = store.get(libraryBooksAtom);
    const localPins = store.get(pinnedGamesAtom);

    const mergedBooks = mergeById<Book>(localBooks, remote.books, (b) => b.addedAt);
    const mergedPins = mergeById<PinnedGame>(localPins, remote.pinnedGames, (p) => p.createdAt);

    const remoteFiles = unwrap(await commands.syncListBooks(opts));
    const libDir = await getLibraryDir();

    let downloaded = 0;
    let uploaded = 0;

    for (const book of mergedBooks) {
        const fileName = book.fileName || `${book.id}.pdf`;
        const localPath = await resolve(libDir, fileName);
        const haveLocal = await exists(localPath);
        const haveRemote = remoteFiles.includes(fileName);

        if (!haveLocal && haveRemote) {
            unwrap(await commands.syncDownloadBook(opts, fileName, localPath));
            downloaded += 1;
            book.fileName = fileName;
            book.path = localPath;
        } else if (haveLocal && !haveRemote) {
            unwrap(await commands.syncUploadBook(opts, localPath, fileName));
            uploaded += 1;
            book.fileName = fileName;
            book.path = localPath;
        } else if (haveLocal) {
            // Normalise the stored path to this machine's library location.
            book.fileName = fileName;
            book.path = localPath;
        }
    }

    const manifest: SyncManifest = {
        books: mergedBooks,
        pinnedGames: mergedPins,
        updatedAt: Date.now(),
    };
    unwrap(await commands.syncWriteManifest(opts, JSON.stringify(manifest, null, 2)));

    store.set(libraryBooksAtom, mergedBooks);
    store.set(pinnedGamesAtom, mergedPins);
    store.set(syncConfigAtom, { ...config, lastSyncAt: Date.now() });

    return {
        booksTotal: mergedBooks.length,
        pinnedTotal: mergedPins.length,
        downloaded,
        uploaded,
    };
}
