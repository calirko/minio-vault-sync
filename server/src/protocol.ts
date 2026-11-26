// Sync-protocol constants and helpers that must match the Obsidian plugin exactly.
//
// These are copied from ../../src/sync.ts instead of imported, because that module also
// pulls in the plugin's S3 client, which imports `obsidian` and can't load in Node. If
// you change the tombstone layout in the plugin, change it here too.

export const TOMBSTONE_PREFIX = '.minio-vault-sync-tombstones';

export function tombstoneKeyFor(path: string): string {
	return `${TOMBSTONE_PREFIX}/${path}`;
}

export function isTombstoneKey(key: string): boolean {
	return key === TOMBSTONE_PREFIX || key.startsWith(`${TOMBSTONE_PREFIX}/`);
}
