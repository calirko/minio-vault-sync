# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Obsidian plugin (`minio-vault-sync`) that syncs a vault's files to a MinIO (S3-compatible) bucket so the vault can be shared across devices. Works on both desktop and mobile: all S3 access goes through a hand-rolled REST client (`src/s3-client.ts`) built on Obsidian's `requestUrl` and the Web Crypto API, rather than the `minio` npm package (which depends on Node's `net`/`tls`/`fs` and can't run in Obsidian's mobile runtime).

Two-way sync is implemented: startup/interval full sync, debounced push on vault events, tombstone-based delete propagation, and conflict handling (rename-aside + re-download).

## Commands

```
npm install
npm run dev    # esbuild watch build -> main.js (inline sourcemaps)
npm run build  # tsc -noEmit type-check, then production esbuild bundle -> main.js (minified, no sourcemap)
```

There is no test suite or linter configured yet.

To try the plugin in Obsidian: symlink/copy `manifest.json` + `main.js` (+ `styles.css` if added) into `<vault>/.obsidian/plugins/minio-vault-sync/`.

## Architecture

- `src/main.ts` — plugin entry point (`MinioSyncPlugin extends Plugin`). Loads/saves settings via Obsidian's `loadData()`/`saveData()`, registers the settings tab, registers vault event listeners (create/modify/delete/rename) once the layout is ready, runs a full sync on startup/quit/interval, and drives the status bar. `saveSettings()` rebuilds both `this.sync` (`SyncEngine`) and `this.orchestrator` (`SyncOrchestrator`) so they always reflect current settings.
- `src/settings.ts` — `MinioSyncSettings` shape (`endpoint`, `port`, `useSSL`, `accessKey`, `secretKey`, `bucket`, `deviceNickname`, `syncIntervalMinutes`) and `DEFAULT_SETTINGS`, plus `MinioSyncSettingTab`, which implements Obsidian's declarative settings API (`getSettingDefinitions()` / `setControlValue()`, added 1.13.0) rather than the older imperative `display()`.
- `src/setup-modal.ts` — `SetupModal`, a dialog opened via the "Setup MinIO sync" command. Edits a local draft copy of settings (not committed until Save), has a **Test** button (constructs a throwaway `SyncEngine` from the draft and calls `testConnection()`) and a **Save** button (commits the draft to `plugin.settings`, calls `saveSettings()`, closes, and shows a `Notice` toast). This is the primary onboarding UX; the settings tab is for later edits.
- `src/sync.ts` — `SyncEngine`, a thin wrapper around `S3Client` exposing sync-shaped operations (`listRemote`, `statRemote`, `downloadToBuffer`, `upload`, `tombstone`, `removeTombstone`) plus the tombstone/conflict path-naming helpers (`tombstoneKeyFor`, `isTombstoneKey`, `originalPathFromTombstoneKey`, `conflictPathFor`).
- `src/s3-client.ts` — `S3Client`, the low-level S3 REST client. Signs every request with AWS SigV4 (region hardcoded to `us-east-1`; MinIO doesn't care as long as it's consistent) and sends it via Obsidian's `requestUrl`, which — unlike `fetch` — allows setting the `Host` header explicitly, which the signing depends on matching exactly. Always uses path-style addressing (`https://host:port/bucket/key`). All data in/out is `ArrayBuffer`, not Node `Buffer`.
- `src/md5.ts` — pure-JS MD5 (`md5Hex`), used only to compare local file content against an S3 ETag (S3's ETag for a single-part upload is an MD5 hex digest) when deciding push vs. conflict. Web Crypto's `crypto.subtle` doesn't implement MD5, so this couldn't be delegated to it.
- `src/local-scan.ts` — `listLocalTree()`, walks the vault via the raw `DataAdapter` (so `.obsidian` is included) for a full local snapshot, skipping excluded prefixes.
- `src/sync-manifest.ts` — `SyncManifestStore`, a local (never synced) JSON record of per-path `{ localMtime, remoteEtag, size }` as of the last successful sync, stored under the plugin's own data directory.
- `src/sync-decide.ts` — `decideAction()`, a pure function that looks at local/remote/manifest state for one path and returns a `SyncAction` (`push`/`pull`/`conflict`/`tombstone-remote`/`delete-local`/`revive-local`/`reconcile-manifest`/`noop`). Isolated from I/O so the decision logic is easy to reason about independently.
- `src/sync-orchestrator.ts` — `SyncOrchestrator`, applies `decideAction()`'s output. Handles debounced per-file push on vault events (with self-write suppression so the plugin's own remote pulls don't re-trigger a push), tombstone-based deletes, and conflict resolution (renames the local file aside with a device-nickname prefix, uploads it, then pulls the remote version into the original path). All engine calls for one sync run are serialized through a single-promise queue (`enqueue`) to avoid interleaving.

### Build config

- `esbuild.config.mjs` bundles `src/main.ts` → `main.js` as CJS, `platform: 'browser'`, externalizing only `obsidian` and `electron`. Must stay `platform: 'browser'` (not `'node'`) — nothing in `src/` imports Node builtins anymore, and mobile has no Node runtime to poly/fill against.
- `tsconfig.json` targets ES2021/strict, `noUncheckedIndexedAccess` on, `lib: ["ES2021", "DOM"]` (DOM lib needed for `crypto.subtle`, `TextEncoder`, `DOMParser`, all used by `s3-client.ts`).
- `manifest.json` / `versions.json` / `version-bump.mjs` follow the standard Obsidian plugin release pattern (`npm run version` bumps manifest + versions.json from `package.json`'s version). `minAppVersion` is `1.13.0`, driven by the declarative settings API in `settings.ts` and `ButtonComponent.setDisabled` (1.2.3) in `setup-modal.ts` — don't lower it without checking both still have API support.
