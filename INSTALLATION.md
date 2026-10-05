# Install Drive Sync

Drive Sync uses the Google Drive API on both desktop and iPhone. Each device has its own local Obsidian vault, and Drive stores ordinary Markdown files in one dedicated folder. No hosted token broker or pairing service is required.

**0.5.2 is a development beta.** It syncs ordinary notes and attachments up to 20 MB each. Moves and deletions use version checks and recoverable trash. Use disposable vaults until the real-device tests and production OAuth review are complete. Keep the local vault outside Google Drive for desktop, iCloud, Dropbox, and other sync folders.

## Setup at a glance

1. Desktop: install BRAT, then install Drive Sync from GitHub.
2. Desktop: create your own Google OAuth client once, configure it, and sign in.
3. Desktop: choose **Choose existing folder** or **Create sync folder**.
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

5. Select the published **0.5.2** prerelease and enable Drive Sync. If BRAT does not list it immediately, refresh its release list. This setup requires 0.5.0 or newer.

A GitHub account or personal access token is normally unnecessary for this public repository. If GitHub rate-limits BRAT, wait and retry. Plugins are installed per vault and per device. See [BRAT's guide](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md).

## Set up Google once, on desktop

The current implementation uses your own Google **Web application** OAuth client with PKCE. Desktop and iPhone sign-in work in testing, but production suitability of this client type is still under review. This setup does not make a client secret embedded on a device confidential.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a dedicated project. Leave billing unlinked.
2. In **APIs & Services → Library**, enable **Google Drive API**. No billing account is needed for this setup.
3. Configure **Google Auth Platform** branding and audience. For qualifying Workspace projects, **Internal** restricts sign-in to the organization. Personal Gmail users need **External**, with their account added as a test user while testing.
4. Use the scope `https://www.googleapis.com/auth/drive` in the consent/data-access configuration. This grants access to all Drive files; the plugin limits synchronization to the folder you select.
5. Create a **Web application** OAuth client. Add this exact **Authorized redirect URI**, including its trailing slash:

   ```text
   https://patrickp2.github.io/obsidian-drive-sync/
   ```

6. Leave Authorized JavaScript origins empty. No API key or service account is needed.
7. In **Obsidian → Settings → Drive Sync → Google project configuration**, enter the client ID. Under **Client secret**, create/select an Obsidian Keychain entry. Use `drive-sync-google-client` as its **ID/name**, and put the Google secret in its **Secret** field. The 64-character limit applies to the ID/name.
8. Choose **Sign in to Google**, complete consent, and select **Return to Obsidian** on the callback page.
9. Choose **Choose existing folder**, browse to a folder (or open its Drive link), and confirm **Connect this folder**. Alternatively, **Create sync folder** creates `Obsidian Drive Sync - <vault name>` in My Drive and starts syncing the vault's notes and attachments. **Open folder in Drive** opens that exact folder.

External projects left in Testing commonly issue seven-day Drive refresh grants. A lasting installation needs an appropriate publishing/audience configuration and any applicable verification. See [Google's OAuth documentation](https://developers.google.com/identity/protocols/oauth2/web-server).

The Google token can access all Drive files. Folder restrictions are enforced in the plugin, not by Google. This permission enables automatic discovery of existing files and files added through Drive. Tokens stay in encrypted Obsidian secret storage on each device and are never included in the repository or synced vault files. A stolen token could nevertheless access files outside the selected folder. See [Google's scope guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).


## Install and pair iPhone

1. Install/update Obsidian. Create an empty local test vault with **Store in iCloud** off.
2. Install and enable BRAT through **Settings → Community plugins**.
3. In BRAT, add the same repository and select the same **0.5.2** release. Enable Drive Sync.
4. Put the Mac and phone on the same private local network. Keep desktop Obsidian open.
5. On desktop, open **Settings → Drive Sync → Add device**. A three-minute QR invitation appears.
6. On the phone, choose **Connect to existing device → Scan QR**. Scan the desktop QR, then choose **Approve device** on the Mac. Check the displayed desktop and local vault names, then tap **Connect this vault**. All phone steps stay in one panel. **Take QR photo** is available if the live camera is unsupported; a one-time invitation paste is under the alternative options. No individual client fields need to be copied.
7. Allow local-network access if iOS requests it for this pairing. Guest networks or client isolation can prevent devices from reaching each other.
8. Continue through the Google step in the same panel. Sign into the same Google account and return to Obsidian. Devices already signed in skip this step. Choose **Done** at Setup complete.
9. Wait for **Synced with Drive**. Create a synthetic note on desktop, verify it arrives on the phone, edit it on the phone, and verify the edit returns to desktop before using any important data.

Encrypted pairing, configuration storage, and initial sync passed on the real iPhone with the external Camera handoff in 0.2.0. The 0.2.1 in-app live camera scan and step flow also passed on the real iPhone; after completion its connection and Synced with Drive status were verified. Its invitation contains a temporary pairing key, not Google credentials. Keep the QR/link private. Configuration is encrypted before crossing the local network; the listener expires after three minutes or when the desktop panel closes. Access/refresh tokens are never transferred. Closing the panel before completion cancels pairing.

## Everyday use

Edit local notes and attachments normally. Automatic checks run after saved edits, when Obsidian resumes, and every 30 seconds while it is open. Desktop has a status-bar item; mobile has a visible status button. Tap status for details, **Sync now**, or **Pause**.

If both devices changed a note, both edits are preserved using an ordinary `name (conflict …).md` copy. Check the details panel when it reports attention is needed. Attachments retain their original extension in conflict copies. An observed local deletion trashes the remote file only if its content still matches the common baseline. A newer remote edit is restored. Confirmed Drive trash moves unchanged local files into `.trash/drive-sync`; conflicting local edits are preserved first. A missing listing entry or lost access never counts as proof of deletion. Moves retain the Drive file ID; occupied destinations require review.

“Synced with Drive” means this device completed its last check. It does not mean another offline device has uploaded its work. iOS can suspend Obsidian in the background; reopening resumes checking. Quitting desktop Obsidian or sleeping the Mac also stops work.

## More than one vault

Use a **different Drive folder for each logical vault**, for example Work and Personal. Install the plugin in each desktop vault. With the configured vault still open in another Obsidian window on the same computer, choose **Settings → Drive Sync → Reuse Google setup from another vault → Choose vault**. Select the source, compare the displayed code in both vaults, and choose **Approve setup** in the source vault. The receiving vault saves only the Google client configuration in its own Keychain. Sign in separately, then choose or create its own Drive folder. Both vaults need 0.5.0 or newer. No clipboard, QR, shared credential file, or network listener is used for this same-computer transfer. Never copy Google tokens or plugin data.json. On iPhone, create a corresponding local vault, install BRAT and Drive Sync there, and pair it with the matching desktop vault. The pairing panel displays both vault names before connecting.

Each vault has its own folder ID, baseline, pending changes, and device grant. Do not clone plugin `data.json` between vaults or point unrelated vaults at the same folder. Two vaults connected to the same folder intentionally synchronize the same files. Obsidian only runs plugins for open vaults; closed mobile vaults catch up when opened.

## Existing files in Google Drive

Choose an existing folder during desktop setup. Its ordinary files and subfolders are synchronized directly; the plugin does not make an import copy elsewhere. Use a dedicated folder for each logical vault, and pair mobile to that same folder.

Files manually uploaded or moved into that Drive folder are discovered on the next successful check on each device. You can also add files to the local Obsidian vault. Existing files with different contents on the two sides are preserved as conflict copies, rather than using timestamps to choose a winner. A device must be online with Obsidian open to complete its check.

Google-native Docs/Sheets/Slides, shortcuts, hidden paths, and Obsidian configuration are excluded. The folder browser starts in My Drive; shared-drive workflows have not been validated. Google Picker API and an API key are not required.


## Recovery and current limits

Remote removals remain in Google Drive trash, subject to Google's retention rules. Local propagated removals and previous attachment versions remain under `.trash/drive-sync/<unique ID>/…` in the vault. Recover them with the OS file manager (show hidden files); the plugin never permanently deletes them or automatically cleans this recovery area. They consume disk space until you remove them.

The current limits are 20 MB per file and 1,000 folders per vault. Hidden paths, Obsidian configuration, Google-native documents, and shortcuts are excluded. Duplicate or case/Unicode-colliding names stop the check for review. Empty folders are not synchronized or automatically removed. Rename intent is recorded while the plugin is running; changes made while it was unloaded may produce preserved duplicate paths requiring review.

Failed native read requests get two short retries; continuing failures back off up to five minutes. Unchanged Drive versions avoid repeat content downloads. The automated large-vault test covers 2,000 synthetic files. A real iPhone verified a 259-file, approximately 11.6 MB fixture including two 5 MiB attachments; a three-day soak is still in progress. These checks are not a performance guarantee. Keep both devices on the same release while testing.

## Google Drive for desktop

The Obsidian vault must remain outside the folder managed by Drive for desktop. The plugin already talks to Drive directly.

You can keep Drive for desktop for unrelated files. It may also show the plugin's cloud folder: **Mirror files** downloads a full additional local copy, while **Stream files** primarily keeps cloud files online and downloads/caches them as needed. That extra view is not the Obsidian vault. Do not point the plugin's vault at it or put two sync systems in charge of the same directory. [Google explains streaming and mirroring here](https://support.google.com/drive/answer/13401938?hl=en).

## Updates and troubleshooting

Update Drive Sync through BRAT on **each** device. A pinned version stays pinned until you select a newer release. Updates retain local settings and credentials; updating does not pair devices. If the plugin displays **Reconnect Google**, sign in on each device to grant the current Drive permission before resuming sync. Reopen Obsidian if the interface has not refreshed.

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
| Connected but no sync folder | Choose or create the folder on desktop, then pair the phone to it. Google sign-in alone does not select a folder. |
| Access expires after about a week | Check whether your Google project is External and still in Testing. |

Disconnect attempts Google grant revocation and can require other devices using the project to reconnect. Credentials live in each device's [Obsidian SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage); they are not synchronized through vault files.

See [FEASIBILITY.md](FEASIBILITY.md) for evidence and remaining limits, and [DEVELOPMENT.md](DEVELOPMENT.md) for building and testing.
