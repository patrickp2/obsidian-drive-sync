# Feasibility and test evidence

Updated 2026-10-04. The design is API access on both desktop and mobile, with ordinary Markdown files in Google Drive. The user explicitly rejected an immutable revision-record format and a hosted authentication/pairing service.

## Conditional writes: live result

The v3 `PATCH /upload/drive/v3/files/{id}?uploadType=media` experiment uploaded and downloaded synthetic Markdown correctly, but returned no strong metadata/content ETag. A deliberately nonmatching `If-Match` was accepted with HTTP 200 and replaced the disposable content. This endpoint is not used for replacement writes.

The alternative **v2** `PUT /upload/drive/v2/files/{id}?uploadType=media` passed the actual desktop test using the file's v2 metadata ETag:

1. Upload/download baseline A, including Unicode.
2. Save B with A's current ETag; verify B, a new ETag, and an advanced version.
3. Try C with the stale A ETag: **HTTP 412**, with B still intact.
4. Try C with the current B ETag: **HTTP 200**, C downloaded correctly.
5. Move all disposable probe resources to Drive trash. Nothing permanently deleted.

The sync adapter uses v3 for folder discovery, creation, and downloads; replacement writes use the tested v2 endpoint and a mandatory strong `If-Match`. There is no unconditional replacement fallback. Reads compare ETags before and after downloading to reject inconsistent snapshots. File name and parent checks prevent a moved file from silently leaving the configured folder boundary. See Google's [v2 update reference](https://developers.google.com/workspace/drive/api/reference/rest/v2/files/update).

## Markdown synchronization

Implemented: per-device common baselines, automatic scheduling, conditional uploads, atomic guarded local text updates, content-preserving conflict copies, idempotent file-create retries with reserved Drive IDs, complete paginated folder listings, and duplicate-name detection. The Drive folder contains normal Markdown files and normal conflict copies.

Core tests cover desktop-to-phone-to-desktop edits using two independent simulated stores, concurrent offline edits, a competing remote write between read and upload, local edits during download, interrupted uploads/restarts, failed listings, and initial files with differing content. These tests are necessary but do not substitute for two real devices.

The real desktop test vault `drive-sync-auth` created its dedicated Drive folder and uploaded `README.md` and `Sync test.md` automatically. Further real-device results belong in DEVELOPMENT.md.

Version 0.3.0 adds byte-preserving attachments (20 MB/file), baseline-bound folder identity, persistent rename intent, version-guarded v2 metadata moves/trash, and local recovery copies. A 404 or move outside the configured tree never triggers local deletion. Version comparisons avoid downloads for unchanged content. Version 0.4.0 selects existing folders directly and discovers externally added files using full Drive authorization. Empty folders are not synchronized. Use disposable vaults until broader live tests pass.

The same v2 conditional-write probe also passed on the real iPhone in 0.2.1: baseline Unicode round trip, current-ETag write, stale-ETag HTTP 412 with newer content preserved, then successful fresh-ETag write. Its temporary resources were moved to Drive trash.

## Authentication

External browser, random state, S256 PKCE, ten-minute one-use callbacks, static HTTPS redirect, direct token exchange/refresh, and device-local SecretStorage are implemented. Both desktop and actual iPhone sign-in and refresh passed. iPhone access automatically restored after force-closing and relaunching Obsidian. Desktop plugin/vault reload recovery passed. Wrong/missing PKCE verifiers were rejected in separate fresh-code desktop tests. Unit tests cover denial, replay, revocation handling, refresh retry, and interruption races.

The callback removes its query from browser history, relays only code/error and state to a fixed Obsidian handler, has no analytics or remote resources, and blocks requests with CSP. No client secret, verifier, or refresh token goes to the callback page. Its host necessarily receives the initial callback URL; we cannot control GitHub platform access logs.

