# Install Drive Sync

Drive Sync uses the Google Drive API on both desktop and iPhone. Each device has its own local Obsidian vault, and Drive stores ordinary Markdown files in one dedicated folder. No hosted token broker or pairing service is required.

**0.2.1 is a development beta.** It syncs `.md` files up to 5 MB. Attachments and deletion propagation are not enabled. Use disposable vaults until the real-device tests and production OAuth review are complete. Keep the local vault outside Google Drive for desktop, iCloud, Dropbox, and other sync folders.

## Setup at a glance

1. Desktop: install BRAT, then install Drive Sync from GitHub.
2. Desktop: create your own Google OAuth client once, configure it, and sign in.
3. Desktop: choose **Create sync folder**.
4. iPhone: install BRAT and the same Drive Sync release.
5. Desktop: choose **Add device**. Scan the invitation on the phone and approve it on the Mac.
6. iPhone: sign in to Google. The paired folder then syncs automatically while Obsidian is open.

You do **not** install the GitHub app. BRAT downloads the release files directly. Google credentials are not included in the plugin; pairing transfers your client configuration and folder ID, and each device keeps its own Google tokens.

## Desktop installation

1. Install or update Obsidian; the plugin requires **1.12.7 or newer** and encrypted Keychain availability.
2. Create a new, empty local vault for testing.
3. Open **Settings → Community plugins**, enable community plugins, select **Browse**, and install/enable **BRAT**.
4. In BRAT settings, select **Add beta plugin** and enter:

   ```text
   https://github.com/patrickp2/obsidian-drive-sync
   ```

5. Select the published **0.2.1** prerelease and enable Drive Sync. If BRAT does not list it immediately, refresh its release list. This setup requires 0.2.1 or newer.

