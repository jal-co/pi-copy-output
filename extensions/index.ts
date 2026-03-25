/**
 * pi-copy-output — Copy assistant output to clipboard with cell-level table control
 *
 * Commands:
 *   /copy             - Copy the last assistant message (raw markdown)
 *   /copy code        - Copy only code blocks from the last response
 *   /copy table       - Interactive table explorer — pick cells, rows, columns
 *   /copy all         - Copy the entire conversation
 *   /copy pick        - Interactive picker to choose which block to copy
 *
 * Shortcut:
 *   ctrl+shift+c      - Copy last assistant message (same as /copy)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
	type SelectItem,
	SelectList,
	type TUI,
	matchesKey,
	Key,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(cpExec);

// ── Clipboard ────────────────────────────────────────────────────────────────

async function copyToClipboard(text: string): Promise<void> {
	const platform = process.platform;
	let cmd: string;

	if (platform === "darwin") {
		cmd = "pbcopy";
	} else if (platform === "win32") {
		cmd = "clip";
	} else {
		cmd = "xclip -selection clipboard";
	}

	await execAsync(cmd, { input: text });
}

// ── Content Extraction ───────────────────────────────────────────────────────

type ContentBlock = { type?: string; text?: string };
type SessionEntry = { type: string; message?: { role?: string; content?: unknown } };

function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

function getLastAssistantText(entries: SessionEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const text = extractAssistantText(entry.message.content);
			if (text.trim()) return text;
		}
	}
	return null;
}

function getAllConversationText(entries: SessionEntry[]): string {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractAssistantText(entry.message.content);
		if (!text.trim()) continue;
		sections.push(`## ${role === "user" ? "User" : "Assistant"}\n\n${text}`);
	}
	return sections.join("\n\n---\n\n");
}

// ── Markdown Block Parsers ───────────────────────────────────────────────────

interface ExtractedBlock {
	type: "code" | "table" | "text";
	content: string;
	label: string;
}

function extractCodeBlocks(text: string): ExtractedBlock[] {
	const blocks: ExtractedBlock[] = [];
	const regex = /```(\w*)\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(text)) !== null) {
		const lang = match[1] || "text";
		const code = match[2].trimEnd();
		const preview = code.split("\n")[0]?.slice(0, 60) ?? "";
		blocks.push({ type: "code", content: code, label: `[${lang}] ${preview}${code.length > 60 ? "…" : ""}` });
	}
	return blocks;
}

// ── Table Parser ─────────────────────────────────────────────────────────────

interface ParsedTable {
	headers: string[];
	rows: string[][];
	raw: string;
}

/** Parse a markdown pipe table row into trimmed cell values */
function parseTableRow(line: string): string[] {
	// Strip leading/trailing pipes, split on |, trim each cell
	const stripped = line.replace(/^\|/, "").replace(/\|$/, "");
	return stripped.split("|").map((cell) => cell.trim());
}

/** Check if a row is a separator row (e.g. |---|---|) */
function isSeparatorRow(line: string): boolean {
	const cells = parseTableRow(line);
	return cells.every((c) => /^:?-+:?$/.test(c));
}

/** Extract all markdown tables as structured ParsedTable objects */
function extractParsedTables(text: string): ParsedTable[] {
	const tables: ParsedTable[] = [];
	const lines = text.split("\n");
	let tableLines: string[] = [];
	let inTable = false;

	const flushTable = () => {
		if (tableLines.length < 2) { tableLines = []; inTable = false; return; }

		const raw = tableLines.join("\n");
		const headerLine = tableLines[0];
		const headers = parseTableRow(headerLine);

		// Find where data rows start (skip separator)
		let dataStart = 1;
		if (tableLines.length > 1 && isSeparatorRow(tableLines[1])) {
			dataStart = 2;
		}

		const rows: string[][] = [];
		for (let i = dataStart; i < tableLines.length; i++) {
			if (!isSeparatorRow(tableLines[i])) {
				rows.push(parseTableRow(tableLines[i]));
			}
		}

		if (headers.length > 0) {
			tables.push({ headers, rows, raw });
		}

		tableLines = [];
		inTable = false;
	};

	for (const line of lines) {
		const trimmed = line.trim();
		const isTableLine = trimmed.startsWith("|") && trimmed.endsWith("|");

		if (isTableLine) {
			inTable = true;
			tableLines.push(trimmed);
		} else {
			if (inTable) flushTable();
		}
	}
	if (inTable) flushTable();

	return tables;
}