Production suitability of using a user's Google Web application client on a device remains unresolved. Successful OAuth tests do not make device-stored secrets confidential client authentication. Each user owns/configures their project; no shared developer credentials are bundled. A hosted broker is not authorized. See [Google's native-app guidance](https://developers.google.com/identity/protocols/oauth2/native-app) and [OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).

External Google projects in Testing commonly issue seven-day Drive refresh grants. Appropriate audience/publishing configuration is required for lasting use. Internal audience restricts accounts to the qualifying Workspace organization.

## Pairing and storage

Add device now creates a temporary desktop listener bound to a private IPv4 interface. Its three-minute QR invitation carries a random 256-bit pairing key. AES-GCM authenticates/encrypts each direction with the session ID and direction bound as associated data; a request nonce binds the response. Desktop approval and one-use consumption are required. Configuration transfer includes the client ID, client secret, Drive folder ID, and a vault display name. Tokens and pending OAuth state never transfer. Closing the panel, unloading, or expiry closes the listener. The QR/link must remain private. No hosted relay is involved.

Cryptographic tests cover wrong keys/sessions, reflected envelopes, replayed responses, and invalid endpoints. A real local-network listener round trip on the Mac passed with synthetic credentials. Actual iPhone external-Camera QR handoff, local networking, desktop approval, paired configuration storage, and initial Markdown download passed in 0.2.0. Phone edits reached the Mac, Mac replies reached the phone, and independent edits after pausing the phone preserved both branches; the conflict copy also reached the Mac. Version 0.2.1 replaces stacked pairing dialogs with a single step flow and local QR scanning; the user completed an in-app live QR scan on the real iPhone, and the connected, automatically syncing state was verified afterward.

SecretStorage's runtime encryption-availability gate passed on the actual desktop/iPhone. The plugin fails closed if that undocumented check is absent or false. The public SecretStorage API has no awaited durable-write acknowledgment: immediate read-back plus restart testing provides evidence, not a universal backup/isolation guarantee. Plugins share the store, so it does not isolate secrets from malicious plugins. No Google secret/token is written to vault/plugin JSON or source/release assets.

## Permissions, billing, and remaining gates

Version 0.4.0 requests `drive` (whole-Drive access), approved by the user for automatic discovery of externally added files. The plugin operates within the configured folder; this is not a token-level security boundary. Each device needs its own grant containing the full scope. Previously saved insufficient grants require reconnection before any Drive requests. No Google Picker flow remains.

The dedicated test Google project has no linked billing account. No paid compute or hosted pairing/token service was created. Recheck [Drive API billing/limits](https://developers.google.com/workspace/drive/api/guides/limits) before enabling paid services or expanding usage.

Remaining gates include full desktop application restart (deferred by the user), controlled radio/network outage testing, production OAuth suitability (deferred by the user), and completion of the three-day soak. Real revoked-grant recovery and controlled iPhone termination after successful upload/download responses passed in 0.5.x. The phone verified all 259 synthetic files (11,604,562 bytes, including two 5 MiB attachments) by SHA-256 with no extra files. Native network-loss errors occurred during this run; bounded GET retries were added in 0.5.2. This is evidence from one device/network run, not a broad performance guarantee. Real-vault attachment replacement, note/folder moves, recoverable deletions in both directions, iPhone restart catch-up, external-file discovery, and second-desktop-vault existing-folder selection passed in 0.4.1; see DEVELOPMENT.md. Automated fault tests and a 2,000-file simulation pass; these do not establish iOS suspension behavior. A successful connection or one conditional-write test alone is not full production readiness.

## 0.3.0 desktop lifecycle evidence (2026-10-04)

The Obsidian-hosted probe used the actual DriveStore and requestUrl transport against two synthetic roots. Identical paths remained isolated. Multipart binary creation and replacement preserved all byte values. Stale binary replacement, rename/parent move, and trash each returned HTTP 412. Current rename/move retained the ID and bytes; current trash was confirmed by metadata and absence from a complete listing. The other root was unchanged. All probe resources were moved to Drive trash.

Google Picker API was enabled in the dedicated test project with user approval. No billing account was added. Google currently documents standard Drive API use at no additional cost and planned future charges above included usage thresholds; check the linked limits page before changing billing or quotas.
