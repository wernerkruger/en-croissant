#!/usr/bin/env node
/**
 * Bump app version on each production build.
 * Patch segment runs 1–9 per minor line; after .9 the minor increments and patch resets
 * (0.17.1 … 0.17.9 → 0.18.0 … 0.18.9 → 0.19.0).
 *
 * Updates package.json, src-tauri/Cargo.toml, and the wk-chesser entry in Cargo.lock.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} current */
export function bumpVersion(current) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current.trim());
  if (!m) {
    throw new Error(`Expected MAJOR.MINOR.PATCH (e.g. 0.17.1), got "${current}"`);
  }
  let major = Number(m[1]);
  let minor = Number(m[2]);
  let patch = Number(m[3]);
  if (patch >= 9) {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function updateCargoToml(path, version) {
  const text = readFileSync(path, "utf8");
  const next = text.replace(/^version = ".*"$/m, `version = "${version}"`);
  if (next === text) {
    throw new Error(`Could not update version in ${path}`);
  }
  writeFileSync(path, next, "utf8");
}

function updateCargoLock(path, version) {
  const text = readFileSync(path, "utf8");
  const next = text.replace(
    /^(name = "wk-chesser"\nversion = )"[^"]+"/m,
    `$1"${version}"`,
  );
  if (next === text) {
    throw new Error(`Could not update wk-chesser version in ${path}`);
  }
  writeFileSync(path, next, "utf8");
}

const dryRun = process.argv.includes("--dry-run");
const pkgPath = join(root, "package.json");
const pkg = readJson(pkgPath);
const current = pkg.version;
const next = bumpVersion(current);

if (dryRun) {
  console.log(`${current} -> ${next}`);
  process.exit(0);
}

pkg.version = next;
writeJson(pkgPath, pkg);
updateCargoToml(join(root, "src-tauri", "Cargo.toml"), next);
updateCargoLock(join(root, "src-tauri", "Cargo.lock"), next);

console.log(`Version bumped: ${current} -> ${next}`);
