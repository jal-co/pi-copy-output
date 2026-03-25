# pi-copy-output

A pi extension that copies assistant responses to the system clipboard via `/copy` and `Ctrl+Shift+C`, with a cell-level table explorer for navigating markdown tables.

## Project Structure

```
pi-copy-output/
├── extensions/
│   └── index.ts          # The extension — /copy command, table explorer, Ctrl+Shift+C shortcut
├── .github/workflows/
│   └── publish.yml       # Auto-publishes to npm on GitHub release
├── package.json          # Pi package manifest (pi.extensions field)
├── README.md
├── LICENSE
└── AGENTS.md
```

## Development

Single-file extension with no build step. Edit `extensions/index.ts` directly.

Uses only pi peer dependencies — no runtime deps.

To test locally:

```bash
pi -e ./extensions/index.ts
```

## Release Process

1. Bump version in `package.json`
2. Commit: `git commit -am "chore: bump version to X.Y.Z"`
3. Tag and release: `gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes`
4. GitHub Action publishes to npm automatically.

## Architecture Notes

- Reads `ctx.sessionManager.getBranch()` entries to find assistant messages.
- Text extraction pulls `type: "text"` content blocks from assistant message arrays.
- Table parser splits pipe-delimited rows into structured `ParsedTable` objects (headers + rows of string arrays).
- Table explorer renders a navigable grid with cell/row/column/table copy modes.
- Code block extraction uses regex for fenced blocks.
- Clipboard uses `child_process.exec` with platform-specific commands (`pbcopy`, `xclip`, `clip`).
- All overlays use `ctx.ui.custom()` with `overlay: true`.