function extractAllBlocks(text: string): ExtractedBlock[] {
	const code = extractCodeBlocks(text);
	const tables = extractParsedTables(text).map((t, i) => ({
		type: "table" as const,
		content: t.raw,
		label: `Table ${i + 1}: ${t.headers.join(", ").slice(0, 60)}`,
	}));
	return [...code, ...tables];
}

// ── Table Explorer UI ────────────────────────────────────────────────────────

type TableExplorerResult = string | null;
type CopyMode = "cell" | "row" | "column" | "table";

class TableExplorer {
	private cursorRow = 0; // -1 = header row, 0+ = data rows
	private cursorCol = 0;
	private mode: CopyMode = "cell";
	private showHeader = true; // include header row index offset

	constructor(
		private table: ParsedTable,
		private tui: TUI,
		private theme: Theme,
		private done: (result: TableExplorerResult) => void,
	) {
		// Start on first data row if available, else header
		this.cursorRow = table.rows.length > 0 ? 0 : -1;
	}

	private get totalRows(): number {
		return this.table.rows.length + 1; // +1 for header
	}

	private get totalCols(): number {
		return this.table.headers.length;
	}

	/** Get the cell text at current cursor position */
	private getCellAt(row: number, col: number): string {
		if (row === -1) return this.table.headers[col] ?? "";
		return this.table.rows[row]?.[col] ?? "";
	}

	/** Get text for current selection based on mode */
	private getSelectedText(): string {
		switch (this.mode) {
			case "cell":
				return this.getCellAt(this.cursorRow, this.cursorCol);

			case "row": {
				const cells = this.cursorRow === -1
					? this.table.headers
					: this.table.rows[this.cursorRow] ?? [];
				return cells.join("\t");
			}

			case "column": {
				const vals: string[] = [this.table.headers[this.cursorCol] ?? ""];
				for (const row of this.table.rows) {
					vals.push(row[this.cursorCol] ?? "");
				}
				return vals.join("\n");
			}

			case "table":
				return this.table.raw;
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) { this.done(null); return; }
		if (matchesKey(data, Key.enter)) { this.done(this.getSelectedText()); return; }

		// Navigation
		if (matchesKey(data, Key.up)) {
			if (this.cursorRow > -1) { this.cursorRow--; this.tui.requestRender(); }
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.cursorRow < this.table.rows.length - 1) { this.cursorRow++; this.tui.requestRender(); }
			return;
		}
		if (matchesKey(data, Key.left)) {
			if (this.cursorCol > 0) { this.cursorCol--; this.tui.requestRender(); }
			return;
		}
		if (matchesKey(data, Key.right)) {
			if (this.cursorCol < this.totalCols - 1) { this.cursorCol++; this.tui.requestRender(); }
			return;
		}

		// Mode switching
		if (matchesKey(data, "c")) { this.mode = "cell"; this.tui.requestRender(); return; }
		if (matchesKey(data, "r")) { this.mode = "row"; this.tui.requestRender(); return; }
		if (matchesKey(data, "l")) { this.mode = "column"; this.tui.requestRender(); return; }
		if (matchesKey(data, "t")) { this.mode = "table"; this.tui.requestRender(); return; }

