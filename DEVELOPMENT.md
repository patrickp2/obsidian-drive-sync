# Development and testing

Use Node.js 24 or newer:

```sh
npm ci --ignore-scripts
npm run check
```

The build generates `dist/drive-sync/main.js`, `manifest.json`, and `styles.css`, plus `docs/index.html` with its exact callback CSP hash. Only the three plugin assets go into a disposable vault's `.obsidian/plugins/drive-sync/`. Do not copy local settings or tokens. The callback is published from `docs/`; building locally does not publish it.

See [INSTALLATION.md](INSTALLATION.md) for the current desktop/phone setup. Runtime credentials are never bundled. The QR encoder is a bundled MIT dependency; Obsidian and desktop Node built-ins remain external. The temporary local pairing listener is loaded only on desktop.

## Test layers

- Authentication: state expiry/replay, PKCE, scope validation, refresh retention, retries, revocation, and unload/disconnect races.
- Callback: fixed protocol handler, safe rendering, history cleanup, no third-party resources, exact CSP hash.
- iPhone file API: v2 current-ETag writes passed; stale writes returned HTTP 412 and preserved newer bytes; fresh retry passed. Probe resources were moved to Drive trash.
- Pairing: authenticated encrypted transfer, wrong-key/session rejection, reflection/replay rejection, private endpoint validation, and configuration-only import.
- Drive adapter: mandatory ETag conditions, v2 upload path, moved-file rejection, consistent downloads, and full/duplicate-free pagination.
- Sync engine: independent device stores, common baselines, conflicts, stale uploads, local edits during downloads, interrupted creates, restart recovery, missing files, and failed listings.

Unit tests contain synthetic data only and make no Google requests. The separate **Drive Sync: Developer: test disposable Drive files** command performs live API checks using a fresh disposable folder and Markdown note. It tests current/stale/fresh ETags on the exact v2 media upload endpoint and trashes only resources it created. It never permanently deletes files or reads vault notes. Keep the app open through cleanup; a connection drop or termination can leave the named disposable folder for manual review.

## Real-device evidence, 2026-10-04

The desktop vault is `test-vaults/drive-sync-auth` (ignored by Git), running Obsidian 1.13.7. The phone vault is `Test`, originally empty. Real user vaults were not modified.

- Desktop: browser sign-in, vault-specific handoff, direct refresh, plugin/vault reload recovery, and separate wrong/missing PKCE rejection passed.
- iPhone: external Chrome launch, user-completed OAuth return, direct refresh, and automatic refresh after app-switcher force-close/relaunch passed.
- Drive: v3 media PATCH ignored the deliberately nonmatching precondition; v2 media PUT rejected the stale ETag with 412 and preserved content. Current ETags succeeded. Probe resources were moved to trash.
- iPhone file API: v2 current-ETag writes passed; stale writes returned HTTP 412 and preserved newer bytes; fresh retry passed. Probe resources were moved to Drive trash.
- Pairing: a temporary listener bound to the Mac's private network interface successfully transferred synthetic configuration through the actual encrypted request/response path. Real-iPhone external-Camera handoff, desktop approval, configuration storage, and first sync passed. In-app camera permission, live scanning, and the single-panel flow passed on the real iPhone in 0.2.1, with user confirmation of scanning and subsequent UI verification of connection and sync status.
- Desktop sync: the current engine created the dedicated Drive folder, uploaded the synthetic README and Sync test notes, and recorded confirmed baselines. The mobile and conflict results are recorded below.

- Real-device edits: Mac → iPhone → Mac → iPhone passed. Pausing phone sync, independently editing both devices, and resuming preserved both branches as ordinary Markdown; the conflict copy propagated to the Mac.

## Release

Use matching version numbers in package.json, manifest.json, and the release tag. Run checks and credential scanning before publishing. Attach `main.js`, `manifest.json`, and `styles.css` separately to the GitHub prerelease; BRAT downloads those assets. Do not overwrite older release assets. Update both devices through BRAT or copy built artifacts only into the desktop test vault.

Do not mark the beta production-ready: current limits and remaining gates are in [FEASIBILITY.md](FEASIBILITY.md). Source-level tests do not establish real iOS lifecycle/network behavior. Version 0.3.0 implements attachments and recoverable move/deletion paths. End-to-end folder selection and vault lifecycle tests must pass before claiming those flows verified on both devices.

## 0.3.0 validation

`npm run check` passes 77 tests, including binary recovery under late writes, pending create/move/trash outcomes after simulated interruption, deletion-vs-edit conflicts, two separate vault states, root-bound state migration, folder rename chains, existing folder discovery, insufficient-scope rejection, version-cache behavior, and 2,000-file restart reconciliation.

The extended disposable-file command passed on the Mac through the real Obsidian HTTP adapter: two roots with identical paths, arbitrary binary bytes, current/stale content updates, current/stale rename plus parent move, and current/stale trash. Rejected writes returned HTTP 412. Both synthetic roots were moved to trash.

Still required: exercise note/folder rename and recoverable deletion through the Obsidian UI; interrupt actual transfers with app termination/network loss; test existing-folder selection and automatic discovery of a synthetic externally created file. Google Picker was enabled with approval; billing remains unlinked. Never revoke the user's normal grants merely to force a test; use an isolated test grant or arrange a user-controlled revocation.

## Rapid rename regression

A real desktop test renamed a note twice before the first move was confirmed. Version 0.3.0 treated the intermediate remote path as a competing rename, then downloaded it as an unrelated file and created a duplicate baseline identity. Version 0.4.0 persists attempted move destinations before sending them, blocks intermediate paths, and rechecks current rename intent. Regression tests cover uncertain responses, a second rename, undoing a rename, and actual competing device destinations.

The complete disposable API probe passed on the real iPhone in 0.3.0, including binary byte fidelity, two-folder isolation, stale replacement/move/trash HTTP 412, successful current moves/trash, and recoverable cleanup. The green/gold PNG rendered inside its synced note. Obsidian restart restored the existing independent grant. UI-driven vault rename/deletion and import checks are still in progress.

## Current authorization and folder setup

The user approved full Drive authorization for seamless existing-folder sync and external additions. Version 0.4.0 removes Picker/import code and provides an in-plugin folder browser with an explicit preview and connection step. Whole-Drive token access is disclosed; only configured-folder files are synchronized. Both devices must reconnect once. Google Picker API remains enabled in the test project but is unused; billing remains unlinked. Broader consent and device tests are pending.
