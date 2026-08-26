import type { SyncAction, LocalEntry, RemoteEntry } from './sync-types';
import type { SyncManifestEntry } from './sync-manifest';

/** S3 ETags for multipart uploads look like "<hex>-<partCount>" and are not an MD5 of the
 * content, so they can never be compared directly against our local MD5. This plugin only
 * ever does single-part PUTs, but a bucket can still contain objects written by something
 * else (mc, rclone, a future large-file path, ...). */
function isMultipartEtag(etag: string): boolean {
	return etag.includes('-');
}

/**
 * Pure decision function: given the state of one path on both sides plus what we last
 * knew we'd synced, decide what to do. `localHash` is only invoked (lazily) when both
 * sides have the file and we need to tell a real conflict apart from identical content.
 * `remoteHash` is only invoked (lazily) when the remote ETag is multipart-shaped and can't
 * be compared to `localHash` directly — it downloads the remote object and hashes its
 * actual bytes instead.
 */
export async function decideAction(
	path: string,
	local: LocalEntry | undefined,
	remote: RemoteEntry | undefined,
	remoteTombstoned: boolean,
	manifestEntry: SyncManifestEntry | undefined,
	localHash: () => Promise<string>,
	remoteHash: () => Promise<string>,
): Promise<SyncAction> {
	if (remoteTombstoned) {
		if (!local) return { type: 'noop', path };
		// Only trust the tombstone as covering *this* local content when we have positive
		// proof it's the same content that was deleted (a manifest entry recorded at the
		// time it was last synced, still matching the file's mtime). Without that proof —
		// e.g. a fresh install against an existing vault, or a lost/reset manifest — we
		// have no idea whether this local file is the one that got deleted elsewhere or
		// unrelated content that happens to share a path, so never destroy it silently:
		// push it back up instead (edit beats delete).
		if (manifestEntry && local.mtime === manifestEntry.localMtime) {
			return { type: 'delete-local', path };
		}
		return { type: 'revive-local', path };
	}

	if (local && !remote) {
		// Absence of a tombstone is never treated as a delete signal — only an explicit
		// tombstone key means "deleted". A brand-new local file or a manually-removed
		// remote object both simply get (re-)pushed.
		return { type: 'push', path };
	}

	if (!local && remote) {
		if (!manifestEntry) return { type: 'pull', path };
		// We knew about this file before, but it's gone locally without a vault event
		// firing (e.g. it lived under .obsidian). Propagate the delete.
		return { type: 'tombstone-remote', path };
	}

	if (local && remote) {
		if (!manifestEntry) {
			const hash = await localHash();
			const contentEqual = isMultipartEtag(remote.etag) ? hash === (await remoteHash()) : hash === remote.etag;
			if (contentEqual) {
				return { type: 'reconcile-manifest', path, localMtime: local.mtime, remoteEtag: remote.etag, size: local.size };
			}
			return { type: 'conflict', path };
		}

		const localChanged = local.mtime !== manifestEntry.localMtime;
		const remoteChanged = remote.etag !== manifestEntry.remoteEtag;

		if (!localChanged && !remoteChanged) return { type: 'noop', path };
		if (localChanged && !remoteChanged) return { type: 'push', path };
		if (!localChanged && remoteChanged) return { type: 'pull', path };

		const hash = await localHash();
		const contentEqual = isMultipartEtag(remote.etag) ? hash === (await remoteHash()) : hash === remote.etag;
		if (contentEqual) {
			return { type: 'reconcile-manifest', path, localMtime: local.mtime, remoteEtag: remote.etag, size: local.size };
		}
		return { type: 'conflict', path };
	}

	return { type: 'noop', path };
}
