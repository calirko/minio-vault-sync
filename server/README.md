# vault-mcp server

A remote MCP server that lets Claude (claude.ai web, desktop and mobile, added as a
custom connector) read and edit the same MinIO bucket that the `minio-vault-sync`
Obsidian plugin syncs. Changes Claude makes reach every device through the plugin's
normal sync. **The plugin itself needs no changes.**

```
claude.ai ──MCP/HTTPS──> vault-mcp server ──S3──> MinIO bucket <──S3── Obsidian plugin (desktop/mobile)
```

## Running it

```sh
cd server
npm install
cp .env.example .env     # fill in MinIO credentials + MCP_AUTH_TOKEN (openssl rand -hex 32)
npm run dev              # or: npm run build && npm start
```

Or with Docker: `docker build -t vault-mcp . && docker run --env-file .env -p 8787:8787 vault-mcp`.

### Dokploy

`compose.yml` follows the same pattern as the other stacks (external `dragon` network,
`env_file: .env`, healthcheck on `/healthz`):

1. Create a **Compose** service from this repo, with **Compose Path** `./server/compose.yml`.
2. **Environment** tab: paste the variables from `.env.example` (Dokploy writes them to `.env`).
   If MinIO runs on the `dragon` network too, `S3_ENDPOINT` can be the internal address,
   e.g. `http://minio:9000`.
3. **Domains** tab: add your domain → service `vault-mcp`, port `8787`, HTTPS on.
4. Deploy, then add `https://<domain>/mcp/<MCP_AUTH_TOKEN>` as a custom connector in claude.ai.

The server must be reachable over **public HTTPS** from Anthropic's servers. Put it behind
your existing reverse proxy (Caddy/nginx/Traefik), or use a tunnel (Cloudflare Tunnel,
Tailscale Funnel) if it runs on your LAN.

### Connecting Claude

- **claude.ai** (Settings → Connectors → Add custom connector): use the URL
  `https://your-host/mcp/<MCP_AUTH_TOKEN>`. The token sits in the URL path because
  custom connectors can't send custom headers. Treat that URL like a password.
- **Claude Code / other clients:** `https://your-host/mcp` with the header
  `Authorization: Bearer <MCP_AUTH_TOKEN>`, e.g.
  `claude mcp add --transport http vault https://your-host/mcp --header "Authorization: Bearer $TOKEN"`.

`GET /healthz` is unauthenticated and returns `{"ok":true}`.

### Configuration

See `.env.example`. Useful safety settings:

- `VAULT_READ_ONLY=true` exposes only `list_files`, `read_file` and `search`.
- `VAULT_WRITABLE_PREFIXES=Inbox,Claude` limits writes to those folders.
- `VAULT_HIDDEN_PREFIXES` (default `.obsidian,.trash`): paths Claude can't see at all.
  The tombstone namespace is always hidden.

## Current implementation

- `src/index.ts`: plain `node:http` server running MCP Streamable HTTP in stateless mode
  (one server instance per POST, no sessions to keep alive). Handles auth.
- `src/tools.ts`: the MCP tools (table below).
- `src/vault.ts`: bucket access through `@aws-sdk/client-s3` (path-style, `us-east-1`,
  the same as the plugin), plus path validation.
- `src/protocol.ts`: tombstone naming, **copied** from `../src/sync.ts`. It can't be
  imported because that module pulls in the plugin's `obsidian`-dependent S3 client. Keep
  the two copies in sync, or do the `shared/` extraction described below.

## Why it lives in this repo

Obsidian only loads `manifest.json`, `main.js` and `styles.css` from
`.obsidian/plugins/minio-vault-sync/`. The release workflow (`.github/workflows/release.yml`)
uploads only `main.js` and `manifest.json`, so this folder never reaches plugin users.

The point of keeping both in one repo is that they share one sync protocol (tombstones,
conflict naming, changelog format). Keeping that code shared stops the two from drifting.

## Planned layout

```
src/      Obsidian plugin (entry: src/main.ts), unchanged
shared/   protocol code used by both sides: no Obsidian and no Node imports
          - s3-client.ts (SigV4 signing; HTTP transport injected)
          - tombstone / conflict path helpers (moved from src/sync.ts)
          - changelog entry format
server/   MCP server with its own package.json and tsconfig, imports ../shared
```

Rules to keep the two halves separate:

- **Type-checking:** the root `tsconfig.json` only includes `src/**/*.ts` with the
  `ES2021` + `DOM` libs. `server/` gets its own tsconfig with Node types. Node types must
  never leak into `src/` or `shared/`, because the plugin has to run on mobile, which has
  no Node runtime.
