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

Current beta limits: Markdown only, at most 5 MB per note; attachments are not transferred; intentional deletions and remote moves are preserved for review rather than propagated automatically. Concurrent creation of duplicate Drive folder/file names stops reconciliation for review. No initial import of arbitrary pre-existing Drive folders is implemented. Do not use this beta on important notes yet.

## Authentication

External browser, random state, S256 PKCE, ten-minute one-use callbacks, static HTTPS redirect, direct token exchange/refresh, and device-local SecretStorage are implemented. Both desktop and actual iPhone sign-in and refresh passed. iPhone access automatically restored after force-closing and relaunching Obsidian. Desktop plugin/vault reload recovery passed. Wrong/missing PKCE verifiers were rejected in separate fresh-code desktop tests. Unit tests cover denial, replay, revocation handling, refresh retry, and interruption races.

The callback removes its query from browser history, relays only code/error and state to a fixed Obsidian handler, has no analytics or remote resources, and blocks requests with CSP. No client secret, verifier, or refresh token goes to the callback page. Its host necessarily receives the initial callback URL; we cannot control GitHub platform access logs.

Production suitability of using a user's Google Web application client on a device remains unresolved. Successful OAuth tests do not make device-stored secrets confidential client authentication. Each user owns/configures their project; no shared developer credentials are bundled. A hosted broker is not authorized. See [Google's native-app guidance](https://developers.google.com/identity/protocols/oauth2/native-app) and [OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).

External Google projects in Testing commonly issue seven-day Drive refresh grants. Appropriate audience/publishing configuration is required for lasting use. Internal audience restricts accounts to the qualifying Workspace organization.

## Pairing and storage

Add device now creates a temporary desktop listener bound to a private IPv4 interface. Its three-minute QR invitation carries a random 256-bit pairing key. AES-GCM authenticates/encrypts each direction with the session ID and direction bound as associated data; a request nonce binds the response. Desktop approval and one-use consumption are required. Configuration transfer includes the client ID, client secret, and Drive folder ID only. Tokens and pending OAuth state never transfer. Closing the panel, unloading, or expiry closes the listener. The QR/link must remain private. No hosted relay is involved.

Cryptographic tests cover wrong keys/sessions, reflected envelopes, replayed responses, and invalid endpoints. A real local-network listener round trip on the Mac passed with synthetic credentials. Actual iPhone QR handoff, local networking, and paired configuration storage are not yet verified.

SecretStorage's runtime encryption-availability gate passed on the actual desktop/iPhone. The plugin fails closed if that undocumented check is absent or false. The public SecretStorage API has no awaited durable-write acknowledgment: immediate read-back plus restart testing provides evidence, not a universal backup/isolation guarantee. Plugins share the store, so it does not isolate secrets from malicious plugins. No Google secret/token is written to vault/plugin JSON or source/release assets.

## Permissions, billing, and remaining gates

Only `drive.file` is requested. The plugin restricts operations to the dedicated app-created root, but the Google token itself is not folder-scoped. It does not automatically authorize every file created externally inside that folder. Real cross-device visibility must be tested with each device's independent grant and the same OAuth client.

The dedicated test Google project has no linked billing account. No paid compute or hosted pairing/token service was created. Recheck [Drive API billing/limits](https://developers.google.com/workspace/drive/api/guides/limits) before enabling paid services or expanding usage.

Remaining gates include actual iPhone pairing and edit cycles, mobile conditional uploads, full desktop application restart, additional live denial/revocation/interruption tests, production OAuth suitability, attachment support, recoverable deletion/rename reconciliation, and broader stress testing. A successful connection or one conditional-write test alone is not full production readiness.
