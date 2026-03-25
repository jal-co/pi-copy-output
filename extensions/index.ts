/**
 * pi-copy-output — Copy assistant output to clipboard
 *
 * /copy opens a picker with the last response's copyable content.
 * Code blocks copy directly. Tables open a grid where you arrow
 * through cells and press a key to copy cell, row, column, or all.
 *
 * Commands:
 *   /copy              - Smart picker
 *   /copy all          - Copy full conversation (no picker)
 *
 * Shortcut:
 *   ctrl+shift+c       - Same as /copy
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
	type KeyId,
} from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { SettingDefinition } from "@juanibiapina/pi-extension-settings";
import { getSetting } from "@juanibiapina/pi-extension-settings";
import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(cpExec);

// ── Clipboard ────────────────────────────────────────────────────────────────

async function copyToClipboard(text: string): Promise<void> {
	const platform = process.platform;
	let cmd: string;
	if (platform === "darwin") cmd = "pbcopy";
	else if (platform === "win32") cmd = "clip";
	else cmd = "xclip -selection clipboard";
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

// ── Parsers ──────────────────────────────────────────────────────────────────

function stripMarkdownInline(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function parseTableRow(line: string): string[] {
	return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
	return parseTableRow(line).every((c) => /^:?-+:?$/.test(c));
}

interface ParsedTable {
	headers: string[];
	rows: string[][];
	raw: string;
}

function extractParsedTables(text: string): ParsedTable[] {
	const tables: ParsedTable[] = [];
	const lines = text.split("\n");
	let tableLines: string[] = [];
	let inTable = false;

	const flush = () => {
		if (tableLines.length < 2) { tableLines = []; inTable = false; return; }
		const headers = parseTableRow(tableLines[0]);
		let dataStart = 1;
		if (tableLines.length > 1 && isSeparatorRow(tableLines[1])) dataStart = 2;
		const rows: string[][] = [];
		for (let i = dataStart; i < tableLines.length; i++) {
			if (!isSeparatorRow(tableLines[i])) rows.push(parseTableRow(tableLines[i]));
		}
		if (headers.length > 0) tables.push({ headers, rows, raw: tableLines.join("\n") });
		tableLines = [];
		inTable = false;
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
			inTable = true;
			tableLines.push(trimmed);
		} else if (inTable) {
			flush();
		}
	}
	if (inTable) flush();
	return tables;
}

function extractCodeBlocks(text: string): { lang: string; code: string }[] {
	const blocks: { lang: string; code: string }[] = [];
	const regex = /```(\w*)\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(text)) !== null) {
		blocks.push({ lang: match[1] || "text", code: match[2].trimEnd() });
	}
	return blocks;
}

// ── Table Grid Dialog ────────────────────────────────────────────────────────

async function openTableGrid(
	table: ParsedTable,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const result = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => {
			let cursorRow = 0;
			let cursorCol = 0;

			const clean = (r: number, c: number): string => {
				if (r === -1) return stripMarkdownInline(table.headers[c] ?? "");
				return stripMarkdownInline(table.rows[r]?.[c] ?? "");
			};

			const getCellText = () => clean(cursorRow, cursorCol);

			const getRowText = () => {
				const src = cursorRow === -1 ? table.headers : (table.rows[cursorRow] ?? []);
				return src.map((_, ci) => clean(cursorRow, ci)).join("\t");
			};

			const getColumnText = () => {
				const vals = [stripMarkdownInline(table.headers[cursorCol] ?? "")];
				for (let ri = 0; ri < table.rows.length; ri++) {
					vals.push(clean(ri, cursorCol));
				}
				return vals.join("\n");
			};

			const getAllText = () => table.raw;

			// Column widths
			const colWidths = table.headers.map((h, ci) => {
				let max = stripMarkdownInline(h).length;
				for (const row of table.rows) {
					const w = stripMarkdownInline(row[ci] ?? "").length;
					if (w > max) max = w;
				}
				return Math.min(Math.max(max, 4), 40);
			});

			const pad = (content: string, width: number) =>
				theme.fg("border", "│") +
				truncateToWidth(content, width - 2, "…", true) +
				theme.fg("border", "│");

			const maxVisibleRows = 14;

			return {
				render(width: number): string[] {
					const innerW = Math.max(1, width - 2);
					const lines: string[] = [];

					// Title
					const title = ` Table (${table.rows.length} rows x ${table.headers.length} cols) `;
					const tw = visibleWidth(title);
					const lp = Math.floor((innerW - tw) / 2);
					const rp = Math.max(0, innerW - tw - lp);
					lines.push(
						theme.fg("border", "╭" + "─".repeat(lp)) +
						theme.fg("accent", theme.bold(title)) +
						theme.fg("border", "─".repeat(rp) + "╮"),
					);

					// Header row
					const headerCells = table.headers.map((h, ci) => {
						const txt = stripMarkdownInline(h);
						const padded = txt.slice(0, colWidths[ci]).padEnd(colWidths[ci]);
						const highlighted = cursorRow === -1 && cursorCol === ci;
						if (highlighted) return theme.bg("selectedBg", theme.fg("accent", padded));
						return theme.fg("text", theme.bold(padded));
					});
					lines.push(pad(` ${headerCells.join(theme.fg("border", " │ "))} `, width));

					// Separator
					const sep = colWidths.map((w) => "─".repeat(w)).join("─┼─");
					lines.push(pad(` ${theme.fg("border", sep)} `, width));

					// Data rows (scrolled)
					const startRow = Math.max(0, cursorRow - Math.floor(maxVisibleRows / 2));
					const endRow = Math.min(table.rows.length, startRow + maxVisibleRows);

					for (let ri = startRow; ri < endRow; ri++) {
						const row = table.rows[ri] ?? [];
						const cells = table.headers.map((_, ci) => {
							const txt = stripMarkdownInline(row[ci] ?? "");
							const padded = txt.slice(0, colWidths[ci]).padEnd(colWidths[ci]);
							const highlighted = cursorRow === ri && cursorCol === ci;
							if (highlighted) return theme.bg("selectedBg", theme.fg("accent", padded));
							return theme.fg("text", padded);
						});
						lines.push(pad(` ${cells.join(theme.fg("border", " │ "))} `, width));
					}

					if (table.rows.length > maxVisibleRows) {
						lines.push(pad(
							` ${theme.fg("dim", `(${startRow + 1}-${endRow} of ${table.rows.length})`)} `,
							width,
						));
					}

					// Actions
					lines.push(theme.fg("border", "├" + "─".repeat(innerW) + "┤"));

					const cell = getCellText();
					const preview = cell.length > 50 ? cell.slice(0, 50) + "…" : cell;
					lines.push(pad(` ${theme.fg("muted", "Cell:")} ${theme.fg("text", preview)} `, width));

					lines.push(pad("", width));
					const actions = [
						`${theme.fg("accent", "enter")} copy cell`,
						`${theme.fg("accent", "r")} copy row`,
						`${theme.fg("accent", "c")} copy column`,
						`${theme.fg("accent", "a")} copy all`,
						`${theme.fg("accent", "esc")} back`,
					].join(theme.fg("dim", "  ·  "));
					lines.push(pad(` ${actions} `, width));
					lines.push(theme.fg("border", "╰" + "─".repeat(innerW) + "╯"));

					return lines;
				},

				invalidate() {},

				handleInput(data: string) {
					if (matchesKey(data, Key.escape)) { done(null); return; }

					// Navigation
					if (matchesKey(data, Key.up)) {
						if (cursorRow > -1) { cursorRow--; tui.requestRender(); }
						return;
					}
					if (matchesKey(data, Key.down)) {
						if (cursorRow < table.rows.length - 1) { cursorRow++; tui.requestRender(); }
						return;
					}
					if (matchesKey(data, Key.left)) {
						if (cursorCol > 0) { cursorCol--; tui.requestRender(); }
						return;
					}
					if (matchesKey(data, Key.right)) {
						if (cursorCol < table.headers.length - 1) { cursorCol++; tui.requestRender(); }
						return;
					}

					// Copy actions
					if (matchesKey(data, Key.enter)) { done(getCellText()); return; }
					if (matchesKey(data, "r")) { done(getRowText()); return; }
					if (matchesKey(data, "c")) { done(getColumnText()); return; }
					if (matchesKey(data, "a")) { done(getAllText()); return; }
				},
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "85%", minWidth: 60, maxHeight: "85%" } },
	);

	if (result === null) return;

	try {
		await copyToClipboard(result);
		const lines = result.split("\n").length;
		ctx.ui.notify(`Copied (${lines} line${lines === 1 ? "" : "s"}, ${result.length} chars)`, "info");
	} catch {
		ctx.ui.notify("Failed to copy", "error");
	}
}

// ── Top-Level Picker ─────────────────────────────────────────────────────────

interface PickerItem {
	label: string;
	description: string;
	action: "copy" | "table";
	content: string;
	tableIndex?: number;
}

/** Split text on markdown horizontal rules into sections */
function splitSections(text: string): string[] {
	// Split on ---, ***, ___ (with optional whitespace) that sit on their own line
	const parts = text.split(/\n(?:---+|\*\*\*+|___+)\s*\n/);
	return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function buildPickerItems(text: string, tables: ParsedTable[]): PickerItem[] {
	const items: PickerItem[] = [];

	items.push({
		label: "Full response",
		description: `${text.split("\n").length} lines, ${text.length} chars`,
		action: "copy",
		content: text,
	});

	// Sections split on horizontal rules
	const sections = splitSections(text);
	if (sections.length > 1) {
		for (let i = 0; i < sections.length; i++) {
			const sec = sections[i];
			const preview = sec.split("\n")[0]?.slice(0, 70) ?? "";
			items.push({
				label: `Section ${i + 1}`,
				description: preview,
				action: "copy",
				content: sec,
			});
		}
	}

	// Code blocks
	const codeBlocks = extractCodeBlocks(text);
	for (let i = 0; i < codeBlocks.length; i++) {
		const { lang, code } = codeBlocks[i];
		const preview = code.split("\n")[0]?.slice(0, 70) ?? "";
		items.push({
			label: `Code block${codeBlocks.length > 1 ? ` ${i + 1}` : ""} [${lang}]`,
			description: preview,
			action: "copy",
			content: code,
		});
	}

	// Tables
	for (let ti = 0; ti < tables.length; ti++) {
		const t = tables[ti];
		const prefix = tables.length > 1 ? `Table ${ti + 1}` : "Table";
		items.push({
			label: `${prefix} (${t.rows.length} rows x ${t.headers.length} cols)`,
			description: t.headers.map((h) => stripMarkdownInline(h)).join(", ").slice(0, 70),
			action: "table",
			content: t.raw,
			tableIndex: ti,
		});
	}

	return items;
}

async function showPicker(
	items: PickerItem[],
	ctx: ExtensionCommandContext,
): Promise<PickerItem | null> {
	const selectItems: SelectItem[] = items.map((item, i) => ({
		value: String(i),
		label: item.label,
		description: item.description,
	}));

	return ctx.ui.custom<PickerItem | null>(
		(tui, theme, _kb, done) => {
			const selectList = new SelectList(selectItems, Math.min(selectItems.length, 14), {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done(items[parseInt(item.value, 10)] ?? null);
			selectList.onCancel = () => done(null);

			const pad = (content: string, width: number) =>
				theme.fg("border", "│") + truncateToWidth(content, width - 2, "…", true) + theme.fg("border", "│");

			return {
				render(width: number): string[] {
					const innerW = Math.max(1, width - 2);
					const lines: string[] = [];

					const title = " Copy ";
					const tw = visibleWidth(title);
					const lp = Math.floor((innerW - tw) / 2);
					const rp = Math.max(0, innerW - tw - lp);
					lines.push(
						theme.fg("border", "╭" + "─".repeat(lp)) +
						theme.fg("accent", theme.bold(title)) +
						theme.fg("border", "─".repeat(rp) + "╮"),
					);

					for (const ll of selectList.render(innerW)) lines.push(pad(ll, width));

					lines.push(theme.fg("border", "├" + "─".repeat(innerW) + "┤"));
					lines.push(pad(
						` ${theme.fg("dim", "up/down navigate · enter select · esc cancel")}`,
						width,
					));
					lines.push(theme.fg("border", "╰" + "─".repeat(innerW) + "╯"));

					return lines;
				},
				invalidate() { selectList.invalidate(); },
				handleInput(data: string) { selectList.handleInput(data); tui.requestRender(); },
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "65%", minWidth: 50, maxHeight: "80%" } },
	);
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function openPicker(ctx: ExtensionCommandContext): Promise<void> {
	const text = getLastAssistantText(ctx.sessionManager.getBranch());
	if (!text) { ctx.ui.notify("No assistant response to copy", "warning"); return; }

	const tables = extractParsedTables(text);
	const items = buildPickerItems(text, tables);

	// Plain text with no structure — just copy it
	if (items.length === 1) {
		try {
			await copyToClipboard(text);
			ctx.ui.notify(`Copied (${text.split("\n").length} lines)`, "info");
		} catch { ctx.ui.notify("Failed to copy", "error"); }
		return;
	}

	const selected = await showPicker(items, ctx);
	if (!selected) return;

	// Table — open grid dialog
	if (selected.action === "table" && selected.tableIndex !== undefined) {
		await openTableGrid(tables[selected.tableIndex], ctx);
		return;
	}

	// Everything else — copy directly
	try {
		await copyToClipboard(selected.content);
		const lines = selected.content.split("\n").length;
		ctx.ui.notify(`Copied (${lines} line${lines === 1 ? "" : "s"}, ${selected.content.length} chars)`, "info");
	} catch { ctx.ui.notify("Failed to copy", "error"); }
}

async function copyAll(ctx: ExtensionCommandContext): Promise<void> {
	const text = getAllConversationText(ctx.sessionManager.getBranch());
	if (!text.trim()) { ctx.ui.notify("No conversation to copy", "warning"); return; }
	try {
		await copyToClipboard(text);
		ctx.ui.notify(`Copied full conversation (${text.split("\n").length} lines)`, "info");
	} catch { ctx.ui.notify("Failed to copy", "error"); }
}

// ── Main Extension ───────────────────────────────────────────────────────────

const SETTINGS_NAME = "pi-copy-output";

const DEFAULT_SHORTCUT = "ctrl+shift+c";

const SHORTCUT_OPTIONS = [
	"ctrl+shift+c",
	"ctrl+shift+y",
	"ctrl+shift+x",
	"alt+c",
	"alt+shift+c",
	"ctrl+alt+c",
];

export default function copyOutputExtension(pi: ExtensionAPI) {
	// Register settings
	pi.events.emit("pi-extension-settings:register", {
		name: SETTINGS_NAME,
		settings: [
			{
				id: "shortcut",
				label: "Keyboard Shortcut",
				description: "Key combo to open the copy picker (requires /reload to take effect)",
				defaultValue: DEFAULT_SHORTCUT,
				values: SHORTCUT_OPTIONS,
			},
		] satisfies SettingDefinition[],
	});

	// Read configured shortcut
	const shortcut = (getSetting(SETTINGS_NAME, "shortcut", DEFAULT_SHORTCUT) ?? DEFAULT_SHORTCUT) as KeyId;

	pi.registerCommand("copy", {
		description: "Copy assistant output to clipboard",
		getArgumentCompletions: (prefix) => {
			const subs = [{ value: "all", label: "all", description: "Copy full conversation" }];
			const filtered = subs.filter((s) => s.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) { ctx.ui.notify("pi-copy-output requires interactive mode", "error"); return; }
			switch (args.trim()) {
				case "all": await copyAll(ctx); break;
				case "": await openPicker(ctx); break;
				default: ctx.ui.notify(`Unknown: "${args.trim()}". Try /copy or /copy all`, "warning");
			}
		},
	});

	pi.registerShortcut(shortcut, {
		description: "Copy assistant output to clipboard",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			await openPicker(ctx as unknown as ExtensionCommandContext);
		},
	});
}
