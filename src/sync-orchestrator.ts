import { App, Notice } from 'obsidian';
import type { SyncEngine } from './sync';
import { SyncManifestStore, type SyncManifest } from './sync-manifest';
import { listLocalTree } from './local-scan';
import { decideAction } from './sync-decide';
import { conflictPathFor, isTombstoneKey, originalPathFromTombstoneKey } from './sync';
import { md5Hex } from './md5';
import { emptySummary, type LocalEntry, type SyncSummary } from './sync-types';

const PUSH_DEBOUNCE_MS = 10_000;
const SUPPRESSION_EXPIRY_MS = 2_000;

export class SyncOrchestrator {
	private manifestStore: SyncManifestStore;
	private debounceTimers = new Map<string, ReturnType<typeof window.setTimeout>>();
	private suppressedPaths = new Map<string, ReturnType<typeof window.setTimeout>>();
	private opQueue: Promise<void> = Promise.resolve();

	constructor(
		private app: App,
		private engine: SyncEngine,
		manifestPath: string,
		private deviceNickname: string,
		private excludePrefixes: string[],
	) {
		this.manifestStore = new SyncManifestStore(app.vault.adapter, manifestPath);
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.opQueue.then(fn, fn);
		this.opQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private markSuppressed(path: string) {
		const existing = this.suppressedPaths.get(path);
		if (existing) window.clearTimeout(existing);
		const timer = window.setTimeout(() => this.suppressedPaths.delete(path), SUPPRESSION_EXPIRY_MS);
		this.suppressedPaths.set(path, timer);
	}

	/** Consumes the suppression flag for a path, if any. Call from vault event handlers to swallow self-writes. */
	wasSelfWrite(path: string): boolean {
		const timer = this.suppressedPaths.get(path);
		if (!timer) return false;
		window.clearTimeout(timer);
		this.suppressedPaths.delete(path);
		return true;
	}

	scheduleDebouncedPush(path: string) {
		if (this.isExcluded(path)) return;
		const existing = this.debounceTimers.get(path);
		if (existing) window.clearTimeout(existing);
		const timer = window.setTimeout(() => {
			this.debounceTimers.delete(path);
			this.pushSingleFile(path).catch((err) => new Notice(`MinIO sync: failed to push ${path}: ${(err as Error).message}`));
		}, PUSH_DEBOUNCE_MS);
		this.debounceTimers.set(path, timer);
	}

	cancelPendingDebounces() {
		for (const timer of this.debounceTimers.values()) window.clearTimeout(timer);
		this.debounceTimers.clear();
		for (const timer of this.suppressedPaths.values()) window.clearTimeout(timer);
		this.suppressedPaths.clear();
	}

	private isExcluded(path: string): boolean {
		return this.excludePrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
	}

	async pushSingleFile(path: string): Promise<void> {
		if (this.isExcluded(path)) return;
		return this.enqueue(async () => {
			const stat = await this.app.vault.adapter.stat(path);
			if (!stat) return;
			const manifest = await this.manifestStore.load();
			const bytes = await this.app.vault.adapter.readBinary(path);
			const { etag } = await this.engine.upload(path, bytes, stat.mtime);
			manifest.entries[path] = { localMtime: stat.mtime, remoteEtag: etag, size: bytes.byteLength };
			await this.manifestStore.save(manifest);
		});
	}

	async deleteSingleFile(path: string): Promise<void> {
		if (this.isExcluded(path)) return;
		return this.enqueue(async () => {
			const timer = this.debounceTimers.get(path);
			if (timer) {
				window.clearTimeout(timer);
				this.debounceTimers.delete(path);
			}
			await this.engine.tombstone(path);
			const manifest = await this.manifestStore.load();
			delete manifest.entries[path];
			await this.manifestStore.save(manifest);
		});
	}

	async renameFile(oldPath: string, newPath: string): Promise<void> {
		await this.deleteSingleFile(oldPath);
		await this.pushSingleFile(newPath);
	}

	/** Single-word sync status for one path, used by the status bar. */
	async getSyncStatus(path: string): Promise<'synced' | 'unsynced'> {
		if (this.isExcluded(path)) return 'synced';
		if (this.debounceTimers.has(path)) return 'unsynced';

		const stat = await this.app.vault.adapter.stat(path);
		if (!stat) return 'unsynced';

		const manifest = await this.manifestStore.load();
		const entry = manifest.entries[path];
		if (!entry || entry.localMtime !== stat.mtime) return 'unsynced';

		return 'synced';
	}

	async runFullSync(): Promise<SyncSummary> {
		return this.enqueue(() => this.runFullSyncInner());
	}

	private async runFullSyncInner(): Promise<SyncSummary> {
		const summary = emptySummary();
		const adapter = this.app.vault.adapter;

		const [localEntries, remoteEntriesRaw, manifest] = await Promise.all([
			listLocalTree(adapter, this.excludePrefixes),
			this.engine.listRemote(),
			this.manifestStore.load(),
		]);

		const localByPath = new Map<string, LocalEntry>(localEntries.map((e) => [e.path, e]));
		const tombstonedPaths = new Set<string>();
		const remoteByPath = new Map<string, { path: string; etag: string; lastModified: number; size: number }>();
		for (const [key, entry] of remoteEntriesRaw) {
			if (isTombstoneKey(key)) {
				tombstonedPaths.add(originalPathFromTombstoneKey(key));
			} else {
				remoteByPath.set(key, entry);
			}
		}

		const allPaths = new Set<string>([
			...localByPath.keys(),
			...remoteByPath.keys(),
			...tombstonedPaths,
			...Object.keys(manifest.entries),
		]);

		for (const path of allPaths) {
			try {
				await this.applyForPath(path, localByPath.get(path), remoteByPath.get(path), tombstonedPaths.has(path), manifest, summary);
			} catch (err) {
				summary.errors.push({ path, message: (err as Error).message });
			}
		}

		await this.manifestStore.save(manifest);

		if (summary.conflicts.length > 0) {
			new Notice(`MinIO sync: ${summary.conflicts.length} conflict(s) need manual review — see files prefixed "${this.deviceNickname}__"`);
		}

		return summary;
	}

	private async applyForPath(
		path: string,
		local: LocalEntry | undefined,
		remote: { path: string; etag: string; lastModified: number; size: number } | undefined,
		remoteTombstoned: boolean,
		manifest: SyncManifest,
		summary: SyncSummary,
	): Promise<void> {
		const adapter = this.app.vault.adapter;
		const manifestEntry = manifest.entries[path];

		const localHash = async () => {
			const bytes = await adapter.readBinary(path);
			return md5Hex(bytes);
		};

		const action = await decideAction(path, local, remote, remoteTombstoned, manifestEntry, localHash);

		switch (action.type) {
			case 'noop':
				return;

			case 'reconcile-manifest':
				manifest.entries[path] = { localMtime: action.localMtime, remoteEtag: action.remoteEtag, size: action.size };
				return;

			case 'push': {
				if (!local) return;
				const bytes = await adapter.readBinary(path);
				const { etag } = await this.engine.upload(path, bytes, local.mtime);
				manifest.entries[path] = { localMtime: local.mtime, remoteEtag: etag, size: bytes.byteLength };
				summary.pushed.push(path);
				return;
			}

			case 'pull': {
				const bytes = await this.engine.downloadToBuffer(path);
				await this.ensureParentFolder(path);
				this.markSuppressed(path);
				await adapter.writeBinary(path, bytes);
				const stat = await adapter.stat(path);
				manifest.entries[path] = { localMtime: stat?.mtime ?? Date.now(), remoteEtag: remote?.etag ?? '', size: bytes.byteLength };
				summary.pulled.push(path);
				return;
			}

			case 'tombstone-remote':
				await this.engine.tombstone(path);
				delete manifest.entries[path];
				summary.tombstoned.push(path);
				return;

			case 'delete-local':
				this.markSuppressed(path);
				await adapter.remove(path);
				delete manifest.entries[path];
				summary.deletedLocal.push(path);
				return;

			case 'revive-local': {
				if (!local) return;
				const bytes = await adapter.readBinary(path);
				const { etag } = await this.engine.upload(path, bytes, local.mtime);
				await this.engine.removeTombstone(path);
				manifest.entries[path] = { localMtime: local.mtime, remoteEtag: etag, size: bytes.byteLength };
				summary.revived.push(path);
				return;
			}

			case 'conflict':
				await this.resolveConflict(path, manifest, summary);
				return;
		}
	}

	private async resolveConflict(path: string, manifest: SyncManifest, summary: SyncSummary): Promise<void> {
		const adapter = this.app.vault.adapter;
		const bytes = await adapter.readBinary(path);

		let conflictPath = conflictPathFor(path, this.deviceNickname || 'device');
		if (await adapter.exists(conflictPath)) {
			conflictPath = conflictPathFor(path, this.deviceNickname || 'device', String(Date.now()));
		}

		this.markSuppressed(path);
		this.markSuppressed(conflictPath);

		await adapter.rename(path, conflictPath);
		const conflictStat = await adapter.stat(conflictPath);
		const localMtimeOfBytes = conflictStat?.mtime ?? Date.now();
		const { etag: conflictEtag } = await this.engine.upload(conflictPath, bytes, localMtimeOfBytes);

		const remoteBytes = await this.engine.downloadToBuffer(path);
		await adapter.writeBinary(path, remoteBytes);
		const originalStat = await adapter.stat(path);

		const remoteMeta = await this.engine.statRemote(path);
		manifest.entries[path] = {
			localMtime: originalStat?.mtime ?? Date.now(),
			remoteEtag: remoteMeta?.etag ?? '',
			size: remoteBytes.byteLength,
		};
		manifest.entries[conflictPath] = { localMtime: localMtimeOfBytes, remoteEtag: conflictEtag, size: bytes.byteLength };

		summary.conflicts.push(path);
	}

	private async ensureParentFolder(path: string): Promise<void> {
		const idx = path.lastIndexOf('/');
		if (idx === -1) return;
		const dir = path.slice(0, idx);
		if (!(await this.app.vault.adapter.exists(dir))) {
			await this.app.vault.adapter.mkdir(dir);
		}
	}
}
