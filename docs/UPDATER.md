# Auto-update signing

Tauri's `tauri-plugin-updater` verifies downloaded update bundles with an
Ed25519 public key. The public key ships in `tauri.conf.json`; the private key
must remain outside the repository and be available only to the release job.

## Current state: deliberately disabled

The updater currently fails closed:

- The Rust plugin **is registered** in
  [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), and the default window has
  the `updater:default` capability. No Rust change is needed to register it.
- `plugins.updater.active` is `false` and `plugins.updater.pubkey` is empty in
  [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json).
- The configured endpoint belongs to this repository:
  `https://github.com/yulianjie/MarkCaptain/releases/latest/download/latest.json`.
- `UpdaterDialog.vue` treats `plugins.updater.active` as a project-level UI
  gate and checks for a non-empty public key plus HTTPS endpoints before it
  calls the updater plugin. It explains the disabled or unsafe configuration
  instead of reporting that an unchecked build is up to date.
- The current release workflow does not sign updater artifacts or publish a
  `latest.json` manifest, so automatic updates must remain disabled.

`active` is a MarkCaptain renderer gate, not a native field consumed by the
Tauri updater crate. The crate ignores that unknown field; therefore the
renderer readiness check must not be removed.

## Enabling updates safely

Do not set `active` to `true` until every step below is complete.

1. Generate the signing keypair on a trusted release machine. Keep the private
   key and its password out of Git, build logs, command arguments, and release
   assets.

   ```bash
   npx tauri signer generate -w ~/.tauri/markcaptain.key
   ```

2. Put only the generated public key in `plugins.updater.pubkey`. Keep the
   endpoint on the `yulianjie/MarkCaptain` release origin (or another explicitly
   controlled HTTPS update service).

3. Enable updater artifact generation in the bundle configuration:

   ```jsonc
   "bundle": {
     "createUpdaterArtifacts": true
   }
   ```

4. Store `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as protected CI secrets. Build every
   release with those variables so Tauri emits the updater archives and
   signatures.

5. Extend `.github/workflows/release.yml` to publish the signed updater
   artifacts and a valid `latest.json` whose platform URLs and signatures point
   to the same release. See the
   [Tauri v2 updater documentation](https://v2.tauri.app/plugin/updater/).

6. Verify a staged release end to end: the manifest resolves, its version is
   newer than the installed build, every URL is HTTPS, the signature validates,
   and a tampered artifact is rejected.

7. Set `plugins.updater.active` to `true` only after the staged verification
   passes. A missing key, missing endpoint, or non-HTTPS endpoint will still be
   blocked by the dialog before any update request is made.

## UI state matrix

| Configuration | Dialog result | Network check |
| --- | --- | --- |
| `active: false` | Clearly reports automatic updates are disabled | No |
| Active, but key/HTTPS endpoint missing | Reports unsafe/incomplete configuration | No |
| Active and safely configured | Checks signed release metadata | Yes |
| Safely configured and `check()` returns `null` | Reports latest version | Yes |

This separation keeps the updater command available for a future signed
release without allowing an unsigned or partially configured build to imply
that an update check succeeded.
