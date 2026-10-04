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

On 2026-10-04, dedicated Google Cloud project `obsidian-drive-sync-510621` was created under `patrickpeters.org` (the account cannot create projects outside an organization). Billing is unlinked, the Drive API is enabled, and Google Auth Platform uses an Internal audience. The experimental web OAuth client has been created with the exact callback URL. Secure device configuration and live authentication remain pending.

The generated callback passed a real browser smoke check using synthetic parameters: it showed the fixed Obsidian return link, immediately cleared its query string, and displayed the normal start page on reload. No real authorization code was used. The disposable local vault is `test-vaults/drive-sync-auth` (ignored by Git); compiled plugin files are copied there and the vault was opened in Obsidian 1.13.7 in Restricted Mode. The plugin has not yet been enabled.
