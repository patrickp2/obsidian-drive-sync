# Requirements and development handoff

## Goal

Build a small, understandable Obsidian community plugin that synchronizes local Mac and iPhone/iPad vaults with a folder in Google Drive. The same plugin uses the Drive API on both platforms. After initial setup, users should be able to use Obsidian normally without routine manual synchronization. Cryptomator is outside the scope.

The primary motivation is control over authentication, dependency footprint, and data safety. A custom implementation is not assumed safer merely because it is custom; prove its behavior with targeted tests and disposable vaults.

## Agreed direction

- Keep plugin source and the static OAuth callback in one public GitHub repository.
- Develop outside the Obsidian vault; copy only built plugin artifacts into test vaults.
- Use GitHub Pages for the HTTPS callback, without a paid domain or an always-running personal server.
- Each device connects to the user's Google account. Do not synchronize authentication state between devices through vault files.
- The plugin talks directly to Google for Drive operations and token refresh where the chosen OAuth flow permits it.
- Use the plugin on both Mac and mobile. The Mac vault lives outside folders managed by Google Drive for desktop, iCloud, or another sync service. Google Drive for desktop can continue handling unrelated folders. This replaces the earlier proposed mixed desktop-client/mobile-plugin architecture.
- Keep ordinary local Markdown files and attachments on both devices. Sync runs while the vault is open and the operating system permits execution; it is not an independent background service.
- Begin with a disposable vault, not real notes.

## Authentication architecture to validate first

1. User configures their own Google Cloud OAuth project/client in plugin settings.
2. Plugin creates a cryptographically random state value and PKCE verifier/challenge. Keep the verifier on the initiating device.
3. Open Google's authorization page in the external browser.
4. Google redirects to the exactly registered HTTPS GitHub Pages callback URL.
5. The callback relays only the short-lived authorization code and state to a registered `obsidian://` plugin handler, with a manual fallback if iOS blocks the app handoff.
6. The originating plugin strictly validates state, expiry, and the pending login before exchanging the code with Google.
7. Store refresh credentials per device and refresh access tokens directly with Google. Refresh normally does not visit the callback page.

Important feasibility question: Obsidian provides HTTP requests and custom protocol handlers, but not a Google OAuth exemption. Validate current Google client-type rules, PKCE support, token exchange requirements, and the iOS handoff end to end before committing to the implementation. A web client secret stored on a device cannot be treated as confidential. Do not publish a shared client secret or claim that PKCE removes Google's client-type requirements. A server-side token broker is not an agreed dependency; discuss any need for it before changing the architecture.

Use Obsidian's current secret-storage API if suitable on desktop and mobile. Verify actual persistence and protection guarantees, including availability in the chosen minimum Obsidian version. Do not silently fall back to plaintext plugin `data.json`. A client ID is a public identifier, but tokens and client secrets must not enter Git or Pages content.

The callback must have no analytics, third-party scripts, or outbound logging. Avoid rendering raw untrusted HTML or accepting arbitrary redirect targets. Remove code/state from browser history as soon as practical, use a no-referrer policy, and handle denied/expired authorization without leaking values. Support logout/revocation and preserve an existing refresh token when a successful refresh response omits a replacement.

Choose the narrowest Drive scope that supports the actual workflow. `drive.file` is preferable when feasible, but prove that each device can access the required folder and files under the chosen OAuth client configuration. Validate access to existing or externally created files if supporting import or external edits; do not assume selecting a parent folder grants access to all descendants. Do not promise folder-limited Google authorization when the scope grants broader access. Explain any broader scope clearly.

## Initial folder and permission boundary

Start with one dedicated folder created by the plugin, and use the same user-owned OAuth client on both devices. Request only `drive.file`; do not expand to whole-Drive access to simplify implementation. Prove cross-device visibility with disposable files. The plugin restricts its operations to the configured folder, while Google restricts the token to app-created/explicitly authorized files. These are different boundaries: the token is not a folder-scoped credential and can access other files already authorized to this app. Existing-folder import requires a separately validated per-file selection flow.

## Overwrite protection to validate before routine uploads

