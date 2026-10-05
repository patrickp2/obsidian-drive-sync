# Obsidian Drive Sync

An Obsidian plugin project for automatically syncing local Mac and iPhone/iPad vaults through the Google Drive API, using the same plugin on each device.

The Mac vault will live outside folders managed by Google Drive for desktop or other sync services. After setup, routine synchronization should happen automatically while the vault is open and the device allows execution, with visible pending work and preserved conflicts.

**Current release: 1.0.0.** Checks Drive changes on open, resume, and reconnection, then 60 seconds after the last successful sync while the app is active and online. Saved local edits upload after a short debounce. No Firebase, hosted notification service, or nearby-device sync connection is required. Existing users only need to update on each device; Google sign-ins and vault folders are retained.

The automated suite covers incremental sync, offline scheduling, conflict preservation, interrupted transfers, and manual recovery. Earlier Mac/iPhone validation is recorded in [DEVELOPMENT.md](DEVELOPMENT.md). Full Mac restart and production OAuth review remain deferred; this release does not claim those checks are complete.

Start with the [full installation guide](INSTALLATION.md). It covers BRAT on desktop and iPhone, one-time Google project setup, today's per-device sign-in, troubleshooting, and the pairing/automatic-sync flow. Installing the GitHub app is unnecessary.

## Project layout

- `REQUIREMENTS.md`: requirements, architecture decisions, open questions, and acceptance criteria.
- `INSTALLATION.md`: current installation and pairing steps.
- `FEASIBILITY.md`: authentication/storage evidence and unresolved validation gates.
- `DEVELOPMENT.md`: build, Google configuration, and disposable-vault test instructions.
- `docs/`: generated static GitHub Pages callback.
- `src/`: authentication core, Obsidian interface, disposable file probe, and callback source.
- `tests/`: authentication, callback, and file-probe tests with synthetic data.

The plugin and static callback belong in this single public repository. Runtime credentials, tokens, local sync state, and vault contents must never be committed. GitHub Pages should publish only `docs/` from `main`.

Development happens outside an Obsidian vault. Deploy only compiled plugin artifacts into a disposable test vault during development.

Run `npm ci --ignore-scripts` and `npm run check` to build and test. Plugin artifacts are written to `dist/drive-sync/`. See [development instructions](DEVELOPMENT.md) and [the requirements](REQUIREMENTS.md) for implementation details.
