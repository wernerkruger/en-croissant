import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cargoBin = join(homedir(), ".cargo", "bin");
const pathEnv = process.env.PATH ?? "";
const env = {
  ...process.env,
  PATH: pathEnv ? `${cargoBin}${delimiter}${pathEnv}` : cargoBin,
};

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("with-cargo-path: missing command");
  process.exit(1);
}

const [cmd, ...cmdArgs] = args;

// Bump the app version on production builds (`tauri build`), so `pnpm tauri build`
// behaves like `pnpm build`. Other subcommands (`dev`, `info`, ...) are left alone.
// Set SKIP_VERSION_BUMP=1 to re-run a build without incrementing again.
if (cmd === "tauri" && cmdArgs[0] === "build" && !process.env.SKIP_VERSION_BUMP) {
  const bump = spawnSync(process.execPath, [join(scriptDir, "bump-version.mjs")], {
    stdio: "inherit",
  });
  if (bump.status !== 0) {
    process.exit(bump.status ?? 1);
  }
}

const shell = process.platform === "win32";
const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", env, shell });
process.exit(r.status ?? 1);
