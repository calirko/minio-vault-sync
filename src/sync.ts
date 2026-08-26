import { Client, CopyDestinationOptions, CopySourceOptions } from 'minio';
import type { Readable } from 'stream';
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

function streamToBuffer(stream: Readable): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on('data', (chunk) => chunks.push(chunk as Buffer));
		stream.on('end', () => resolve(Buffer.concat(chunks)));
		stream.on('error', reject);
	});
}

/** Thin wrapper around the MinIO client. */
export class SyncEngine {
	private client: Client;
	private bucket: string;

	constructor(settings: MinioSyncSettings) {
		this.client = new Client({
			endPoint: settings.endpoint,
			port: settings.port,
			useSSL: settings.useSSL,
			accessKey: settings.accessKey,
			secretKey: settings.secretKey,
		});
		this.bucket = settings.bucket;
	}

	async testConnection(): Promise<boolean> {
		return this.client.bucketExists(this.bucket);
	}

	/** Lists every object in the bucket, tombstone keys included as-is. */
	async listRemote(): Promise<Map<string, RemoteEntry>> {
		const entries = new Map<string, RemoteEntry>();
		await new Promise<void>((resolve, reject) => {
			const stream = this.client.listObjectsV2(this.bucket, '', true);
			stream.on('data', (item) => {
				if (!item.name) return;
				entries.set(item.name, {
					path: item.name,
					etag: (item.etag ?? '').replace(/"/g, ''),
					lastModified: item.lastModified ? item.lastModified.getTime() : 0,
					size: item.size ?? 0,
				});
			});
			stream.on('end', () => resolve());
			stream.on('error', reject);
		});
		return entries;
	}

	async statRemote(path: string): Promise<{ etag: string } | null> {
		try {
			const stat = await this.client.statObject(this.bucket, path);
			return { etag: (stat.etag ?? '').replace(/"/g, '') };
		} catch {
			return null;
		}
	}

	async downloadToBuffer(path: string): Promise<Buffer> {
		const stream = await this.client.getObject(this.bucket, path);
		return streamToBuffer(stream);
	}

	async upload(path: string, data: Buffer, localMtimeMs: number): Promise<{ etag: string }> {
		const info = await this.client.putObject(this.bucket, path, data, data.length, {
			mtime: String(localMtimeMs),
		});
		return { etag: (info.etag ?? '').replace(/"/g, '') };
	}

	/** Renames the object to a tombstone key rather than truly deleting it, so other devices can detect the delete. */
	async tombstone(path: string): Promise<void> {
		const dest = new CopyDestinationOptions({ Bucket: this.bucket, Object: tombstoneKeyFor(path) });
		const source = new CopySourceOptions({ Bucket: this.bucket, Object: path });
		try {
			await this.client.copyObject(source, dest);
		} catch (err) {
			// Nothing was ever pushed for this path (e.g. created and deleted before the
			// debounce fired) — there's nothing remote to tombstone, so this is a no-op.
			if ((err as { code?: string }).code === 'NoSuchKey' || (err as { code?: string }).code === 'NotFound') return;
			throw err;
		}
		await this.client.removeObject(this.bucket, path);
	}

	/** Removes a tombstone marker, used when a local edit revives a remotely-deleted file. */
	async removeTombstone(path: string): Promise<void> {
		await this.client.removeObject(this.bucket, tombstoneKeyFor(path));
	}
}
