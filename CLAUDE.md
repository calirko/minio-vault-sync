# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Obsidian plugin (`minio-vault-sync`) that syncs a vault's files to a MinIO (S3-compatible) bucket so the vault can be shared across devices. Desktop-only (`manifest.json` sets `isDesktopOnly: true`) because the `minio` client depends on Node built-ins (`net`, `tls`, `fs`, ...) that aren't available on mobile — see the Node/Electron API note in the README-adjacent context.

Currently only the scaffold + connection setup flow is implemented. Actual sync logic (upload/download, conflict resolution, trigger conditions like on-save/interval) has not been built yet.

## Commands

```
npm install
npm run dev    # esbuild watch build -> main.js (inline sourcemaps)
npm run build  # tsc -noEmit type-check, then production esbuild bundle -> main.js (minified, no sourcemap)
```

There is no test suite or linter configured yet.

To try the plugin in Obsidian: symlink/copy `manifest.json` + `main.js` (+ `styles.css` if added) into `<vault>/.obsidian/plugins/minio-vault-sync/`.

## Architecture

- `src/main.ts` — plugin entry point (`MinioSyncPlugin extends Plugin`). Loads/saves settings via Obsidian's `loadData()`/`saveData()`, registers the settings tab, and registers commands:
  - `setup` — opens `SetupModal`.
  - `test-connection` — runs `SyncEngine.testConnection()` against the saved settings.
  - `saveSettings()` also rebuilds `this.sync` (a `SyncEngine`) so the client always reflects current settings.
- `src/settings.ts` — `MinioSyncSettings` shape (`endpoint`, `port`, `useSSL`, `accessKey`, `secretKey`, `bucket`) and `DEFAULT_SETTINGS`, plus `MinioSyncSettingTab` (the standard Obsidian settings-tab UI for editing these fields directly).
- `src/setup-modal.ts` — `SetupModal`, a dialog opened via the "Setup MinIO sync" command. Edits a local draft copy of settings (not committed until Save), has a **Test** button (constructs a throwaway `SyncEngine` from the draft and calls `testConnection()`) and a **Save** button (commits the draft to `plugin.settings`, calls `saveSettings()`, closes, and shows a `Notice` toast). This is the primary onboarding UX; the settings tab is for later edits.
- `src/sync.ts` — `SyncEngine`, a thin wrapper around the `minio` `Client`. Currently only `testConnection()` (checks `bucketExists` on the configured bucket). This is where sync logic (upload/download, diffing, trigger conditions) will be added.

### Build config

- `esbuild.config.mjs` bundles `src/main.ts` → `main.js` as CJS, `platform: 'node'`, externalizing `obsidian`, `electron`, and Node builtins. `platform: 'node'` is required specifically because the `minio` package imports `node:fs` etc. — don't remove it.
- `tsconfig.json` targets ES2021/strict, `noUncheckedIndexedAccess` on.
- `manifest.json` / `versions.json` / `version-bump.mjs` follow the standard Obsidian plugin release pattern (`npm run version` bumps manifest + versions.json from `package.json`'s version).
