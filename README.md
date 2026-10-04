# Obsidian Drive Sync

An Obsidian plugin project for syncing a local mobile vault with Google Drive, interoperating with Google Drive for desktop on macOS.

**Status: planning scaffold. No working plugin or OAuth callback is implemented yet. Do not use with a live vault.**

## Project layout

- `REQUIREMENTS.md`: requirements, architecture decisions, open questions, and acceptance criteria.
- `docs/`: public GitHub Pages content; the OAuth callback will live here.
- `src/`: planned plugin source directory.
- `tests/`: planned synchronization and authentication tests.

The plugin and static callback belong in this single public repository. Runtime credentials, tokens, local sync state, and vault contents must never be committed. GitHub Pages should publish only `docs/` from `main`.

Development happens outside an Obsidian vault. Deploy only compiled plugin artifacts into a disposable test vault during development.

See [the requirements](REQUIREMENTS.md) before implementation.
