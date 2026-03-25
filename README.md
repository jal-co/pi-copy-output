<p align="center">
  <strong>pi-copy-output</strong><br>
  <em>Copy assistant responses to your clipboard -- tables, code blocks, individual cells.</em>
</p>

---

When the model puts its answer in a markdown table, selecting and copying from the terminal is painful. This [pi](https://github.com/badlogic/pi-mono) extension gives you `/copy` and a configurable keyboard shortcut to grab it cleanly.

## Install

```bash
pi install npm:pi-copy-output

# or from git
pi install git:github.com/jal-co/pi-copy-output

# or try without installing
pi -e npm:pi-copy-output
```

> Requires [`@juanibiapina/pi-extension-settings`](https://www.npmjs.com/package/@juanibiapina/pi-extension-settings) for configurable keybindings. Install it first and make sure it appears **before** `pi-copy-output` in your `packages` array.

## Usage

| Command | Description |
|---------|-------------|
| `/copy` | Smart picker -- lists all copyable blocks from the last response |
| `/copy all` | Copy the full conversation |
| `Ctrl+Shift+C` | Same as `/copy` (default, configurable via `/extension-settings`) |

### How it works

`/copy` opens a picker listing:
- **Full response** -- the raw markdown
- **Sections** -- if the response has `---` horizontal rules, each section is listed separately
- **Code blocks** -- each fenced block, without the fences
- **Tables** -- opens a grid dialog (see below)

If the response is plain text with no tables, code, or sections, it copies immediately.

### Table grid

When you select a table from the picker, a grid dialog opens showing the actual table. Arrow through cells, then:

| Key | Action |
|-----|--------|
| `enter` | Copy the highlighted cell value |
| `r` | Copy the entire row (tab-separated) |
| `c` | Copy the entire column (newline-separated) |
| `a` | Copy the full table (raw markdown) |
| `esc` | Go back to the picker |

Cell values are cleaned -- no pipes, no padding, no markdown formatting (bold, links, inline code stripped).

## Settings

Requires [`@juanibiapina/pi-extension-settings`](https://www.npmjs.com/package/@juanibiapina/pi-extension-settings). Use `/extension-settings` in pi to configure:

| Setting | Description | Default |
|---------|-------------|---------|
| Keyboard Shortcut | Key combo to open the copy picker | `ctrl+shift+c` |

Available shortcut options: `ctrl+shift+c`, `ctrl+shift+y`, `ctrl+shift+x`, `alt+c`, `alt+shift+c`, `ctrl+alt+c`.

After changing the shortcut, run `/reload` for it to take effect.

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [`@juanibiapina/pi-extension-settings`](https://www.npmjs.com/package/@juanibiapina/pi-extension-settings) (for configurable keybindings)
- A clipboard utility (`pbcopy` on macOS, `xclip` on Linux, `clip` on Windows)

## License

MIT