		// Tab cycles modes
		if (matchesKey(data, Key.tab)) {
			const modes: CopyMode[] = ["cell", "row", "column", "table"];
			const idx = modes.indexOf(this.mode);
			this.mode = modes[(idx + 1) % modes.length];
			this.tui.requestRender();
			return;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const lines: string[] = [];

		// ── Top border ──
		const title = " Table Explorer ";
		const titleW = visibleWidth(title);
		const lp = Math.floor((innerW - titleW) / 2);
		const rp = Math.max(0, innerW - titleW - lp);
		lines.push(
			th.fg("border", "╭" + "─".repeat(lp)) +
			th.fg("accent", th.bold(title)) +
			th.fg("border", "─".repeat(rp) + "╮"),
		);

		// ── Mode bar ──
		const modes: { key: string; mode: CopyMode; label: string }[] = [
			{ key: "c", mode: "cell", label: "Cell" },
			{ key: "r", mode: "row", label: "Row" },
			{ key: "l", mode: "column", label: "Column" },
			{ key: "t", mode: "table", label: "Table" },
		];
		const modeBar = modes.map((m) => {
			const active = m.mode === this.mode;
			const keyStr = th.fg("dim", `[${m.key}]`);
			const label = active
				? th.bg("selectedBg", th.fg("accent", ` ${m.label} `))
				: th.fg("muted", ` ${m.label} `);
			return `${keyStr}${label}`;
		}).join(" ");
		lines.push(this.pad(` ${modeBar}`, width));
		lines.push(th.fg("border", "├" + "─".repeat(innerW) + "┤"));

		// ── Table rendering ──
		// Calculate column widths
		const colWidths: number[] = this.table.headers.map((h, ci) => {
			let max = visibleWidth(h);
			for (const row of this.table.rows) {
				const cellW = visibleWidth(row[ci] ?? "");
				if (cellW > max) max = cellW;
			}
			return Math.min(max, 40); // cap column width
		});

		// Render header row
		const headerCells = this.table.headers.map((h, ci) => {
			const padded = h.slice(0, colWidths[ci]).padEnd(colWidths[ci]);
			const isSelected = this.cursorRow === -1 && this.cursorCol === ci && this.mode === "cell";
			const isRowSelected = this.cursorRow === -1 && this.mode === "row";
			const isColSelected = this.cursorCol === ci && this.mode === "column";

			if (isSelected) return th.bg("selectedBg", th.fg("accent", th.bold(padded)));
			if (isRowSelected || isColSelected) return th.fg("accent", th.bold(padded));
			return th.fg("text", th.bold(padded));
		});
		lines.push(this.pad(` ${headerCells.join(th.fg("border", " │ "))}`, width));

		// Separator
		const sep = colWidths.map((w) => "─".repeat(w)).join("─┼─");
		lines.push(this.pad(` ${th.fg("border", sep)}`, width));

		// Render data rows
		const maxVisibleRows = 15;
		const startRow = Math.max(0, this.cursorRow - Math.floor(maxVisibleRows / 2));
		const endRow = Math.min(this.table.rows.length, startRow + maxVisibleRows);

		for (let ri = startRow; ri < endRow; ri++) {
			const row = this.table.rows[ri] ?? [];
			const cells = this.table.headers.map((_, ci) => {
				const raw = row[ci] ?? "";
				const padded = raw.slice(0, colWidths[ci]).padEnd(colWidths[ci]);
				const isSelected = this.cursorRow === ri && this.cursorCol === ci && this.mode === "cell";
				const isRowSelected = this.cursorRow === ri && this.mode === "row";
				const isColSelected = this.cursorCol === ci && this.mode === "column";

				if (isSelected) return th.bg("selectedBg", th.fg("accent", padded));
				if (isRowSelected || isColSelected) return th.fg("accent", padded);
				return th.fg("text", padded);
			});
			lines.push(this.pad(` ${cells.join(th.fg("border", " │ "))}`, width));
		}

		if (this.table.rows.length > maxVisibleRows) {
			lines.push(this.pad(
				` ${th.fg("dim", `… ${this.table.rows.length} rows total (showing ${startRow + 1}–${endRow})`)}`,
				width,
			));
		}

		// ── Preview ──
		lines.push(th.fg("border", "├" + "─".repeat(innerW) + "┤"));
		const preview = this.getSelectedText();
		const previewLines = preview.split("\n");
		const previewLabel = this.mode === "table" ? "Full table" : `${this.mode} content`;
		lines.push(this.pad(` ${th.fg("muted", `${previewLabel}:`)}`, width));

		const maxPreview = 3;
		for (let i = 0; i < Math.min(previewLines.length, maxPreview); i++) {
			lines.push(this.pad(
				`  ${th.fg("text", previewLines[i].slice(0, innerW - 4))}`,
				width,
			));
		}
		if (previewLines.length > maxPreview) {
			lines.push(this.pad(
				`  ${th.fg("dim", `… ${previewLines.length - maxPreview} more lines`)}`,
				width,
			));
		}

		// ── Footer ──
		lines.push(th.fg("border", "├" + "─".repeat(innerW) + "┤"));
		lines.push(this.pad(
			` ${th.fg("dim", "↑↓←→ navigate • tab cycle mode • enter copy • esc cancel")}`,
			width,
		));
		lines.push(th.fg("border", "╰" + "─".repeat(innerW) + "╯"));

		return lines;
	}

