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

The user approved full Drive authorization for seamless existing-folder sync and external additions. Version 0.4.0 removes Picker/import code and provides an in-plugin folder browser with an explicit preview and connection step. Whole-Drive token access is disclosed; only configured-folder files are synchronized. Both devices must reconnect once. Google Picker API remains enabled in the test project but is unused; billing remains unlinked. Full-Drive consent completed on both the Mac and real iPhone in 0.4.0; both reported Connected to Google. The desktop recovered the interrupted rapid rename with unique file IDs and an empty rename journal. Further lifecycle checks are recorded below.

## Hidden recovery storage regression

The real iPhone in 0.4.0 stopped an incoming rename with “Folder already exists.” Obsidian excludes hidden `.trash` folders from its indexed Vault API. Version 0.4.1 checks physical folders through the storage adapter, reads hidden backup bytes through the adapter, and restores hidden sources through the adapter. Visible note operations still use the Vault API. Three regression tests cover consecutive moves/removals with pre-existing hidden trash, restoring a late binary edit, and occupied/invalid recovery paths. All 80 tests and the build credential scan pass. Real-device verification passed as recorded below.


## 0.4.1 real-vault lifecycle evidence, 2026-10-04

Both test devices run 0.4.1 with independent full-Drive grants. Google Cloud data-access configuration also shows the full Drive scope saved.

- A synthetic Markdown file uploaded through Drive web reached the Mac and iPhone automatically. Renaming it on the iPhone propagated to the Mac with the same Drive file ID. The Mac's hidden recovery copy matched the original bytes.
- Replacing a PNG on the Mac preserved its Drive ID; the new purple/cyan image rendered in the iPhone note. Renaming its parent folder on the Mac moved all supported files with stable IDs; the phone received the new paths and rendered the attachment there.
- A Mac note deletion reached the phone. A separate iPhone note deletion reached the Mac after an immediate phone force-close/relaunch; the deleted note stayed absent and the Mac recovery copy matched its original SHA-256. A note created on the Mac while the phone was closed appeared in the phone file list after relaunch. No new sign-in was needed.
- A transient iPhone “network connection was lost” error cleared on automatic retry. This was an observed network failure, not a controlled mid-transfer interruption test.
- Obsidian's existing hidden trash no longer blocked incoming renames. Mac rename and propagated deletion recovery copies were verified byte-for-byte.
- The in-plugin folder browser listed a synthetic folder created through Drive web, navigated into it, and previewed its name, local vault name, folder ID, and one existing supported file. Connecting it to a second desktop vault downloaded that file byte-for-byte and uploaded a local synthetic note. The two vaults have different instance IDs, folder IDs, baselines, and file IDs; neither received the other's files. Keychain configuration had to be added separately in the second vault; Google tokens were not copied.

Remote moves can close a currently open old-path note; reopen its new path. Empty old directories are retained because empty-folder synchronization is outside the current implementation. Controlled mid-transfer termination/network tests, live revoked-grant recovery, and large real-network stress remain unverified. Production OAuth review remains deferred by the user.

## 0.4.2 mobile status startup

After a cold iPhone launch, the engine synchronized correctly but the floating status button was absent. The button is now attached after Obsidian reports its workspace layout ready, instead of during plugin loading. Unloading before layout readiness prevents delayed setup. All 80 tests, type checking, build, and credential scan pass; BRAT installed 0.4.2 on the real iPhone. After app-switcher force-close/relaunch, the floating status button remained visible and opened its details panel, which reported Synced with Drive and successful Google refresh. Both desktop test vaults reloaded 0.4.2 and resumed syncing. A full desktop application quit/relaunch remains pending because a real user workspace was also open. Published asset SHA-256 digests matched the local build.

## 0.5.0 desktop setup reuse

A new desktop vault can discover configured open vaults over the same-origin BroadcastChannel. A fresh P-256 ECDH exchange binds both vault identities/names, both public keys, and a random request ID into AES-GCM additional data and a matching approval code. The source must approve the code before reading or sending client configuration. Only client ID and client secret are transferred; tokens, folder identity and sync state are excluded. Requests expire after two minutes, cancellation/unload aborts approval, and closing the receiving panel discards late responses. This does not isolate credentials from malicious Obsidian plugins; those already share the app's trust boundary. No file, clipboard or network listener carries the transfer.

The live Mac flow discovered drive-sync-auth from a new drive-sync-reuse vault, displayed matching codes, completed source approval, saved the destination's Keychain configuration, and left it disconnected with no folder. Automated checks cover encrypted-only transport, exclusion of unrelated state, cancellation, unload, denial, expiry, tampering and replay.

Developer synthetic validation adds a manifest checksum checker and one-shot transfer barriers. A barrier holds a successful real Google content response before the engine can checkpoint it, enabling deterministic app-termination tests. It requires a synthetic fixture manifest and explicit arming; it logs no token, request body or response content, is never armed at startup, and times out after two minutes. Tests cover content-only matching, error responses, cancellation and byte validation. All 87 tests and build credential scanning pass. Live interruption/revocation/larger-vault outcomes are recorded after execution.

