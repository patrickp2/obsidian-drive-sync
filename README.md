# Obsidian Drive Sync

An Obsidian plugin project for automatically syncing local Mac and iPhone/iPad vaults through the Google Drive API, using the same plugin on each device.

The Mac vault will live outside folders managed by Google Drive for desktop or other sync services. After setup, routine synchronization should happen automatically while the vault is open and the device allows execution, with visible pending work and preserved conflicts.

**Status: authentication-only prototype implemented; static callback deployed. Google client compatibility and the real iPhone flow remain unverified. Vault synchronization is disabled. Do not use with a live vault.**

## Project layout

- `REQUIREMENTS.md`: requirements, architecture decisions, open questions, and acceptance criteria.
- `FEASIBILITY.md`: authentication/storage evidence and unresolved validation gates.
- `DEVELOPMENT.md`: build, Google configuration, and disposable-vault test instructions.
- `docs/`: generated static GitHub Pages callback.
- `src/`: authentication core, Obsidian interface, and callback source.
- `tests/`: authentication and callback tests with synthetic data.

The plugin and static callback belong in this single public repository. Runtime credentials, tokens, local sync state, and vault contents must never be committed. GitHub Pages should publish only `docs/` from `main`.

Development happens outside an Obsidian vault. Deploy only compiled plugin artifacts into a disposable test vault during development.

Run `npm ci --ignore-scripts` and `npm run check` to build and test. Plugin artifacts are written to `dist/drive-sync/`. See [development instructions](DEVELOPMENT.md) and [the requirements](REQUIREMENTS.md) before using the prototype.