	private pad(content: string, width: number): string {
		return this.theme.fg("border", "│") +
			truncateToWidth(content, width - 2, "…", true) +
			this.theme.fg("border", "│");
	}

	invalidate(): void {}
}

// ── Generic Block Picker (for code/pick) ─────────────────────────────────────

async function showBlockPicker(
	blocks: ExtractedBlock[],
	ctx: ExtensionCommandContext,
): Promise<ExtractedBlock | null> {
	if (blocks.length === 0) return null;

	const items: SelectItem[] = blocks.map((b, i) => ({
		value: String(i),
		label: `${b.type === "code" ? "📋" : b.type === "table" ? "📊" : "📝"} ${b.label}`,
		description: `${b.content.split("\n").length} lines`,
	}));

	return ctx.ui.custom<ExtractedBlock | null>(
		(tui, theme, _kb, done) => {
			const selectList = new SelectList(items, Math.min(items.length, 12), {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done(blocks[parseInt(item.value, 10)] ?? null);
			selectList.onCancel = () => done(null);

			const pad = (content: string, width: number) =>
				theme.fg("border", "│") + truncateToWidth(content, width - 2, "…", true) + theme.fg("border", "│");

			return {
				render(width: number): string[] {
					const innerW = Math.max(1, width - 2);
					const lines: string[] = [];
					const title = " Copy Block ";
					const titleW = visibleWidth(title);
					const lp = Math.floor((innerW - titleW) / 2);
					const rp = Math.max(0, innerW - titleW - lp);
					lines.push(
						theme.fg("border", "╭" + "─".repeat(lp)) +
						theme.fg("accent", theme.bold(title)) +
						theme.fg("border", "─".repeat(rp) + "╮"),
					);
					lines.push(pad(` ${theme.fg("dim", `${blocks.length} block${blocks.length === 1 ? "" : "s"} found`)}`, width));
					for (const ll of selectList.render(innerW)) lines.push(pad(ll, width));
					lines.push(theme.fg("border", "├" + "─".repeat(innerW) + "┤"));
					lines.push(pad(` ${theme.fg("dim", "↑↓ navigate • enter copy • esc cancel")}`, width));
					lines.push(theme.fg("border", "╰" + "─".repeat(innerW) + "╯"));
					return lines;
				},
				invalidate() { selectList.invalidate(); },
				handleInput(data: string) { selectList.handleInput(data); tui.requestRender(); },
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "60%", minWidth: 50, maxHeight: "80%" } },
	);
}

// ── Subcommands ──────────────────────────────────────────────────────────────

async function copyLast(ctx: ExtensionCommandContext): Promise<void> {
	const text = getLastAssistantText(ctx.sessionManager.getBranch());
	if (!text) { ctx.ui.notify("No assistant response to copy", "warning"); return; }
	try {
		await copyToClipboard(text);
		ctx.ui.notify(`✓ Copied ${text.split("\n").length} lines (${text.length} chars)`, "info");
	} catch { ctx.ui.notify("✗ Failed to copy — is pbcopy/xclip installed?", "error"); }
}

async function copyCode(ctx: ExtensionCommandContext): Promise<void> {
	const text = getLastAssistantText(ctx.sessionManager.getBranch());
	if (!text) { ctx.ui.notify("No assistant response to copy", "warning"); return; }

	const blocks = extractCodeBlocks(text);
	if (blocks.length === 0) { ctx.ui.notify("No code blocks in last response", "warning"); return; }

	if (blocks.length === 1) {
		try {
			await copyToClipboard(blocks[0].content);
			ctx.ui.notify(`✓ Copied code block (${blocks[0].content.split("\n").length} lines)`, "info");
		} catch { ctx.ui.notify("✗ Failed to copy", "error"); }
		return;
	}

	const selected = await showBlockPicker(blocks, ctx);
	if (!selected) return;
	try {
		await copyToClipboard(selected.content);
		ctx.ui.notify(`✓ Copied code block (${selected.content.split("\n").length} lines)`, "info");
	} catch { ctx.ui.notify("✗ Failed to copy", "error"); }
}

async function copyTable(ctx: ExtensionCommandContext): Promise<void> {
	const text = getLastAssistantText(ctx.sessionManager.getBranch());
	if (!text) { ctx.ui.notify("No assistant response to copy", "warning"); return; }

	const tables = extractParsedTables(text);
	if (tables.length === 0) { ctx.ui.notify("No tables in last response", "warning"); return; }

	// If multiple tables, let user pick which one first
	let table: ParsedTable;
	if (tables.length === 1) {
		table = tables[0];
	} else {
		const items: SelectItem[] = tables.map((t, i) => ({
			value: String(i),
			label: `Table ${i + 1}: ${t.headers.join(", ").slice(0, 50)}`,
			description: `${t.rows.length} rows × ${t.headers.length} cols`,
		}));

		const picked = await ctx.ui.custom<number | null>(
			(tui, theme, _kb, done) => {
				const selectList = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				});
				selectList.onSelect = (item) => done(parseInt(item.value, 10));
				selectList.onCancel = () => done(null);
				const pad = (content: string, w: number) =>
					theme.fg("border", "│") + truncateToWidth(content, w - 2, "…", true) + theme.fg("border", "│");
				return {
					render(w: number): string[] {
						const iw = Math.max(1, w - 2);
						const ls: string[] = [];
						const t = " Pick a Table ";
						const tw = visibleWidth(t);
						const lp = Math.floor((iw - tw) / 2);
						const rp = Math.max(0, iw - tw - lp);
						ls.push(theme.fg("border", "╭" + "─".repeat(lp)) + theme.fg("accent", theme.bold(t)) + theme.fg("border", "─".repeat(rp) + "╮"));
						for (const ll of selectList.render(iw)) ls.push(pad(ll, w));
						ls.push(theme.fg("border", "├" + "─".repeat(iw) + "┤"));
						ls.push(pad(` ${theme.fg("dim", "↑↓ navigate • enter select • esc cancel")}`, w));
						ls.push(theme.fg("border", "╰" + "─".repeat(iw) + "╯"));
						return ls;
					},
					invalidate() { selectList.invalidate(); },
					handleInput(data: string) { selectList.handleInput(data); tui.requestRender(); },
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: "50%", minWidth: 40, maxHeight: "60%" } },
		);
		if (picked === null) return;
		table = tables[picked];
	}

	// Open the table explorer
	const result = await ctx.ui.custom<TableExplorerResult>(
		(tui, theme, _kb, done) => {
			const explorer = new TableExplorer(table, tui, theme, done);
			return {
				render: (w: number) => explorer.render(w),
				invalidate: () => explorer.invalidate(),
				handleInput: (data: string) => explorer.handleInput(data),
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 60, maxHeight: "90%" } },
	);

	if (result === null) return;

	try {
		await copyToClipboard(result);
		const lines = result.split("\n").length;
		const chars = result.length;
		ctx.ui.notify(`✓ Copied (${lines} line${lines === 1 ? "" : "s"}, ${chars} chars)`, "info");
	} catch { ctx.ui.notify("✗ Failed to copy", "error"); }
}

