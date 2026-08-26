# MinIO Vault Sync

Obsidian plugin that syncs a vault to a MinIO (S3-compatible) bucket so it can be shared across devices.

## Status

Ground-work only: plugin scaffold, settings UI (endpoint/credentials/bucket), and a MinIO client wrapper with a connection test command. Actual sync logic and trigger conditions are not implemented yet.

## Dev

```
npm install
npm run dev    # watch build
npm run build  # production build (main.js)
```

Symlink or copy `manifest.json` + `main.js` (+ `styles.css` if added) into `<vault>/.obsidian/plugins/minio-vault-sync/` to test in Obsidian.
