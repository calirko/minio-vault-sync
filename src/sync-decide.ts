import type { SyncAction, LocalEntry, RemoteEntry } from './sync-types';
import type { SyncManifestEntry } from './sync-manifest';

/**
 * Pure decision function: given the state of one path on both sides plus what we last
 * knew we'd synced, decide what to do. `localHash` is only invoked (lazily) when both
 * sides have the file and we need to tell a real conflict apart from identical content.
 */
export async function decideAction(
	path: string,
	local: LocalEntry | undefined,
	remote: RemoteEntry | undefined,
	remoteTombstoned: boolean,
	manifestEntry: SyncManifestEntry | undefined,
	localHash: () => Promise<string>,
): Promise<SyncAction> {
	if (remoteTombstoned) {
		if (!local) return { type: 'noop', path };
		if (!manifestEntry || local.mtime === manifestEntry.localMtime) {
			return { type: 'delete-local', path };
		}
		// Local was edited after the remote delete happened elsewhere: edit beats delete.
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
			if (hash === remote.etag) {
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
		if (hash === remote.etag) {
			return { type: 'reconcile-manifest', path, localMtime: local.mtime, remoteEtag: remote.etag, size: local.size };
		}
		return { type: 'conflict', path };
	}

	return { type: 'noop', path };
}