async function copyAll(ctx: ExtensionCommandContext): Promise<void> {
	const text = getAllConversationText(ctx.sessionManager.getBranch());
	if (!text.trim()) { ctx.ui.notify("No conversation to copy", "warning"); return; }
	try {
		await copyToClipboard(text);
		ctx.ui.notify(`✓ Copied full conversation (${text.split("\n").length} lines)`, "info");
	} catch { ctx.ui.notify("✗ Failed to copy", "error"); }
}

async function copyPick(ctx: ExtensionCommandContext): Promise<void> {
	const text = getLastAssistantText(ctx.sessionManager.getBranch());
	if (!text) { ctx.ui.notify("No assistant response to copy", "warning"); return; }

	const allBlocks = extractAllBlocks(text);
	const fullBlock: ExtractedBlock = {
		type: "text", content: text,
		label: `Full response (${text.split("\n").length} lines)`,
	};
	const blocks = [fullBlock, ...allBlocks];

	if (blocks.length === 1) { await copyLast(ctx); return; }

	const selected = await showBlockPicker(blocks, ctx);
	if (!selected) return;

	// If they picked a table, open the table explorer instead
	if (selected.type === "table") {
		const tables = extractParsedTables(text);
		const matchedTable = tables.find((t) => t.raw === selected.content);
		if (matchedTable) {
			const result = await ctx.ui.custom<TableExplorerResult>(
				(tui, theme, _kb, done) => {
					const explorer = new TableExplorer(matchedTable, tui, theme, done);
					return {
						render: (w: number) => explorer.render(w),
						invalidate: () => explorer.invalidate(),
						handleInput: (data: string) => explorer.handleInput(data),
					};
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 60, maxHeight: "90%" } },
			);
			if (result !== null) {
				try {
					await copyToClipboard(result);
					ctx.ui.notify(`✓ Copied (${result.split("\n").length} line${result.split("\n").length === 1 ? "" : "s"})`, "info");
				} catch { ctx.ui.notify("✗ Failed to copy", "error"); }
			}
			return;
		}
	}

	try {
		await copyToClipboard(selected.content);
		ctx.ui.notify(`✓ Copied ${selected.type} (${selected.content.split("\n").length} lines)`, "info");
	} catch { ctx.ui.notify("✗ Failed to copy", "error"); }
}

