# Obsidian Drive Sync

An Obsidian plugin project for automatically syncing local Mac and iPhone/iPad vaults through the Google Drive API, using the same plugin on each device.

The Mac vault will live outside folders managed by Google Drive for desktop or other sync services. After setup, routine synchronization should happen automatically while the vault is open and the device allows execution, with visible pending work and preserved conflicts.

**Status: 0.6.1 development beta. Adds incremental Drive change tracking, cached local fingerprints, a 60-second fallback heartbeat, authenticated nearby notifications, a manual full reconciliation command, and a quieter mobile interface. Existing pairs need one additional pairing to enable nearby notifications; their Google sign-ins are retained. The automated suite has 104 tests plus a private-network integration test. Earlier releases passed Mac/iPhone edit, conflict, attachment, move, deletion, interruption and 259-file checksum checks. Those earlier results do not establish real-device validation of the new notification path. Full Mac restart and production OAuth review remain deferred.**

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

Run `npm ci --ignore-scripts` and `npm run check` to build and test. Plugin artifacts are written to `dist/drive-sync/`. See [development instructions](DEVELOPMENT.md) and [the requirements](REQUIREMENTS.md) before using the prototype.
