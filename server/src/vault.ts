import {
	CopyObjectCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
	S3ServiceException,
} from '@aws-sdk/client-s3';
import type { Config } from './config.js';
import { isTombstoneKey, tombstoneKeyFor } from './protocol.js';

/** An error whose message is safe and useful to show to Claude as a tool result. */
export class VaultError extends Error {}

export interface FileInfo {
	path: string;
	size: number;
	lastModified: string | undefined;
	etag: string;
}

export interface SearchMatch {
	path: string;
	line: number;
	text: string;
}

const SEARCHABLE_EXTENSIONS = ['.md', '.txt', '.canvas'];

function stripQuotes(etag: string | undefined): string {
	return (etag ?? '').replace(/^"|"$/g, '');
}

function quote(etag: string): string {
	return `"${stripQuotes(etag)}"`;
}

function httpStatus(err: unknown): number | undefined {
	return err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined;
}

function contentTypeFor(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith('.md')) return 'text/markdown; charset=utf-8';
	if (lower.endsWith('.json') || lower.endsWith('.canvas')) return 'application/json; charset=utf-8';
	return 'text/plain; charset=utf-8';
}

function isUnder(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Vault-shaped view over the bucket, speaking the same protocol as the Obsidian plugin:
 * deletes go through tombstones, writes clear any tombstone for the path, and every write
 * is conditional on the ETag Claude last read so it never clobbers an edit it hasn't seen.
 */
export class Vault {
	private s3: S3Client;
	private bucket: string;
	/** Text cache keyed by path, invalidated by ETag, so repeated searches don't re-download everything. */
	private textCache = new Map<string, { etag: string; text: string }>();

	constructor(private cfg: Config) {
		this.bucket = cfg.s3.bucket;
		this.s3 = new S3Client({
			endpoint: cfg.s3.endpoint,
			region: 'us-east-1',
			forcePathStyle: true,
			credentials: { accessKeyId: cfg.s3.accessKey, secretAccessKey: cfg.s3.secretKey },
		});
	}

	get readOnly(): boolean {
		return this.cfg.readOnly;
	}

	// ---- path rules -------------------------------------------------------------------

	private isHidden(path: string): boolean {
		return isTombstoneKey(path) || this.cfg.hiddenPrefixes.some((p) => isUnder(path, p));
	}

	/** Normalizes a vault path from Claude and rejects anything outside the visible vault. */
	normalizePath(raw: string): string {
		const path = raw.trim().replace(/^\/+/, '');
		if (!path) throw new VaultError('Path is empty.');
		if (path.includes('\\') || /[\u0000-\u001f]/.test(path)) throw new VaultError(`Invalid path: ${raw}`);
		const segments = path.split('/');
		if (segments.some((s) => s === '' || s === '.' || s === '..')) {
			throw new VaultError(`Invalid path (empty, "." or ".." segment): ${raw}`);
		}
		if (this.isHidden(path)) throw new VaultError(`Path is not accessible: ${raw}`);
		return path;
	}

	normalizePrefix(raw: string | undefined): string {
		if (!raw) return '';
		const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
		return trimmed ? `${this.normalizePath(trimmed)}/` : '';
	}

	private assertWritable(path: string): void {
		if (this.cfg.readOnly) throw new VaultError('The vault is read-only on this server.');
		const { writablePrefixes } = this.cfg;
		if (writablePrefixes.length && !writablePrefixes.some((p) => isUnder(path, p))) {
			throw new VaultError(`Writes are only allowed under: ${writablePrefixes.join(', ')}`);
		}
	}

	// ---- reads ------------------------------------------------------------------------

	async list(prefix = ''): Promise<FileInfo[]> {
		const files: FileInfo[] = [];
		let token: string | undefined;
		do {
			const res = await this.s3.send(
				new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix || undefined, ContinuationToken: token }),
			);
			for (const obj of res.Contents ?? []) {
				if (!obj.Key || this.isHidden(obj.Key)) continue;
				files.push({
					path: obj.Key,
					size: obj.Size ?? 0,
					lastModified: obj.LastModified?.toISOString(),
					etag: stripQuotes(obj.ETag),
				});
			}
			token = res.IsTruncated ? res.NextContinuationToken : undefined;
		} while (token);
		return files;
	}

	async stat(path: string): Promise<FileInfo | null> {
		try {
			const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: path }));
			return {
				path,
				size: res.ContentLength ?? 0,
				lastModified: res.LastModified?.toISOString(),
				etag: stripQuotes(res.ETag),
			};
		} catch (err) {
			if (httpStatus(err) === 404) return null;
			throw err;
		}
	}

	/** `known` (e.g. from a listing) skips the HEAD request; the GET still returns the authoritative etag. */
	async readText(path: string, known?: FileInfo): Promise<{ content: string; info: FileInfo }> {
		const info = known ?? (await this.stat(path));
		if (!info) throw new VaultError(`File not found: ${path}`);
		if (info.size > this.cfg.maxReadBytes) {
			throw new VaultError(`File is too large to read (${info.size} bytes, limit ${this.cfg.maxReadBytes}).`);
		}
		const cached = this.textCache.get(path);
		if (cached && cached.etag === info.etag) return { content: cached.text, info };

		const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: path }));
		const bytes = await res.Body!.transformToByteArray();
		let text: string;
		try {
			text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		} catch {
			throw new VaultError(`File is binary, not text: ${path}`);
		}
		if (text.includes('\u0000')) throw new VaultError(`File is binary, not text: ${path}`);
		const etag = stripQuotes(res.ETag) || info.etag;
		this.textCache.set(path, { etag, text });
		return { content: text, info: { ...info, etag } };
	}

	/**
	 * Reads every text note under `prefix` (sorted by path) in one go, stopping once the
	 * combined content would exceed `maxBytes`. Binary/oversized files are reported as skipped.
	 */
	async readFolder(
		prefix: string,
		opts: { recursive?: boolean; maxBytes: number },
	): Promise<{ files: { content: string; info: FileInfo }[]; skipped: string[]; omitted: FileInfo[] }> {
		const all = (await this.list(prefix))
			.filter((f) => opts.recursive !== false || !f.path.slice(prefix.length).includes('/'))
			.sort((a, b) => a.path.localeCompare(b.path));
		const skipped: string[] = [];
		const candidates = all.filter((f) => {
			const ok = f.size <= this.cfg.maxReadBytes && SEARCHABLE_EXTENSIONS.some((ext) => f.path.toLowerCase().endsWith(ext));
			if (!ok) skipped.push(f.path);
			return ok;
		});

		// Decide what fits from listing sizes, so nothing is fetched just to be thrown away.
		const chosen: FileInfo[] = [];
		let budget = opts.maxBytes;
		let i = 0;
		for (; i < candidates.length; i++) {
			const f = candidates[i]!;
			if (f.size > budget && chosen.length) break;
			chosen.push(f);
			budget -= f.size;
		}
		const omitted = candidates.slice(i);

		const results: ({ content: string; info: FileInfo } | null)[] = new Array(chosen.length).fill(null);
		let next = 0;
		const worker = async () => {
			for (let n = next++; n < chosen.length; n = next++) {
				const f = chosen[n]!;
				try {
					results[n] = await this.readText(f.path, f);
				} catch {
					skipped.push(f.path);
				}
			}
		};
		await Promise.all(Array.from({ length: 8 }, worker));
		return { files: results.filter((r): r is { content: string; info: FileInfo } => r !== null), skipped, omitted };
	}

	async search(
		query: string,
		opts: { prefix?: string; regex?: boolean; caseSensitive?: boolean; maxResults?: number },
	): Promise<{ matches: SearchMatch[]; filesScanned: number; truncated: boolean }> {
		const maxResults = opts.maxResults ?? 50;
		let pattern: RegExp;
		try {
			const source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			pattern = new RegExp(source, opts.caseSensitive ? '' : 'i');
		} catch (err) {
			throw new VaultError(`Invalid regex: ${(err as Error).message}`);
		}

		const files = (await this.list(opts.prefix)).filter(
			(f) => f.size <= this.cfg.maxReadBytes && SEARCHABLE_EXTENSIONS.some((ext) => f.path.toLowerCase().endsWith(ext)),
		);

		const matches: SearchMatch[] = [];
		let truncated = false;
		const nameMatches = files.filter((f) => pattern.test(f.path));
		for (const f of nameMatches) matches.push({ path: f.path, line: 0, text: '(file name matches)' });

		// Fetch with bounded concurrency; the ETag-keyed cache makes repeat searches cheap.
		const queue = [...files];
		const worker = async () => {
			for (let f = queue.shift(); f; f = queue.shift()) {
				if (matches.length >= maxResults) {
					truncated = true;
					return;
				}
				let content: string;
				try {
					({ content } = await this.readText(f.path));
				} catch {
					continue;
				}
				const lines = content.split('\n');
				for (let i = 0; i < lines.length; i++) {
					if (!pattern.test(lines[i]!)) continue;
					if (matches.length >= maxResults) {
						truncated = true;
						return;
					}
					const line = lines[i]!.trim();
					matches.push({ path: f.path, line: i + 1, text: line.length > 300 ? `${line.slice(0, 300)}…` : line });
				}
			}
		};
		await Promise.all(Array.from({ length: 8 }, worker));
		matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
		return { matches, filesScanned: files.length, truncated };
	}

	// ---- writes -----------------------------------------------------------------------

	/**
	 * Writes a text file. `expectedEtag` must be the ETag Claude read (to update an existing
	 * file) or null (to create a new one). Either way the write fails if the file changed.
	 */
	async writeText(path: string, content: string, expectedEtag: string | null): Promise<string> {
		this.assertWritable(path);

		// Pre-check gives a clear error message; the conditional PUT below closes the race
		// window on MinIO/S3 versions that honour If-Match / If-None-Match on PUT.
		const current = await this.stat(path);
		if (expectedEtag === null && current) {
			throw new VaultError(`File already exists: ${path}. Read it first and pass its etag to overwrite it.`);
		}
		if (expectedEtag !== null && !current) {
			throw new VaultError(`File no longer exists: ${path}. It may have been deleted or moved.`);
		}
		if (expectedEtag !== null && current && current.etag !== stripQuotes(expectedEtag)) {
			throw new VaultError(`File changed since you read it: ${path}. Read it again and reapply your edit.`);
		}

		let etag: string;
		try {
			const res = await this.s3.send(
				new PutObjectCommand({
					Bucket: this.bucket,
					Key: path,
					Body: new TextEncoder().encode(content),
					ContentType: contentTypeFor(path),
					// Same metadata key the plugin sets on upload, plus who made the change.
					Metadata: { mtime: String(Date.now()), author: this.cfg.author },
					...(expectedEtag === null ? { IfNoneMatch: '*' } : { IfMatch: quote(expectedEtag) }),
				}),
			);
			etag = stripQuotes(res.ETag);
		} catch (err) {
			if (httpStatus(err) === 412 || httpStatus(err) === 409) {
				throw new VaultError(`File changed while writing: ${path}. Read it again and retry.`);
			}
			throw err;
		}

		this.textCache.set(path, { etag, text: content });
		// If the path was deleted earlier, a leftover tombstone would make devices delete the
		// new file. The plugin clears it the same way when a local edit revives a file.
		await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: tombstoneKeyFor(path) }));
		return etag;
	}

	/** Deletes via the plugin's tombstone protocol so devices propagate the delete. */
	async delete(path: string): Promise<void> {
		this.assertWritable(path);
		if (!(await this.stat(path))) throw new VaultError(`File not found: ${path}`);
		await this.s3.send(
			new CopyObjectCommand({
				Bucket: this.bucket,
				Key: tombstoneKeyFor(path),
				CopySource: `${this.bucket}/${encodeURIComponent(path).replace(/%2F/g, '/')}`,
			}),
		);
		await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: path }));
		this.textCache.delete(path);
	}

	/** Copies to the new path, then tombstones the old one. Works for binary files too. */
	async move(from: string, to: string): Promise<void> {
		this.assertWritable(from);
		this.assertWritable(to);
		if (from === to) throw new VaultError('Source and destination are the same.');
		if (!(await this.stat(from))) throw new VaultError(`File not found: ${from}`);
		if (await this.stat(to)) throw new VaultError(`Destination already exists: ${to}`);
		await this.s3.send(
			new CopyObjectCommand({
				Bucket: this.bucket,
				Key: to,
				// Default MetadataDirective (COPY) keeps the source's content type, which matters
				// for binary attachments.
				CopySource: `${this.bucket}/${encodeURIComponent(from).replace(/%2F/g, '/')}`,
			}),
		);
		await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: tombstoneKeyFor(to) }));
		await this.delete(from);
	}
}
