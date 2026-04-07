<p align="center">
  <strong>pi-copy-output</strong>
</p>

<p align="center">
  A <a href="https://github.com/badlogic/pi-mono">pi</a> extension for copying assistant responses to your clipboard.<br>
  Tables, code blocks, individual cells, sections — without fighting terminal selection.
</p>

## Install

```bash
# From npm
pi install npm:pi-copy-output

# From git
pi install git:github.com/jal-co/pi-copy-output
```

Or try without installing:

```bash
pi -e npm:pi-copy-output
```

## Usage

All commands are accessed via `/copyout`:

| Command | Description |
|---------|-------------|
| `/copyout` | Smart picker — lists all copyable blocks from the last response |
| `/copyout all` | Copy the full conversation |
| `Ctrl+Shift+C` | Same as `/copyout` (configurable) |

### How it works

`/copyout` opens a picker listing:
- **Full response** — the raw markdown
- **Sections** — if the response has `---` horizontal rules, each section is pickable
- **Code blocks** — each fenced block, without the fences
- **Tables** — opens a grid dialog (see below)

If the response is plain text with no structure, it copies immediately without a picker.

### Table grid

Selecting a table from the picker opens an interactive grid. Arrow through cells, then:

| Key | Action |
|-----|--------|
| `enter` | Copy the highlighted cell value |
| `r` | Copy the entire row (tab-separated) |
| `c` | Copy the entire column (newline-separated) |
| `a` | Copy the full table (raw markdown) |
| `esc` | Go back to the picker |

Cell values are cleaned — no pipes, no padding, no markdown formatting.

## Settings

Install [`@juanibiapina/pi-extension-settings`](https://www.npmjs.com/package/@juanibiapina/pi-extension-settings) to configure the keyboard shortcut via `/extension-settings`. It must appear **before** `pi-copy-output` in your `packages` array.

| Setting | Description | Default |
|---------|-------------|---------|
| Keyboard Shortcut | Key combo to open the copy picker | `ctrl+shift+c` |

Options: `ctrl+shift+c`, `ctrl+shift+y`, `ctrl+shift+x`, `alt+c`, `alt+shift+c`, `ctrl+alt+c`. Run `/reload` after changing.

The extension works fine without `pi-extension-settings` — you just get the default shortcut.

## Requirements

- [pi](https://github.com/badlogic/pi-mono) coding agent
- A clipboard utility (`pbcopy` on macOS, `xclip` on Linux, `clip` on Windows)

## License

MIT
