# Development and test setup

## Build

Use Node.js 24 or newer, then:

```sh
npm ci --ignore-scripts
npm run check
```

The build produces `dist/drive-sync/main.js`, `manifest.json`, and `styles.css`, and regenerates `docs/index.html` from `src/callback.ts`. The generated HTML is tracked because Pages publishes `docs/` directly. Do not edit its bundled script manually: its CSP hash must match.

There are no runtime npm dependencies. The Obsidian API is supplied by the host application. Unit tests use synthetic strings only; tests never contact Google or read a vault. `npm run check` includes type checking, build, and authentication/callback tests.

## Disposable vault only

Create a new empty local vault outside other sync services. Copy only the three files in `dist/drive-sync/` into `<test-vault>/.obsidian/plugins/drive-sync/`. Enable that plugin in the test vault. The current build requires Obsidian 1.12.7 or newer and an available encrypted SecretStorage implementation. Do not deploy into real notes yet.

## Google setup

1. Create a dedicated Cloud project and verify **Billing → This project has no billing account**. Enable only the Google Drive API needed by this prototype.
2. Configure Google Auth Platform branding and the appropriate audience. For a personal Workspace project, Internal restricts sign-in to that organization. For External / Testing, add only the intended test account and expect Drive refresh grants to expire after seven days. Final publishing and verification depend on the chosen scopes and audience.
3. Create an experimental **Web application** OAuth client. Register this exact authorized redirect URI:

   `https://patrickp2.github.io/obsidian-drive-sync/`

   No JavaScript origin is needed: the callback performs no token exchange. Do not create an API key or service account for this flow.
4. In the plugin settings, enter the client ID and select/create the client secret in Obsidian Keychain. Never paste secrets into an issue, chat, repository file, or callback page. Configure each device separately.
5. Acknowledge authentication testing and choose Connect. Approve only the intended Google account and `drive.file` scope. This scope permits operations on app-created/explicitly selected files; the prototype itself performs no file operations.
6. Use the callback's Return to Obsidian button. If it cannot open the app, copy the return link and run **Drive Sync: Paste sign-in return link** on the originating device. The request expires after ten minutes and must still exist in that Obsidian process.
7. Confirm Connected, test refresh, restart Obsidian, and test again. Disconnect attempts Google grant revocation; this may also invalidate the same project's authorization on other devices. If offline, local credentials are cleared but server-side revocation is unconfirmed.

The Pages callback must be published before a real login test. Preparing it locally does not deploy it. Refer to `FEASIBILITY.md` for the unresolved client-type, storage, and API race checks. Sync remains disabled regardless of successful authentication.

## Current local setup

On 2026-10-04, dedicated Google Cloud project `obsidian-drive-sync-510621` was created under `patrickpeters.org` (the account cannot create projects outside an organization). Billing is unlinked, the Drive API is enabled, and Google Auth Platform uses an Internal audience. The experimental web OAuth client has been created with the exact callback URL. The disposable desktop vault is configured through encrypted Obsidian Keychain; live sign-in and refresh succeeded.

The callback was published to GitHub Pages in commit `5f4ab76` and passed both local and deployed browser smoke checks using synthetic parameters: it showed the fixed Obsidian return link, immediately cleared its query string, and displayed the normal start page on reload. Those smoke checks used no real authorization code. Subsequent live Google tests also succeeded. The disposable local vault is `test-vaults/drive-sync-auth` (ignored by Git); the compiled plugin is enabled there in Obsidian 1.13.7. Existing user vaults were not modified.

### Desktop live results (2026-10-04)

- The browser granted only `drive.file`; normal code exchange and direct refresh succeeded.
- SecretStorage reported encryption available. Plugin settings contained only the four expected non-secret configuration fields after sign-in.
- Refresh succeeded after plugin unload/reload and after a full reload of the test vault's renderer. A complete application quit/relaunch and real iPhone persistence are still separate checks.
- A callback without a vault target went to another open vault. The fixed callback binds the runtime vault ID into the random state and supplies `vault` to Obsidian. The repeated browser handoff then reached the correct vault. This runtime ID property is undocumented; if unavailable, the manual fallback remains.
- Reusing a consumed callback was rejected. This is expected and does not mean an existing connection is lost.
- Google rejected both a wrong verifier and a missing verifier with verifier-specific errors, each using a separate fresh code. The earlier sequence that attempted negative checks followed by a positive exchange on the same code was inconclusive; do not reuse that test sequence. Normal positive exchanges were verified separately.
- The existing refresh grant still worked after the negative checks. No Drive file requests were made.

The connection panel exposes the two PKCE checks for development. Each opens a fresh browser sign-in, saves no token from a rejected exchange, and labels generic errors inconclusive. If Google unexpectedly issues a token, the probe attempts revocation and clears the local grant. Do not run these checks on a production connection.

## iPhone installation through BRAT

The public GitHub prerelease `0.1.0` contains `main.js`, `manifest.json`, and `styles.css` as individual release assets. It includes no Google credentials or local vault settings.

1. Update Obsidian on iPhone and create an empty local vault named **Drive Sync Test**, with **Store in iCloud** off.
2. In that vault, open **Settings → Community plugins**, allow community plugins, then **Browse** and install/enable **BRAT**.
3. Open BRAT settings, choose **Add beta plugin**, and enter `https://github.com/patrickp2/obsidian-drive-sync`.
4. Select the specific version `0.1.0` for the first controlled test and enable the plugin after installation. No GitHub personal access token is needed for this public repository under normal rate limits.
5. Configure Google credentials separately through the phone's encrypted Obsidian Keychain. Do not transfer the Mac's plugin settings, refresh token, or full vault. Mobile storage availability and the browser handoff still need validation.

BRAT handles the plugin folder and downloaded files. iPhone Mirroring is optional for controlling the phone; it is not the installation mechanism. See [BRAT's developer guide](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md) for how releases are selected.
