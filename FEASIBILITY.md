# Authentication and synchronization feasibility

Checked on 2026-10-04. This records evidence and limits, not a claim of production readiness.

## Implemented and tested on desktop

The authentication-only prototype uses an external browser, a static HTTPS callback, random state, S256 PKCE, one-use callbacks with a ten-minute expiry, direct token exchange and refresh, and device-local Obsidian SecretStorage. It has no Drive file operations and cannot synchronize or delete notes. No existing plugin implementation was copied.

The callback forwards a code or a normalized error plus state, and an optional vault ID extracted from that validated state, to a fixed `obsidian://drive-sync-auth` handler. It removes the query from browser history immediately, has no remote resources or analytics, and blocks network requests with CSP. Its fallback copies the same short-lived return link. The host necessarily receives the initial callback URL; application code cannot control GitHub's platform access logs. No refresh token, client secret, or PKCE verifier reaches the callback page.

## OAuth: experimental web client flow

Google's [web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server) requires a client secret for token exchange/refresh and permits an exactly registered HTTPS redirect. Google's [native-app flow](https://developers.google.com/identity/protocols/oauth2/native-app) documents PKCE and platform-specific redirects. A desktop client cannot simply be assumed to support our GitHub Pages redirect; an Obsidian plugin cannot register a new native iOS URL scheme in Obsidian's app bundle.

The prototype accepts the user's own web client and uses PKCE in addition to its client secret. A secret stored in a distributed device app is not confidential client authentication. This is an explicit feasibility experiment, not an established production architecture. Live desktop testing with the dedicated client established normal code exchange, refresh, and rejection of wrong/missing verifiers using independent fresh codes. This does not establish production client-type suitability. Before adopting it, verify the iPhone flow and that the deployment complies with Google's client-type guidance. If this cannot be established, stop and reconsider authentication; no hosted broker has been authorized.

Do not distribute a shared client secret or include a developer's client configuration in the public bundle. Each user supplies their own project/client. Google authorization is completed in the user's browser, not an embedded webview. See [Google OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).

External projects in Testing issue short-lived refresh grants for Drive access (typically seven days). A lasting personal installation needs an appropriate audience/publishing configuration; do not describe weekly reconnection as seamless. Internal audience may be appropriate for a user's own Workspace organization, but does not permit unrelated Google accounts.

## Secret storage

Obsidian exposed SecretStorage in 1.11.4 and announced desktop encryption in [1.11.5](https://obsidian.md/changelog/2026-01-20-desktop-v1.11.5/). The locally installed 1.12.7 application code was inspected without accessing stored user secrets. Its desktop adapter uses Electron safeStorage, but contains a plaintext fallback when encryption is unavailable. The prototype therefore requires the runtime's encryption-availability check to return true. That method is not in the public TypeScript API; absence blocks authentication instead of silently weakening storage.

The same application bundle delegates mobile storage to a native SecureStorage adapter. This is evidence of its implementation path, not proof of the actual iPhone's keychain or backup behavior. Validate persistence and device isolation on the real iPhone before describing those guarantees as confirmed. No secrets are stored in plugin `data.json` or vault files.

The [public SecretStorage API](https://docs.obsidian.md/plugins/guides/secret-storage) exposes synchronous get/set operations, not an awaited durable-write acknowledgment. A read-back check detects an immediate failure but does not prove a disk write survived termination. Plugin reload and test-vault renderer reload both successfully restored the grant in Obsidian 1.13.7. Complete application restart and real-device tests remain required. Plugins share this store; it is not a security boundary against another malicious plugin. Disconnect blanks the plugin's refresh-token entry through the public setter; Obsidian Keychain can remove the empty entry. The user-supplied client-secret entry remains available for reconnecting.

Pending logins and access tokens stay in memory. If Obsidian is terminated during sign-in, the returning callback is rejected and the user starts again. A persisted refresh grant is used to reconnect after an ordinary restart.

## Drive permissions and overwrite protection

The prototype requests only `drive.file`. It makes no Drive file requests. This does not establish access to every descendant of a selected existing folder. Before adding sync, prove visibility of files created from both devices, including when their client IDs differ, and separately design any existing-folder import.

The [Drive file resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files) exposes checksums, a version, and a head revision. The current `files.update` reference does not establish the conditional-content-write behavior we need. A Google Calendar ETag example is not proof of Drive support. Test the exact Drive upload endpoint with competing writes before enabling replacement uploads. If Google does not reject a stale precondition, retain edits separately and revisit the storage design.

## Billing

Use a dedicated Google Cloud project without a linked billing account. Do not enable paid quota increases, compute, or a token broker. Standard [Drive API usage](https://developers.google.com/workspace/drive/api/guides/limits) is currently free; Google has announced a future paid tier above thresholds. Recheck before any billing change. The static callback uses GitHub Pages and is subject to its availability and rate limits.

## Required live checks

Release `0.1.0` was installed through BRAT 2.2.0 into the empty `Test` vault on the real iPhone on 2026-10-04. The settings opened successfully and displayed the Keychain selector: the runtime encryption-availability gate and a secret read both passed. The user entered the client configuration directly on the phone because Mirroring dropped keyboard input. The linked secret appeared in settings, and Connect successfully prepared an authorization request, establishing that the client ID passed format validation and a nonempty secret was readable. The external browser did not visibly open. Release `0.1.1` adds a separate mobile Continue to Google tap after asynchronous PKCE preparation so browser opening occurs within a fresh user gesture. That workaround still requires live verification. Mobile token exchange, secret persistence across restart, and the browser return remain unverified.

- Passed on desktop: exact HTTPS callback, correct token exchange, and isolated wrong/missing verifier rejection. Repeat the flow on iPhone.
- Passed on desktop: successful consent yields the required scope and a working refresh grant. Denial is unit-tested; live denial remains to check.
- Restart, refresh, revocation, logout, and reconnect work without exposing secrets.
- iPhone browser returns to the originating disposable vault; wrong or missing pending state is rejected.
- Actual mobile secret persistence/protection and interruption behavior are established.
- Conditional Drive writes and scope visibility are proven using synthetic files before sync is enabled.
