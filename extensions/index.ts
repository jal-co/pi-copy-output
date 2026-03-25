/**
 * pi-copy-output — One picker, everything copyable
 *
 * Commands:
 *   /copy              - Smart picker: all copyable content from last response
 *   /copy all          - Copy full conversation (no picker)
 *
 * Shortcut:
 *   ctrl+shift+c       - Same as /copy — opens the picker
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
	type SelectItem,
	SelectList,
	matchesKey,
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

// ── Copyable Item ────────────────────────────────────────────────────────────

interface CopyableItem {
	label: string;       // What the user sees in the picker
	description: string; // Secondary line
	content: string;     // What gets copied
}

// ── Parsers ──────────────────────────────────────────────────────────────────

/** Strip markdown bold/italic/links for cleaner copy content */
function stripMarkdownInline(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, "$1")      // **bold**
		.replace(/\*([^*]+)\*/g, "$1")            // *italic*
		.replace(/`([^`]+)`/g, "$1")              // `code`
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // [text](url)
}

/** Parse a markdown pipe table row into trimmed cell values */
function parseTableRow(line: string): string[] {
	return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** Check if a row is a separator (|---|---| etc) */
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

// ── Build Flat List ──────────────────────────────────────────────────────────

function buildCopyableItems(text: string): CopyableItem[] {
	const items: CopyableItem[] = [];

	// 1. Full response — always first
	items.push({
		label: "Full response",
		description: `${text.split("\n").length} lines, ${text.length} chars`,
		content: text,
	});

	// 2. Code blocks
	const codeBlocks = extractCodeBlocks(text);
	for (let i = 0; i < codeBlocks.length; i++) {
		const { lang, code } = codeBlocks[i];
		const preview = code.split("\n")[0]?.slice(0, 70) ?? "";
		items.push({
			label: `Code block${codeBlocks.length > 1 ? ` ${i + 1}` : ""} [${lang}]`,
			description: preview,
			content: code,
		});
	}

	// 3. Tables — flatten into readable items
	const tables = extractParsedTables(text);
	for (let ti = 0; ti < tables.length; ti++) {
		const table = tables[ti];
		const tablePrefix = tables.length > 1 ? `Table ${ti + 1}: ` : "";

		// Full table as markdown
		items.push({
			label: `${tablePrefix}Full table (markdown)`,
			description: `${table.rows.length} rows × ${table.headers.length} cols`,
			content: table.raw,
		});

		// Full table as flat list: "Header: value" per row
		const flatRows = table.rows.map((row) =>
			table.headers.map((h, ci) => `${stripMarkdownInline(h)}: ${stripMarkdownInline(row[ci] ?? "")}`).join("\n"),
		);
		items.push({
			label: `${tablePrefix}Full table (flat list)`,
			description: `Each row as "header: value"`,
			content: flatRows.join("\n\n"),
		});

		// Each column as a list
		for (let ci = 0; ci < table.headers.length; ci++) {
			const header = stripMarkdownInline(table.headers[ci]);
			const values = table.rows.map((row) => stripMarkdownInline(row[ci] ?? ""));
			items.push({
				label: `  ┗ Column: ${header}`,
				description: values.slice(0, 3).join(", ") + (values.length > 3 ? "…" : ""),
				content: values.join("\n"),
			});
		}

		// Each row as flat "header: value" pairs
		for (let ri = 0; ri < table.rows.length; ri++) {
			const row = table.rows[ri];
			const firstCell = stripMarkdownInline(row[0] ?? `Row ${ri + 1}`);
			const flat = table.headers.map((h, ci) =>
				`${stripMarkdownInline(h)}: ${stripMarkdownInline(row[ci] ?? "")}`,
			).join("\n");
			items.push({
				label: `  ┗ Row: ${firstCell.slice(0, 50)}`,
				description: flat.replace(/\n/g, " · ").slice(0, 80),
				content: flat,
			});
		}
	}

	return items;
}

// ── Picker UI ────────────────────────────────────────────────────────────────

async function showPicker(
	items: CopyableItem[],
	ctx: ExtensionCommandContext,
): Promise<CopyableItem | null> {
	const selectItems: SelectItem[] = items.map((item, i) => ({
		value: String(i),
		label: item.label,
		description: item.description,
	}));

	return ctx.ui.custom<CopyableItem | null>(
		(tui, theme, _kb, done) => {
			const selectList = new SelectList(selectItems, Math.min(selectItems.length, 16), {
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
					const titleW = visibleWidth(title);
					const lp = Math.floor((innerW - titleW) / 2);
					const rp = Math.max(0, innerW - titleW - lp);
					lines.push(
						theme.fg("border", "╭" + "─".repeat(lp)) +
						theme.fg("accent", theme.bold(title)) +
						theme.fg("border", "─".repeat(rp) + "╮"),
					);

					for (const ll of selectList.render(innerW)) lines.push(pad(ll, width));

					lines.push(theme.fg("border", "├" + "─".repeat(innerW) + "┤"));
					lines.push(pad(
						` ${theme.fg("dim", "↑↓ navigate • enter copy • esc cancel")}`,
						width,
					));
					lines.push(theme.fg("border", "╰" + "─".repeat(innerW) + "╯"));

					return lines;
				},
				invalidate() { selectList.invalidate(); },
				handleInput(data: string) { selectList.handleInput(data); tui.requestRender(); },
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 50, maxHeight: "80%" } },
	);
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function openPicker(ctx: ExtensionCommandContext): Promise<void> {
	const text = getLastAssistantText(ctx.sessionManager.getBranch());
	if (!text) { ctx.ui.notify("No assistant response to copy", "warning"); return; }

	const items = buildCopyableItems(text);

	// If the response is just plain text (no tables, no code), skip the picker
	if (items.length === 1) {
		try {
			await copyToClipboard(text);
			ctx.ui.notify(`✓ Copied (${text.split("\n").length} lines)`, "info");
		} catch { ctx.ui.notify("✗ Failed to copy", "error"); }
		return;
	}

	const selected = await showPicker(items, ctx);
	if (!selected) return;

	try {
		await copyToClipboard(selected.content);
		const lines = selected.content.split("\n").length;
		ctx.ui.notify(`✓ Copied (${lines} line${lines === 1 ? "" : "s"}, ${selected.content.length} chars)`, "info");
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

// ── Main Extension ───────────────────────────────────────────────────────────

export default function copyOutputExtension(pi: ExtensionAPI) {
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
				default: ctx.ui.notify(`Unknown subcommand "${args.trim()}". Try: /copy or /copy all`, "warning");
			}
		},
	});

	pi.registerShortcut("ctrl+shift+c", {
		description: "Copy assistant output to clipboard",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			await openPicker(ctx as unknown as ExtensionCommandContext);
		},
	});
}