- Record a common baseline for each synchronized file, including its Drive identity and content fingerprint. Compare the current local content and current remote content against that baseline. A later timestamp alone must never decide which version wins.
- Drive exposes `md5Checksum`, optional `sha256Checksum`, a monotonically increasing `version` (including metadata changes), and `headRevisionId` for stored file content. These help detect changes; they do not themselves prevent an overwrite.
- Validate a server-enforced conditional write for the exact Drive content-upload method chosen. A read/check followed by an unconditional upload leaves a race in which another device can change the file between the check and write. Support for the required precondition has not yet been established.
- Do not enable automatic replacement uploads until stale-write protection is demonstrated. If that cannot be established, retain edits as separate files and revisit the storage design before promising seamless replacement sync. Rechecking a hash or relying on revision history alone is insufficient.
- Revalidate local content before applying downloaded changes, including edits made while a network request was in flight. Apply appropriate Obsidian APIs and preserve active editor changes.
- Using the same plugin on both devices gives us control over both clients, but does not by itself eliminate races or reveal edits that remain offline on another device.

Reference: https://developers.google.com/workspace/drive/api/reference/rest/v3/files

## Synchronization behavior

- Both vaults remain local and usable offline; Google Drive is the transport/storage service.
- Discover remote changes and compare local and remote versions against a recorded common baseline. A push must not treat the whole current local tree as an authoritative mirror.
- A remote file absent locally may be new, not deleted. Only propagate deletion with evidence of a prior synchronized file and an intentional deletion, accounting for incomplete scans and errors.
- Preserve both versions when both devices changed a file. Start with clear conflict copies instead of risky automatic text merging.
- Use Drive trash for remote deletions and a recoverable local mechanism. Do not use permanent delete for routine sync.
- Make partial failures, retries, interruption, expired sessions, and app restarts safe and idempotent. Commit sync state only after the associated operation succeeds.
- Avoid overlapping sync runs. Treat cancellation and iOS suspension as normal conditions.
- Handle attachments, nested folders, renames/moves, duplicate Drive names, and remote pagination deliberately. Document unsupported behavior rather than silently losing files.
- Avoid overwriting unsaved/actively edited buffers. Use appropriate Obsidian vault APIs and current state when applying incoming changes.
- Initial import and connecting to an existing folder must not overwrite or delete data merely because sync state is empty.
- Exclude `.obsidian`, credentials, plugin settings, local sync metadata, trash, and temporary files from the first version's synchronization. Configuration sync can be a separate future feature.
- Enable automatic sync by default after setup: check on vault open and app resume, debounce saved edits, periodically check remote changes, and retry temporary failures with backoff. Catch up after reconnection. Manual sync and pause remain secondary controls.
- Do not promise continuous iOS background execution. Persist pending work so interruption, locking the phone, or app suspension can be recovered from on return. On desktop, quitting Obsidian or sleeping the Mac interrupts execution.
- Surface conflicts and failures in plain language. Redact credentials, authorization codes, and note contents from routine diagnostics.

## Sync interface

- Routine use must not require opening settings or pressing Sync. Keep successful background activity quiet.
- Show a compact desktop status indicator and a mobile-visible indicator while editing. The precise supported placement on mobile must be prototyped and verified on a real iPhone; do not assume the desktop status bar exists there.
- States include checking, syncing, synced with Drive, offline with pending changes, paused, and needs attention. Show pending counts where known and the last successful check time. Do not show a stale successful state as current after a failed or incomplete check.
- Mark a synchronization successful only after its transfers are confirmed and the resulting state is recorded. “Synced with Drive” refers to this device and the last completed remote check; it cannot certify that another offline device has uploaded its edits.
- An accessible button or command opens a details panel with recent activity, pending work, errors, Sync now, and pause controls. Surface preserved conflicts for later review without blocking unrelated files.
- Reserve notifications for meaningful failures, reconnection requirements, and conflicts. Initial conflict handling preserves both versions; automatic text merging is a possible later feature, not a prerequisite for the first safe version.

## First milestones

