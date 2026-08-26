import { S3Client } from './s3-client';
import type { MinioSyncSettings } from './settings';
import type { RemoteEntry } from './sync-types';

export const TOMBSTONE_PREFIX = '__deleted__';

function splitPath(path: string): { dir: string; base: string } {
	const idx = path.lastIndexOf('/');
	if (idx === -1) return { dir: '', base: path };
	return { dir: path.slice(0, idx), base: path.slice(idx + 1) };
}

function joinPath(dir: string, base: string): string {
	return dir ? `${dir}/${base}` : base;
}

export function tombstoneKeyFor(path: string): string {
	const { dir, base } = splitPath(path);
	return joinPath(dir, `${TOMBSTONE_PREFIX}${base}`);
}

export function isTombstoneKey(key: string): boolean {
	const { base } = splitPath(key);
	return base.startsWith(TOMBSTONE_PREFIX);
}

export function originalPathFromTombstoneKey(key: string): string {
	const { dir, base } = splitPath(key);
	return joinPath(dir, base.slice(TOMBSTONE_PREFIX.length));
}

export function conflictPathFor(path: string, deviceNickname: string, disambiguator?: string): string {
	const { dir, base } = splitPath(path);
	const prefix = disambiguator ? `${deviceNickname}-${disambiguator}__` : `${deviceNickname}__`;
	return joinPath(dir, `${prefix}${base}`);
}

/** Thin wrapper around the hand-rolled S3 client, exposing sync-shaped operations. */
export class SyncEngine {
	private client: S3Client;

	constructor(settings: MinioSyncSettings) {
		this.client = new S3Client({
			endpoint: settings.endpoint,
			port: settings.port,
			useSSL: settings.useSSL,
			accessKey: settings.accessKey,
			secretKey: settings.secretKey,
			bucket: settings.bucket,
		});
	}

	async testConnection(): Promise<boolean> {
		return this.client.bucketExists();
	}

	/** Lists every object in the bucket, tombstone keys included as-is. */
	async listRemote(): Promise<Map<string, RemoteEntry>> {
		const entries = new Map<string, RemoteEntry>();
		for (const obj of await this.client.listAllObjects()) {
			entries.set(obj.key, { path: obj.key, etag: obj.etag, lastModified: obj.lastModified, size: obj.size });
		}
		return entries;
	}

	async statRemote(path: string): Promise<{ etag: string } | null> {
		return this.client.statObject(path);
	}

	async downloadToBuffer(path: string): Promise<ArrayBuffer> {
		return this.client.getObject(path);
	}

	async upload(path: string, data: ArrayBuffer, localMtimeMs: number): Promise<{ etag: string }> {
		return this.client.putObject(path, data, { 'x-amz-meta-mtime': String(localMtimeMs) });
	}

	/** Renames the object to a tombstone key rather than truly deleting it, so other devices can detect the delete. */
	async tombstone(path: string): Promise<void> {
		const copied = await this.client.copyObject(path, tombstoneKeyFor(path));
		// Nothing was ever pushed for this path (e.g. created and deleted before the
		// debounce fired) — there's nothing remote to tombstone, so this is a no-op.
		if (!copied) return;
		await this.client.deleteObject(path);
	}

	/** Removes a tombstone marker, used when a local edit revives a remotely-deleted file. */
	async removeTombstone(path: string): Promise<void> {
		await this.client.deleteObject(tombstoneKeyFor(path));
	}
}
