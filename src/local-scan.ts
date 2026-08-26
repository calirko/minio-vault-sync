import type { DataAdapter } from 'obsidian';
import type { LocalEntry } from './sync-types';

function isExcluded(path: string, excludePrefixes: string[]): boolean {
	return excludePrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Recursively walks the vault via the raw adapter (so `.obsidian` is included), skipping excluded prefixes. */
export async function listLocalTree(adapter: DataAdapter, excludePrefixes: string[]): Promise<LocalEntry[]> {
	const results: LocalEntry[] = [];

	async function walk(folder: string): Promise<void> {
		if (isExcluded(folder, excludePrefixes)) return;
		const { files, folders } = await adapter.list(folder);

		for (const filePath of files) {
			if (isExcluded(filePath, excludePrefixes)) continue;
			const stat = await adapter.stat(filePath);
			if (!stat) continue;
			results.push({ path: filePath, mtime: stat.mtime, size: stat.size });
		}

		for (const folderPath of folders) {
			await walk(folderPath);
		}
	}

	await walk('');
	return results;
}
