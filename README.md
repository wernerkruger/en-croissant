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
git tag v0.18.4 && git push origin v0.18.4
```

