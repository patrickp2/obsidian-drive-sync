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
- Pairing: authenticated encrypted transfer, wrong-key/session rejection, reflection/replay rejection, private endpoint validation, and configuration-only import.
- Drive adapter: mandatory ETag conditions, v2 upload path, moved-file rejection, consistent downloads, and full/duplicate-free pagination.
- Sync engine: independent device stores, common baselines, conflicts, stale uploads, local edits during downloads, interrupted creates, restart recovery, missing files, and failed listings.

Unit tests contain synthetic data only and make no Google requests. The separate **Drive Sync: Developer: test disposable Drive files** command performs live API checks using a fresh disposable folder and Markdown note. It tests current/stale/fresh ETags on the exact v2 media upload endpoint and trashes only resources it created. It never permanently deletes files or reads vault notes. Keep the app open through cleanup; a connection drop or termination can leave the named disposable folder for manual review.

## Real-device evidence, 2026-10-04

The desktop vault is `test-vaults/drive-sync-auth` (ignored by Git), running Obsidian 1.13.7. The phone vault is `Test`, originally empty. Real user vaults were not modified.

- Desktop: browser sign-in, vault-specific handoff, direct refresh, plugin/vault reload recovery, and separate wrong/missing PKCE rejection passed.
- iPhone: external Chrome launch, user-completed OAuth return, direct refresh, and automatic refresh after app-switcher force-close/relaunch passed.
- Drive: v3 media PATCH ignored the deliberately nonmatching precondition; v2 media PUT rejected the stale ETag with 412 and preserved content. Current ETags succeeded. Probe resources were moved to trash.
- Pairing: a temporary listener bound to the Mac's private network interface successfully transferred synthetic configuration through the actual encrypted request/response path. iPhone pairing remains to test.
- Desktop sync: the current engine created the dedicated Drive folder, uploaded the synthetic README and Sync test notes, and recorded confirmed baselines. Further mobile and conflict results must be recorded after they run.

## Release

Use matching version numbers in package.json, manifest.json, and the release tag. Run checks and credential scanning before publishing. Attach `main.js`, `manifest.json`, and `styles.css` separately to the GitHub prerelease; BRAT downloads those assets. Do not overwrite older release assets. Update both devices through BRAT or copy built artifacts only into the desktop test vault.

Do not mark the beta production-ready: current limits and remaining gates are in [FEASIBILITY.md](FEASIBILITY.md). Source-level tests do not establish real iOS lifecycle/network behavior. Deletions and attachments remain disabled until their separate protection paths are implemented and tested.