A GitHub account or personal access token is normally unnecessary for this public repository. If GitHub rate-limits BRAT, wait and retry. Plugins are installed per vault and per device. See [BRAT's guide](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md).

## Set up Google once, on desktop

The current implementation uses your own Google **Web application** OAuth client with PKCE. Desktop and iPhone sign-in work in testing, but production suitability of this client type is still under review. This setup does not make a client secret embedded on a device confidential.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a dedicated project. Leave billing unlinked.
2. In **APIs & Services → Library**, enable **Google Drive API**.
3. Configure **Google Auth Platform** branding and audience. For qualifying Workspace projects, **Internal** restricts sign-in to the organization. Personal Gmail users need **External**, with their account added as a test user while testing.
4. Use the scope `https://www.googleapis.com/auth/drive.file` in the consent/data-access configuration. Do not add whole-Drive access.
5. Create a **Web application** OAuth client. Add this exact **Authorized redirect URI**, including its trailing slash:

   ```text
   https://patrickp2.github.io/obsidian-drive-sync/
   ```

6. Leave Authorized JavaScript origins empty. No API key or service account is needed.
7. In **Obsidian → Settings → Drive Sync → Google project configuration**, enter the client ID. Under **Client secret**, create/select an Obsidian Keychain entry. Use `drive-sync-google-client` as its **ID/name**, and put the Google secret in its **Secret** field. The 64-character limit applies to the ID/name.
8. Choose **Sign in to Google**, complete consent, and select **Return to Obsidian** on the callback page.
9. Choose **Create sync folder**. The plugin creates `Obsidian Drive Sync - <vault name>` in My Drive and starts syncing the test vault's Markdown files. **Open folder in Drive** opens that exact folder.

External projects left in Testing commonly issue seven-day Drive refresh grants. A lasting installation needs an appropriate publishing/audience configuration and any applicable verification. See [Google's OAuth documentation](https://developers.google.com/identity/protocols/oauth2/web-server).

`drive.file` permits app-created or explicitly authorized files; it is not a folder-scoped token. The plugin separately limits its operations to the configured folder. Existing-folder import and access to files created outside the app are not assumed. See [Google's scope guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

## Install and pair iPhone

1. Install/update Obsidian. Create an empty local test vault with **Store in iCloud** off.
2. Install and enable BRAT through **Settings → Community plugins**.
3. In BRAT, add the same repository and select the same **0.2.1** release. Enable Drive Sync.
4. Put the Mac and phone on the same private local network. Keep desktop Obsidian open.
5. On desktop, open **Settings → Drive Sync → Add device**. A three-minute QR invitation appears.
6. On the phone, choose **Connect to existing device → Scan QR**. Scan the desktop QR, then choose **Approve device** on the Mac. All phone steps stay in one panel. **Take QR photo** is available if the live camera is unsupported; a one-time invitation paste is under the alternative options. No individual client fields need to be copied.
7. Allow local-network access if iOS requests it for this pairing. Guest networks or client isolation can prevent devices from reaching each other.
8. Continue through the Google step in the same panel. Sign into the same Google account and return to Obsidian. Devices already signed in skip this step. Choose **Done** at Setup complete.
9. Wait for **Synced with Drive**. Create a synthetic note on desktop, verify it arrives on the phone, edit it on the phone, and verify the edit returns to desktop before using any important data.

Encrypted pairing, configuration storage, and initial sync passed on the real iPhone with the external Camera handoff in 0.2.0. The 0.2.1 in-app live camera scan and step flow also passed on the real iPhone; after completion its connection and Synced with Drive status were verified. Its invitation contains a temporary pairing key, not Google credentials. Keep the QR/link private. Configuration is encrypted before crossing the local network; the listener expires after three minutes or when the desktop panel closes. Access/refresh tokens are never transferred. Closing the panel before completion cancels pairing.

## Everyday use

Edit local Markdown files normally. Automatic checks run after saved edits, when Obsidian resumes, and every 30 seconds while it is open. Desktop has a status-bar item; mobile has a visible status button. Tap status for details, **Sync now**, or **Pause**.

If both devices changed a note, both edits are preserved using an ordinary `name (conflict …).md` copy. Check the details panel when it reports attention is needed. Missing/deleted files are preserved for review in this beta; deleting on one device does not delete the other copy. Non-Markdown attachments are not transferred yet.

“Synced with Drive” means this device completed its last check. It does not mean another offline device has uploaded its work. iOS can suspend Obsidian in the background; reopening resumes checking. Quitting desktop Obsidian or sleeping the Mac also stops work.

## Google Drive for desktop

The Obsidian vault must remain outside the folder managed by Drive for desktop. The plugin already talks to Drive directly.

You can keep Drive for desktop for unrelated files. It may also show the plugin's cloud folder: **Mirror files** downloads a full additional local copy, while **Stream files** primarily keeps cloud files online and downloads/caches them as needed. That extra view is not the Obsidian vault. Do not point the plugin's vault at it or put two sync systems in charge of the same directory. [Google explains streaming and mirroring here](https://support.google.com/drive/answer/13401938?hl=en).

## Updates and troubleshooting

Update Drive Sync through BRAT on **each** device. A pinned version stays pinned until you select a newer release. Ordinary updates retain local settings and credentials; updating does not pair devices. Reopen Obsidian if the interface has not refreshed.

| Symptom | Action |
| --- | --- |
| Secret ID invalid / maximum 64 characters | Use `drive-sync-google-client` for the entry name. Put the client secret in the Secret field. |
| No browser opens on iPhone | Tap **Continue to Google** after sign-in preparation. |
| Sign-in does not match a pending request | Start a fresh sign-in on that device. Used callbacks and callbacks after app termination cannot be reused. |
| Browser cannot return to Obsidian | Copy the callback's return link and use **View details → Connection and diagnostics → Paste return link** within ten minutes, in the originating vault. |
| Redirect mismatch | Check the OAuth client type and exact redirect URL above. |
| Google rejects the account | Check the project's audience and test-user list. |
| Pairing expires or cannot connect | Use the same network, keep Add device open, check local-network permission, and create a fresh invitation. |
| Sync incomplete / duplicate name / moved file | Open status details. Existing content is preserved; resolve the reported issue before retrying. |
| Connected but no sync folder | Create the folder on desktop, then pair the phone to it. Google sign-in alone does not select a folder. |
| Access expires after about a week | Check whether your Google project is External and still in Testing. |

Disconnect attempts Google grant revocation and can require other devices using the project to reconnect. Credentials live in each device's [Obsidian SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage); they are not synchronized through vault files.

See [FEASIBILITY.md](FEASIBILITY.md) for evidence and remaining limits, and [DEVELOPMENT.md](DEVELOPMENT.md) for building and testing.
