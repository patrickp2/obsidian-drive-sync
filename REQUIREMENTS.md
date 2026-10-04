# Requirements and development handoff

## Goal

Build a small, understandable Obsidian community plugin that synchronizes a local iPhone/iPad vault with a folder in Google Drive. A Mac uses a local vault managed by Google Drive for desktop. Cryptomator is outside the scope.

The primary motivation is control over authentication, dependency footprint, and data safety. A custom implementation is not assumed safer merely because it is custom; prove its behavior with targeted tests and disposable vaults.

## Agreed direction

- Keep plugin source and the static OAuth callback in one public GitHub repository.
- Develop outside the Obsidian vault; copy only built plugin artifacts into test vaults.
- Use GitHub Pages for the HTTPS callback, without a paid domain or an always-running personal server.
- Each device connects to the user's Google account. Do not synchronize authentication state between devices through vault files.
- The plugin talks directly to Google for Drive operations and token refresh where the chosen OAuth flow permits it.
- Keep the Mac's normal Google Drive desktop workflow. Do not run two sync engines against the same local vault at once.
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

Choose the narrowest Drive scope that supports the actual workflow. `drive.file` is preferable when feasible, but prove it can access all required files, including files created by Google Drive desktop inside the selected folder. Do not promise folder-limited Google authorization when the scope grants broader access. Explain any broader scope clearly.

## Synchronization behavior

- The mobile vault remains local and usable offline; Google Drive is the transport/storage service.
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
- Provide manual sync, visible last successful sync/status/errors, pause, and configurable automatic sync while Obsidian is active. Consider sync on resume and debounced edits. Do not promise continuous iOS background execution.
- Surface conflicts and failures in plain language. Redact credentials, authorization codes, and note contents from routine diagnostics.

## First milestones

1. Read current official Obsidian and Google OAuth documentation. Decide whether to reuse selected existing code, fork a project, or implement a small new core. No fork has been approved as the final choice; respect licenses for any reused code.
2. Build an authentication-only vertical slice: sign in, callback, token exchange, refresh, sign out, and reconnect on Mac and iPhone. Do not enable sync yet.
3. Implement a sync planner independent of network/filesystem mutations, with tests for concurrent changes, new files, and deletion evidence.
4. Add Drive and Obsidian adapters, dry-run/change preview, and explicit initial connection behavior. Test with synthetic data.
5. Validate the full Mac Drive desktop to mobile to Mac cycle, including offline edits and restarts. Document installation and mobile plugin update steps.

## Acceptance checks

- A new Mac note arriving in Drive while the phone is open is downloaded or preserved; the phone never deletes it merely because it has not pulled it.
- Offline edits to the same note on Mac and phone preserve both versions and report the conflict.
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

This repository contains planning documents and a Pages placeholder only. There is no plugin build, Google OAuth configuration, credential storage, operational callback, or tested synchronization engine yet. The next development chat should read these requirements and establish the first milestone before modifying any live vault.
