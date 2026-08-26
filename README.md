# MinIO Vault Sync

Obsidian plugin that syncs a vault to a MinIO (S3-compatible) bucket so it can be shared across devices. Works on both desktop and mobile.

## Status

Two-way sync is implemented: full sync on startup/quit/interval, debounced push on vault events, tombstone-based delete propagation, and conflict handling (rename-aside + re-download). All S3 access goes through a hand-rolled REST client built on Obsidian's `requestUrl` and the Web Crypto API, so it works in Obsidian's mobile runtime too.

## Setup

Run the **"Setup MinIO sync"** command to open the setup dialog, enter your endpoint/credentials/bucket, and use **Test** to verify the connection before saving. The plugin also adds commands to test the connection and trigger a manual sync.

## Dev

```
npm install
npm run dev    # esbuild watch build -> main.js (inline sourcemaps)
npm run build  # tsc -noEmit type-check, then production esbuild bundle -> main.js (minified, no sourcemap)
```

There is no test suite or linter configured yet.

Symlink or copy `manifest.json` + `main.js` (+ `styles.css` if added) into `<vault>/.obsidian/plugins/minio-vault-sync/` to test in Obsidian.