- **Transport injection:** `s3-client.ts` currently calls Obsidian's `requestUrl`
  directly. Refactor it to take an HTTP function. The plugin passes a `requestUrl`
  wrapper and the server passes `fetch`. Server-side `fetch` can set the `Host` header,
  which SigV4 needs.
- **Dependencies:** the MCP SDK and the HTTP framework go in `server/package.json` (npm
  workspace or nested package), not in the root. They wouldn't get into `main.js` anyway,
  because esbuild only bundles what `src/main.ts` imports, but this keeps the plugin's
  `npm ci` lean.
- **Releases:** plugin releases stay on plain tags. Give the server its own tag prefix
  (e.g. `server-v*`) so the two are released separately.

## MCP tools

| Tool | Status | Notes |
|---|---|---|
| `list_files` | ✅ | Optional folder filter. Hides tombstones and hidden prefixes. |
| `read_file` | ✅ | Returns content plus ETag (needed for safe writes). Text only, size-capped. |
| `search` | ✅ | Substring/regex over `.md`/`.txt`/`.canvas` and file names. ETag-keyed in-memory cache. |
| `write_file` | ✅ | Create (`If-None-Match: *`) or overwrite (requires ETag, `If-Match`). |
| `edit_file` | ✅ | Exact find and replace, conditional on the ETag Claude read. |
| `append_to_file` | ✅ | Appends (or creates). Retries on concurrent writes. |
| `move_file` | ✅ | Copy + tombstone the old path. Doesn't rewrite links. |
| `delete_file` | ✅ | Tombstone, not a plain DELETE (see below). |
| `recent_changes` | later | Reads the changelog. |
| `undo_last_change` | later | Needs bucket versioning. |

## Compatibility with the plugin's sync protocol

Based on `decideAction()` in `src/sync-decide.ts`:

- **Edit:** a plain PUT. The device sees the remote ETag differ from its manifest while
  the local file is unchanged, so it **pulls**. No plugin changes needed.
- **Create:** the device has no local copy and no manifest entry, so it **pulls**.
- **Delete:** must copy the object to `tombstoneKeyFor(path)`
  (`.minio-vault-sync-tombstones/...`) and then delete the original. A plain S3 DELETE
  is *not* a delete signal: the plugin sees "local exists, remote missing" and pushes the
  file back.
- **Concurrent edits:** `write_file` sends `If-Match: <etag Claude read>`. If someone
  changed the note in the meantime, the write fails and Claude has to re-read. If a
  device edits locally at the same time, the plugin's existing conflict handling still
  applies (it renames the local copy aside with a device-nickname prefix).
- **Freshness:** Claude sees the bucket, not unsynced local edits on a device. The
  plugin's debounced push usually keeps this only seconds behind.

## Marking changes as made by Claude

From cheapest to richest:

1. **Object metadata** (✅ implemented): every PUT sets `x-amz-meta-author: claude` (and maybe
   `x-amz-meta-change-summary`). This matches how the plugin already sets
   `x-amz-meta-mtime`.
2. **Changelog in the bucket:** e.g. `.minio-vault-sync-changelog/<date>.jsonl` with
   `{ path, author, summary, prevEtag, newEtag, ts }` per line. The plugin would skip
   this prefix when syncing (like tombstones), read it after each sync, and show a Notice
   ("Claude edited 3 notes"), a recent-changes panel, or a file-explorer badge.
3. **Undo and diffs:** turn on MinIO bucket versioning. The plugin can then show a diff
   of Claude's edit against the previous version with one-click revert, and the server
   can expose `undo_last_change`.

Frontmatter like `last_edited_by: claude` is possible, but it is noisy and mixes metadata
into note content, so prefer the options above.

## Deployment and security

- Has to be reachable over public HTTPS from Anthropic's servers: e.g. a small
  Node/Bun service next to MinIO, a Cloudflare Worker, or a tunnel if MinIO is LAN-only.
- MinIO credentials stay on the server. Claude never sees them. Protect the MCP
  endpoint itself with OAuth (or a bearer token for personal use).
- Start read-only, then allow writes limited to certain folders. Keep `.obsidian/`
  off-limits to Claude.
- Treat large and binary files as list-only at first.

## Suggested order

1. ~~Read-only server: `list_files`, `read_file`, `search`.~~ Done.
2. ~~Writes: `write_file` / `edit_file` with `If-Match` and author metadata, plus deletes
   through tombstones.~~ Done.
3. Optionally extract `shared/` from `src/s3-client.ts` and `src/sync.ts`, so
   `protocol.ts` stops being a copy. This was skipped for now to leave the plugin untouched.
4. Changelog, and plugin UI to show Claude's changes.
5. Bucket versioning, diffs and undo.
