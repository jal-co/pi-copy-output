# pi-copy-output

A pi extension for copying assistant responses to the system clipboard. Provides `/copy` command, `Ctrl+Shift+C` shortcut, and an interactive table grid for cell-level copying.

## Structure

```
pi-copy-output/
├── extensions/
│   └── index.ts          # Single-file extension
├── .github/workflows/
│   └── publish.yml       # npm publish on GitHub release
├── package.json
├── README.md
├── LICENSE
└── AGENTS.md
```

## Development

No build step. Edit `extensions/index.ts` directly. Test with:

```bash
pi -e ./extensions/index.ts
```

## Release

1. Bump version in `package.json`
2. Commit and push
3. `gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes`

## Architecture

- Session entries from `ctx.sessionManager.getBranch()` provide assistant messages
- Text extraction pulls `type: "text"` content blocks
- Table parser splits pipe-delimited rows into `ParsedTable` (headers + rows of string arrays)
- Table grid renders a navigable overlay with cell/row/column/table copy actions
- Code block extraction uses regex for fenced blocks
- Section splitting on `---`/`***`/`___` horizontal rules
- Clipboard via `child_process.exec` with platform detection (`pbcopy`, `xclip`, `clip`)
- Configurable shortcut via `@juanibiapina/pi-extension-settings` event bus
- All overlays use `ctx.ui.custom()` with `overlay: true`
- Shared border helpers (`borderTop`, `borderMid`, `borderBot`, `padLine`) for consistent UI
