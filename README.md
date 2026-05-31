<br />

### Build (current platform)

```bash
git clone git@github.com:wernerkruger/en-croissant.git
cd en-croissant
pnpm install
pnpm tauri build
```

The built app can be found at `src-tauri/target/release`. 
On Debian/Ubuntu you can install the generated `.deb`:

```bash
sudo apt install ./src-tauri/target/release/bundle/deb/*.deb
sudo apt-get install -f
```

### Building for other platforms (macOS / Windows)

Tauri **cannot cross-compile** — `pnpm tauri build` only produces artifacts for the OS and CPU architecture you run it on (e.g. Linux `.deb`/`.rpm`/`.AppImage`). 

To build a macOS `.dmg` or a Windows installer without owning that hardware, use the included GitHub Actions release workflow (`.github/workflows/release.yml`), which builds macOS (Apple Silicon + Intel `.dmg`), Linux, and Windows on the appropriate runners and attaches them to a draft GitHub release.

Trigger it by pushing a `v*` tag (or via the **Run workflow** button on the Actions tab):

```bash
git tag v0.19.0 && git push origin v0.19.0
```

### Building on macOS (local `.app` for Applications)

Tauri cannot cross-compile from Linux or Windows to macOS — you must run the build on a Mac.

#### One-time setup

```bash
# Xcode command-line tools (needed for linking)
xcode-select --install

# Node (v20.19+; v22 is fine), e.g. via nvm:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
nvm install 22 && nvm use 22

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# pnpm
npm install -g pnpm
```

Clone the repo and install frontend dependencies:

```bash
git clone git@github.com:wernerkruger/en-croissant.git
cd en-croissant
pnpm install
```

#### Build the Mac app

From the repo root:

```bash
source "$HOME/.cargo/env"
pnpm tauri build
```

Use **`pnpm tauri build`**, not `pnpm build` — the `build` script adds `--no-bundle`, which skips creating the `.app` / `.dmg`.

The first build can take a while (especially after pulling changes that add Rust dependencies).

#### Install in Applications

After a successful build, the app bundle is at:

```
src-tauri/target/release/bundle/macos/en-croissant.app
```

You may also get a disk image at `src-tauri/target/release/bundle/dmg/` for sharing with other Macs.

**Finder:** drag `en-croissant.app` into **Applications**.

**Terminal:**

```bash
cp -R "src-tauri/target/release/bundle/macos/en-croissant.app" /Applications/
```

Then launch it from Launchpad or Spotlight like any other app.

#### First launch (Gatekeeper)

This project uses ad-hoc signing, so macOS may block the app the first time. If you see “can’t be opened because it is from an unidentified developer”, right-click the app → **Open** → **Open** again, or allow it under **System Settings → Privacy & Security**. That is normal for a locally built, unsigned app on your own machine.