// ── Main Extension ───────────────────────────────────────────────────────────

export default function copyOutputExtension(pi: ExtensionAPI) {
	pi.registerCommand("copy", {
		description: "Copy assistant output to clipboard",
		getArgumentCompletions: (prefix) => {
			const subcommands = [
				{ value: "code", label: "code", description: "Copy code blocks only" },
				{ value: "table", label: "table", description: "Table explorer — pick cells, rows, columns" },
				{ value: "all", label: "all", description: "Copy full conversation" },
				{ value: "pick", label: "pick", description: "Pick any block to copy" },
			];
			return subcommands.filter((s) => s.value.startsWith(prefix)).length > 0
				? subcommands.filter((s) => s.value.startsWith(prefix))
				: null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) { ctx.ui.notify("pi-copy-output requires interactive mode", "error"); return; }
			switch (args.trim()) {
				case "code": await copyCode(ctx); break;
				case "table": await copyTable(ctx); break;
				case "all": await copyAll(ctx); break;
				case "pick": await copyPick(ctx); break;
				case "": await copyLast(ctx); break;
				default: ctx.ui.notify(`Unknown subcommand "${args.trim()}". Try: code, table, all, pick`, "warning");
			}
		},
	});

	pi.registerShortcut("ctrl+shift+c", {
		description: "Copy last assistant response to clipboard",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const text = getLastAssistantText(ctx.sessionManager.getBranch());
			if (!text) { ctx.ui.notify("No assistant response to copy", "warning"); return; }
			try {
				await copyToClipboard(text);
				ctx.ui.notify(`✓ Copied ${text.split("\n").length} lines`, "info");
			} catch { ctx.ui.notify("✗ Failed to copy", "error"); }
		},
	});
}
