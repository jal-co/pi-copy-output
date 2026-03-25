<p align="center">
  <strong>pi-copy-output</strong><br>
  <em>Copy assistant responses to your clipboard — tables, code blocks, individual cells.</em>
</p>

---

When Claude puts its answer in a markdown table, selecting and copying from the terminal is painful. This [pi](https://github.com/badlogic/pi-mono) extension gives you `/copy` and `Ctrl+Shift+C` to grab it cleanly — including a full **table explorer** that lets you navigate cells, copy a single cell, a row, a column, or the whole table.

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

| Command | Description |
|---------|-------------|
| `/copy` | Copy the last assistant response (raw markdown) |
| `/copy code` | Copy code blocks (picker if multiple) |
| `/copy table` | **Table explorer** — navigate and copy cells, rows, columns |
| `/copy all` | Copy the full conversation |
| `/copy pick` | Pick any block; tables open the explorer automatically |
| `Ctrl+Shift+C` | Quick-copy last assistant response |

### Table Explorer

`/copy table` opens an interactive overlay where you can:

- **Navigate** with arrow keys to highlight any cell
- **Switch modes** with `tab` or hotkeys:
  - `c` — **Cell** mode: copy a single cell's text (no pipes, no padding)
  - `r` — **Row** mode: copy all cells in the row, tab-separated
  - `l` — **Column** mode: copy all values in the column, one per line
  - `t` — **Table** mode: copy the full markdown table
- **Preview** what will be copied before pressing `enter`
- **Cancel** with `esc`

### Examples

```
/copy              # Grab the last response
/copy code         # Just the code block(s)
/copy table        # Explore a table, pick a cell
/copy pick         # Let me choose which block
```

## How it works

The extension reads session branch entries to find the last assistant message, extracts the raw markdown text (before TUI rendering), and:

- **Code blocks**: extracts content between `` ``` `` fences (no fences in the copy)
- **Tables**: parses markdown pipe tables into structured headers/rows/cells, then lets you navigate and pick exactly what you need
- **Clipboard**: pipes to `pbcopy` (macOS), `xclip` (Linux), or `clip` (Windows)

No external dependencies. No network calls.

## Requirements

- [pi](https://github.com/badlogic/pi-mono) coding agent
- A clipboard utility (`pbcopy` on macOS is built-in; Linux needs `xclip` or `xsel`)

## License

MIT
