import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Vault, VaultError } from './vault.js';

function ok(text: string): CallToolResult {
	return { content: [{ type: 'text', text }] };
}

function fail(text: string): CallToolResult {
	return { content: [{ type: 'text', text }], isError: true };
}

/** Turns expected vault errors into tool errors Claude can act on; logs anything else. */
async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof VaultError) return fail(err.message);
		console.error(err);
		return fail('Unexpected server error while talking to the storage backend.');
	}
}

const INSTRUCTIONS = `Tools for the user's Obsidian vault. Paths are vault-relative, e.g. "Projects/Plan.md".
Before doing anything else in the vault, read "note.md" at the vault root: it explains this vault's conventions (structure, where new notes go, naming, tags). Follow it; where it conflicts with the general guidance below, it wins. If it does not exist, carry on with the guidance below.
Notes are Markdown with Obsidian conventions ([[wikilinks]], #tags, YAML frontmatter).
Before changing an existing note, read it: write_file and edit_file need the etag that read_file returned, and fail if the note changed in the meantime (re-read and retry).
Prefer edit_file or append_to_file over rewriting a whole note. Changes sync to the user's devices within the plugin's sync interval.`;

export function createMcpServer(vault: Vault): McpServer {
	const server = new McpServer({ name: 'obsidian-vault', version: '0.1.0' }, { instructions: INSTRUCTIONS });

	server.registerTool(
		'list_files',
		{
			title: 'List vault files',
			description: 'List files in the vault, optionally under a folder. Returns path, size and last-modified time.',
			inputSchema: {
				folder: z.string().optional().describe('Folder to list, e.g. "Projects". Omit for the whole vault.'),
				limit: z.number().int().min(1).max(5000).optional().describe('Max files to return (default 500).'),
			},
			annotations: { readOnlyHint: true },
		},
		({ folder, limit }) =>
			run(async () => {
				const files = await vault.list(vault.normalizePrefix(folder));
				const max = limit ?? 500;
				const lines = files.slice(0, max).map((f) => `${f.path}\t${f.size}B\t${f.lastModified ?? ''}`);
				if (files.length > max) lines.push(`… ${files.length - max} more (narrow with folder or raise limit)`);
				return ok(lines.length ? lines.join('\n') : 'No files.');
			}),
	);

	server.registerTool(
		'read_file',
		{
			title: 'Read a note',
			description: 'Read a text file from the vault. Returns its content and etag (needed to edit or overwrite it).',
			inputSchema: { path: z.string().describe('Vault-relative path, e.g. "Daily/2026-11-26.md".') },
			annotations: { readOnlyHint: true },
		},
		({ path }) =>
			run(async () => {
				const p = vault.normalizePath(path);
				const { content, info } = await vault.readText(p);
				return ok(`path: ${p}\netag: ${info.etag}\nlastModified: ${info.lastModified ?? ''}\n---\n${content}`);
			}),
	);

	server.registerTool(
		'search',
		{
			title: 'Search notes',
			description:
				'Search the text of Markdown/text/canvas files (and file names). Returns matching lines with line numbers.',
			inputSchema: {
				query: z.string().min(1).describe('Text to find (or a regex if regex is true).'),
				folder: z.string().optional().describe('Limit the search to this folder.'),
				regex: z.boolean().optional(),
				case_sensitive: z.boolean().optional(),
				max_results: z.number().int().min(1).max(500).optional().describe('Default 50.'),
			},
			annotations: { readOnlyHint: true },
		},
		({ query, folder, regex, case_sensitive, max_results }) =>
			run(async () => {
				const res = await vault.search(query, {
					prefix: vault.normalizePrefix(folder),
					regex,
					caseSensitive: case_sensitive,
					maxResults: max_results,
				});
				if (!res.matches.length) return ok(`No matches (${res.filesScanned} files scanned).`);
				const lines = res.matches.map((m) => (m.line ? `${m.path}:${m.line}: ${m.text}` : `${m.path}: ${m.text}`));
				if (res.truncated) lines.push('… more matches omitted; narrow the query or raise max_results.');
				return ok(lines.join('\n'));
			}),
	);

	if (vault.readOnly) return server;

	server.registerTool(
		'write_file',
		{
			title: 'Create or overwrite a note',
			description:
				'Create a new file, or overwrite an existing one. To overwrite, pass the etag from read_file; omit etag only when creating a new file.',
			inputSchema: {
				path: z.string(),
				content: z.string(),
				etag: z.string().optional().describe('Etag from read_file. Required when the file already exists.'),
			},
			annotations: { destructiveHint: true, idempotentHint: false },
		},
		({ path, content, etag }) =>
			run(async () => {
				const p = vault.normalizePath(path);
				const newEtag = await vault.writeText(p, content, etag ?? null);
				return ok(`${etag ? 'Updated' : 'Created'} ${p} (etag: ${newEtag})`);
			}),
	);

	server.registerTool(
		'edit_file',
		{
			title: 'Edit part of a note',
			description:
				'Replace an exact snippet of text in a file. old_text must match exactly once unless replace_all is true. Pass the etag from read_file.',
			inputSchema: {
				path: z.string(),
				old_text: z.string().min(1),
				new_text: z.string(),
				etag: z.string().describe('Etag from read_file.'),
				replace_all: z.boolean().optional(),
			},
			annotations: { destructiveHint: true, idempotentHint: false },
		},
		({ path, old_text, new_text, etag, replace_all }) =>
			run(async () => {
				const p = vault.normalizePath(path);
				const { content, info } = await vault.readText(p);
				if (info.etag !== etag.replace(/"/g, '')) {
					return fail(`File changed since you read it: ${p}. Read it again and reapply your edit.`);
				}
				const count = content.split(old_text).length - 1;
				if (count === 0) return fail('old_text was not found in the file.');
				if (count > 1 && !replace_all) {
					return fail(`old_text matches ${count} times; add more context or set replace_all.`);
				}
				const updated = replace_all ? content.split(old_text).join(new_text) : content.replace(old_text, () => new_text);
				const newEtag = await vault.writeText(p, updated, info.etag);
				return ok(`Edited ${p} (${replace_all ? count : 1} replacement${count > 1 && replace_all ? 's' : ''}, etag: ${newEtag})`);
			}),
	);

	server.registerTool(
		'append_to_file',
		{
			title: 'Append to a note',
			description: 'Append text to the end of a file, creating it if it does not exist. Good for logs, inboxes and daily notes.',
			inputSchema: { path: z.string(), content: z.string() },
			annotations: { destructiveHint: false, idempotentHint: false },
		},
		({ path, content }) =>
			run(async () => {
				const p = vault.normalizePath(path);
				// Retry a couple of times if a device writes the note at the same moment.
				for (let attempt = 0; attempt < 3; attempt++) {
					const existing = await vault.stat(p);
					try {
						if (!existing) {
							const etag = await vault.writeText(p, content, null);
							return ok(`Created ${p} (etag: ${etag})`);
						}
						const { content: current, info } = await vault.readText(p);
						const sep = current === '' || current.endsWith('\n') ? '' : '\n';
						const etag = await vault.writeText(p, current + sep + content, info.etag);
						return ok(`Appended to ${p} (etag: ${etag})`);
					} catch (err) {
						if (!(err instanceof VaultError) || !/changed|exists/.test(err.message) || attempt === 2) throw err;
					}
				}
				return fail('Could not append after retries.');
			}),
	);

	server.registerTool(
		'move_file',
		{
			title: 'Move or rename a file',
			description: 'Move or rename a file. Fails if the destination exists. Does not rewrite links pointing at the old path.',
			inputSchema: { from: z.string(), to: z.string() },
			annotations: { destructiveHint: true, idempotentHint: false },
		},
		({ from, to }) =>
			run(async () => {
				const src = vault.normalizePath(from);
				const dst = vault.normalizePath(to);
				await vault.move(src, dst);
				return ok(`Moved ${src} → ${dst}`);
			}),
	);

	server.registerTool(
		'delete_file',
		{
			title: 'Delete a file',
			description: 'Delete a file from the vault. The delete syncs to all devices.',
			inputSchema: { path: z.string() },
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		({ path }) =>
			run(async () => {
				const p = vault.normalizePath(path);
				await vault.delete(p);
				return ok(`Deleted ${p}`);
			}),
	);

	return server;
}