### 0.5.0 live validation, 4 October 2026

Revoked the Google grant using the isolated existing-folder vault's Disconnect control. The other desktop vault and real iPhone independently reported “Reconnect Google”; all ten original desktop fixture files retained their SHA-256 checksums. Saved a new local note during revoked access. After reconnection, its Drive baseline appeared and the note arrived on iPhone. This exercised a real invalidated grant, not a mocked error. The other desktop grant was reconnected and resumed automatic sync; it reported Synced with Drive.

Published release assets match local SHA-256 digests. Installed 0.5.0 through BRAT on the real iPhone. Started 259 synthetic fixture files (11,604,562 bytes including two 5 MiB binary attachments); completion and phone checksums are pending. Actual iPhone force-close tests reached held successful upload and download responses and relaunched; final convergence remains under observation.

The reused-configuration vault subsequently completed a fresh Google sign-in without manual credential entry, created its own third Drive folder, and uploaded its own synthetic note. The three roots and per-vault identities remain distinct.

### 0.5.1 status diagnostics

Live interruption testing exposed a display issue: filesystem events during backoff could replace a reconnect/retry message with Changes pending. Scheduling and resume now retain the actionable state. Download errors include the affected vault path while preserving StaleWrite handling. These changes do not alter overwrite decisions or retry delays. All 87 checks and the build credential scan pass.

The 259-file batch fully uploaded on the Mac: every local fixture SHA-256 matched its confirmed Drive baseline, all baseline Drive IDs were unique, and pending create/delete/rename/move journals were empty. The phone-origin note from the held upload arrived exactly once, with 103 bytes and the expected SHA-256. The phone encountered intermittent native “network connection was lost” errors during small-note downloads and continued to make progress after retries. 0.5.1 identifies the affected path; final phone checksum verification is pending.

### 0.5.2 bounded native read retry

The larger iPhone run encountered repeated native transport exceptions on ordinary small-note reads, advancing between failures but reaching long whole-cycle backoff. Native GET transport exceptions now receive at most two short retries (250 ms then 1 s), before the existing whole-cycle backoff. HTTP responses are not retried by this helper; writes are never replayed by it, and unload prevents further attempts. Read snapshot ETag checks remain intact. Two regression tests cover read recovery, bounded failure, unload, HTTP responses, and no automatic write replay. All 89 tests and the build credential scan pass.

A bounded three-day follow-up checks the disposable fixture every twelve hours until 2026-10-08T01:10:33Z. The helper scripts/soak-check.mjs verifies fixture bytes and saved desktop baselines and can make twelve small synthetic note edits per round. It does not treat desktop checkpoints as proof of current phone bytes. Phone verification remains a separate real-device check; the full Mac restart remains deferred.


### 0.5.2 completed recovery and initial stress evidence

Installed 0.5.2 through BRAT on the real iPhone and copied/reloaded it in all three disposable desktop vault windows. The full desktop application and real user workspace were not restarted. Published asset SHA-256 digests matched the tested local build.

At 18:16 PDT on 4 October, the phone validator reported **PASS: 259 files, 11,604,562 bytes, all SHA-256 checksums match; no extra files**. This completed recovery from both controlled app-termination tests: a held successful Google upload before local checkpoint, and a held successful download before local checkpoint. The uploaded note reached the Mac exactly once with its original 103 bytes and a single Drive ID. Editing it on the phone afterward reached the Mac under that same ID; a subsequent Mac reply appeared in the phone editor at 18:18, with Synced with Drive visible.

The controlled failures terminated the app at a deterministic response/checkpoint boundary. They did not toggle the phone's radio or prove every possible mid-stream failure. Actual native network-loss exceptions were also observed during the larger run. Their repeated whole-cycle backoff motivated the bounded read retry in this release.

The first soak round changed twelve existing notes and their checksum manifest at 18:16:52 PDT. All 259 desktop fixture hashes matched the updated confirmed Drive baselines by 18:17:32; pending journals were empty, and all 268 total baseline file IDs were unique. The iPhone was backgrounded and resumed, then showed the new Mac reply and Synced with Drive. After a Mirroring input interruption, the user ran the validator directly on the phone and the mirrored result was independently inspected at 18:21: **PASS: 259 files, 11,605,042 bytes, all SHA-256 checksums match; no extra files**. The increased byte count matches the twelve appended edit markers. Both the initial batch and the first repeated-edit round are verified on the actual phone.

All three desktop vaults remain enabled with separate Drive roots and identities (268, 2, and 1 baseline files). The newly reused setup completed its own Google sign-in and isolated upload. The three-day soak is running, not passed; its first edit round is recorded in the ignored test-vaults/.drive-sync-soak.json log. Full Mac restart, a controlled radio/network outage, and production OAuth suitability remain outstanding or deferred as described in FEASIBILITY.md.