1. Validate current official Obsidian and Google documentation for authentication, secret storage, Drive scope, and conditional content writes. Decide whether to reuse selected existing code, fork a project, or implement a small new core. No fork has been approved as the final choice; respect licenses for any reused code. Resolve feasibility before promising safe production sync.
2. Build an authentication-only vertical slice: sign in, callback, token exchange, refresh, sign out, and reconnect on Mac and iPhone. Do not enable sync yet.
3. Implement a sync planner independent of network/filesystem mutations, with tests for concurrent changes, stale copies, new files, and deletion evidence. Prove the selected remote write safeguard using disposable Drive files before enabling replacement uploads.
4. Add Drive and Obsidian adapters, dry-run/change preview for development, explicit initial connection behavior, automatic scheduling, and sync status UI. Test with synthetic data on desktop, including mobile UI emulation.
5. Validate the full Mac plugin to Drive to iPhone plugin to Mac cycle in separate disposable vaults, including offline edits, in-flight races, suspension, interruption, and restarts. Use a real iPhone for browser handoff and lifecycle tests. iPhone Mirroring may support guided or automated interaction if verified with the available tools; it is not an assumed capability. Document installation and mobile plugin update steps.

## Acceptance checks

- A new Mac note arriving in Drive while the phone is open is downloaded or preserved; the phone never deletes it merely because it has not pulled it.
- Offline edits to the same note on Mac and phone preserve both versions and report the conflict.
- A phone holding baseline A cannot silently replace remote B with edits C derived from A, even if C has a later save time. The reverse direction has the same protection.
- A competing remote write between metadata inspection and upload cannot be silently overwritten. A local edit during a download is preserved.
- Normal edits synchronize automatically after setup while execution and connectivity permit; temporary failures recover without manual Sync.
- The iPhone shows unfinished work while Obsidian is visible. Reopening after suspension resumes pending work and refreshes status without falsely showing the previous session as current.
- A missing/failed/partial directory listing never causes mass deletion.
- Confirmed deletions are recoverable and do not erase independently edited files without conflict handling.
- Restarting during upload/download, a failed request, or repeated retries does not corrupt content or create uncontrolled duplicates.
- Initial connection to a populated Drive folder and to a populated local vault preserves existing data.
- Access-token expiry refreshes without a new browser login when the refresh grant remains valid; revoked grants produce a clear reconnect flow.
- Callback requests with missing, incorrect, expired, or reused state are rejected. The PKCE verifier never leaves the originating plugin except for Google's token exchange.
- No token/client secret enters Git, Pages assets, synced vault settings, URLs to unrelated services, or diagnostic logs.
- Verify the behavior on an actual iPhone; desktop mocks alone do not establish mobile compatibility.

## Prior research and limits

Tether already demonstrates an Obsidian/Google Drive integration with a static GitHub Pages OAuth callback and direct Google requests. GDSync is another reference for mobile authentication. References are evidence to inspect, not code automatically authorized for copying:

- https://github.com/Llewellyn500/obsidian-tether
- https://github.com/surblue-git/gdsync
- https://docs.obsidian.md/
- https://developers.google.com/identity/protocols/oauth2
- https://developers.google.com/workspace/drive/api/guides/about-sdk

Prior source inspection of Tether v1.0.16 at commit `28dd18632b3d54602143d1ee915ef06036c55e3a` identified paths that mirror local absence into remote deletion, use permanent Drive deletion, and overwrite ordinary notes during concurrent edits. Those findings were not reproduced on a device. Reassess upstream changes before relying on them; do not import those behaviors.

## Current state

An authentication-only prototype is built, tested, and published with its static callback. In a disposable desktop vault on Obsidian 1.13.7, live sign-in, vault-specific handoff, encrypted secret-storage availability, direct refresh, and recovery after plugin/vault reload passed. Google rejected wrong and missing PKCE verifiers with separate fresh codes. Unit tests cover state/replay checks and failure handling. No Drive file requests or synchronization operations exist yet. See `FEASIBILITY.md` and `DEVELOPMENT.md` for the remaining actual iPhone, production client-type, full application restart, live revocation, Drive scope visibility, and conditional-write checks. No real vault should be modified during this phase.
