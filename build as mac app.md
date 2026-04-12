1. Build the macOS app bundle
From the repo root (with frontend deps installed and Rust toolchain ready):

npm run build-vite
npm run tauri build
Or in one go (Tauri runs beforeBuildCommand, which is pnpm build-vite in tauri.conf.json):

npm run tauri build
Important: use tauri build without --no-bundle (your npm run build script adds --no-bundle on purpose for CI/speed—don’t use that if you want an app bundle).

After a successful run you should get something like:

src-tauri/target/release/bundle/macos/En Croissant.app (exact folder/name can vary slightly with Tauri 2 / productName)
Often also a .dmg next to it for distribution.
If you use pnpm (as in tauri.conf.json), either keep that or align beforeBuildCommand with npm run build-vite.

2. Put it in Applications (so it shows like other apps)
Either:

Drag the .app into /Applications in Finder, or
In Terminal:
cp -R "src-tauri/target/release/bundle/macos/En Croissant.app" /Applications/
(Adjust the .app name/path to match what’s actually in bundle/macos/.)

Then it appears in Launchpad and Spotlight like any other app.

3. First launch / Gatekeeper
With signingIdentity: "-" (ad-hoc signing), macOS may block the app the first time. Users can right‑click → Open once, or allow it in System Settings → Privacy & Security.

For distribution outside your machine you’d want Apple Developer signing and notarization; that’s a separate setup.

Optional: a dedicated npm script
You can add something like:

"build:mac": "node scripts/with-cargo-path.mjs tauri build"
so npm run build:mac always produces the .app / .dmg without touching your existing --no-bundle build script. I can add this to package.json if you want it in the repo.