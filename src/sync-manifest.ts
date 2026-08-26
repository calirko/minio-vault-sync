import type { DataAdapter } from 'obsidian';

export interface SyncManifestEntry {
	/** Local file mtime (ms) as of the last successful sync of this path. */
	localMtime: number;
	/** Remote object ETag as of the last successful sync of this path. */
	remoteEtag: string;
	size: number;
}

export interface SyncManifest {
	version: 1;
	entries: Record<string, SyncManifestEntry>;
}

function emptyManifest(): SyncManifest {
	return { version: 1, entries: {} };
}

/** Local, non-synced record of per-file sync state. Stored inside the plugin's own excluded directory. */
export class SyncManifestStore {
	constructor(
		private adapter: DataAdapter,
		private manifestPath: string,
	) {}

	async load(): Promise<SyncManifest> {
		try {
			if (!(await this.adapter.exists(this.manifestPath))) return emptyManifest();
			const raw = await this.adapter.read(this.manifestPath);
			const parsed = JSON.parse(raw);
			if (parsed && parsed.version === 1 && parsed.entries) return parsed as SyncManifest;
			return emptyManifest();
		} catch {
			return emptyManifest();
		}
	}

	async save(manifest: SyncManifest): Promise<void> {
		const dir = this.manifestPath.slice(0, this.manifestPath.lastIndexOf('/'));
		if (dir && !(await this.adapter.exists(dir))) {
			await this.adapter.mkdir(dir);
		}
		await this.adapter.write(this.manifestPath, JSON.stringify(manifest));
	}
}
