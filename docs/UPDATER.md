# Automatic updates

MarkCaptain uses the registered Tauri v2 updater plugin and its mandatory
Minisign/Ed25519 verification. The public key is bundled in
`src-tauri/tauri.conf.json`. Update metadata comes from:

`https://github.com/yulianjie/MarkCaptain/releases/latest/download/latest.json`

## User experience

- General preferences → **Automatically check for updates** is enabled by default.
  The main editor checks ten seconds after startup and every four hours while
  running. Turning the preference off cancels scheduled checks. Manual checking
  remains available from Help → Check for Updates.
- Automatic checks only open a dialog when an update is available. Network
  failures stay quiet; a manual check shows errors and offers a retry.
- Updates are downloaded and installed only after clicking **Download & Install**.
  Progress is shown even if the server does not provide a content length.
- Before installation, close other editor windows. MarkCaptain saves all open
  documents, flushes Agent data and persists the editor session. Cancelling Save
  As or a failed save pauses installation. Windows installers can exit the entire
  process; other platforms offer Relaunch after installation succeeds.
- Download completion is distinct from installation completion. A failed
  signature or installation never displays the restart-ready state.

An installed version from before this feature must be upgraded manually once.
Until the first signed release publishes `latest.json`, checking the public
endpoint reports an error; it must never claim that an unchecked build is current.

## Signing keys

Only the public key belongs in Git. Release builds read
`TAURI_SIGNING_PRIVATE_KEY` and optionally `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
from protected GitHub Actions secrets. Never print a private key or place it in
command arguments, repository files, or release assets. Keep a recoverable backup;
losing the key prevents updates to already installed versions.

The initial release-machine backup is outside the repository under
`~/.tauri/markcaptain/updater-private-key.dpapi`, encrypted with Windows DPAPI for
the Windows account that created it. The corresponding public key is in
`updater-public-key.txt`. The encrypted file alone is not a portable backup;
DPAPI recovery requires the original Windows account and its encryption keys.

For a local signed bundle, load the DPAPI backup into the environment in memory,
build, and remove the environment variable afterwards. Do not write a decrypted
key to disk. Use `npx tauri signer generate --ci` with captured output only when
initializing a new project; do not replace this project's existing key casually.

## Release pipeline

`bundle.createUpdaterArtifacts` is enabled. Each release target builds with the
signing secret. `scripts/updater-release.mjs stage` verifies the artifact and both
Minisign signatures against the bundled public key, then copies the artifact and
signature with a unique version/platform name. A tag/application version mismatch
also fails before uploading. The macOS archive is Tauri's signed
archive, preserved byte-for-byte; never re-tar it after signing.

After **all** build jobs succeed, the manifest job reads the same release's assets
and signatures and publishes `latest.json`. It requires Windows x64 NSIS, Linux
x64 AppImage, macOS arm64 and macOS x64. Missing/empty artifacts or signatures and
foreign download origins fail the job before manifest publication. The
macOS-only retry mode uses existing signed Windows/Linux artifacts from the same
release and fails if those are absent. Update signatures are separate from Apple
code signing/notarization and Windows Authenticode.

`plugins.updater.active` is a MarkCaptain renderer gate. A disabled gate, empty
public key, or missing/non-HTTPS endpoint blocks checks before calling the native
plugin. The native plugin independently verifies downloaded bytes.

## Verification

Run `npm run test:unit`, `npm run build`, `npm run lint` and Rust checks. Verify
the signed-release helpers with actual Tauri signatures, including changed bytes
and a mismatched public key. Before calling a public release verified, check its
manifest, every platform's signature and download URL, and test an installed old
version upgrading to the newer signed release on the target OS. Unit tests and
browser checks do not prove that an OS installer completed successfully.

Reference: [Tauri v2 updater documentation](https://v2.tauri.app/plugin/updater/).
