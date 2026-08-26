export interface LocalEntry {
	path: string;
	mtime: number;
	size: number;
}

export interface RemoteEntry {
	path: string;
	etag: string;
	lastModified: number;
	size: number;
}

export type SyncAction =
	| { type: 'push'; path: string }
	| { type: 'pull'; path: string }
	| { type: 'conflict'; path: string }
	| { type: 'tombstone-remote'; path: string }
	| { type: 'delete-local'; path: string }
	| { type: 'revive-local'; path: string }
	| { type: 'reconcile-manifest'; path: string; localMtime: number; remoteEtag: string; size: number }
	| { type: 'noop'; path: string };

export interface SyncSummary {
	pushed: string[];
	pulled: string[];
	tombstoned: string[];
	deletedLocal: string[];
	revived: string[];
	conflicts: string[];
	errors: Array<{ path: string; message: string }>;
}

export function emptySummary(): SyncSummary {
	return { pushed: [], pulled: [], tombstoned: [], deletedLocal: [], revived: [], conflicts: [], errors: [] };
}
