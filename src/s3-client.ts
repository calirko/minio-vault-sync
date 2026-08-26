import { requestUrl, type RequestUrlResponse } from 'obsidian';

// Minimal hand-rolled S3 REST client, signed with AWS SigV4. This replaces the `minio`
// npm client, which depends on Node's `net`/`tls`/`fs` and therefore can't run in
// Obsidian's mobile runtime. `requestUrl` is Obsidian's own HTTP primitive: it works on
// both desktop and mobile and (unlike `fetch`) lets us set the `Host` header explicitly,
// which SigV4 signing depends on.
//
// Requests always use path-style addressing (https://host:port/bucket/key) since
// self-hosted MinIO instances rarely have the wildcard DNS/TLS needed for
// virtual-hosted-style buckets.

const REGION = 'us-east-1'; // MinIO ignores the region value as long as client/server agree.
const EMPTY_PAYLOAD_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface S3Config {
	endpoint: string;
	port: number;
	useSSL: boolean;
	accessKey: string;
	secretKey: string;
	bucket: string;
}

interface S3RequestOptions {
	method: string;
	/** Object key. Omit to target the bucket root. */
	key?: string;
	query?: Record<string, string>;
	/** Extra headers to sign and send, e.g. x-amz-meta-*, x-amz-copy-source. */
	extraHeaders?: Record<string, string>;
	body?: ArrayBuffer;
}

function uriEncode(input: string): string {
	const bytes = new TextEncoder().encode(input);
	let out = '';
	for (const b of bytes) {
		const ch = String.fromCharCode(b);
		if (/[A-Za-z0-9\-_.~]/.test(ch)) {
			out += ch;
		} else {
			out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
		}
	}
	return out;
}

function toHex(buf: ArrayBuffer): string {
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function sha256Hex(data: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
	return toHex(digest);
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
	const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function deriveSigningKey(secretKey: string, dateStamp: string): Promise<ArrayBuffer> {
	const kDate = await hmac(new TextEncoder().encode('AWS4' + secretKey), dateStamp);
	const kRegion = await hmac(kDate, REGION);
	const kService = await hmac(kRegion, 's3');
	return hmac(kService, 'aws4_request');
}

async function s3Request(cfg: S3Config, opts: S3RequestOptions): Promise<RequestUrlResponse> {
	const scheme = cfg.useSSL ? 'https' : 'http';
	// Host header must match what the network layer will actually send, which — like any
	// HTTP client — omits the port when it's the scheme's default. Electron's `net` module
	// (which `requestUrl` uses on desktop) rejects requests that set `Host` explicitly with
	// a hard net::ERR_INVALID_ARGUMENT, so we let it derive Host from the URL and only sign
	// against the value it will produce.
	const isDefaultPort = (scheme === 'https' && cfg.port === 443) || (scheme === 'http' && cfg.port === 80);
	const host = isDefaultPort ? cfg.endpoint : `${cfg.endpoint}:${cfg.port}`;

	const pathSegments = [cfg.bucket, ...(opts.key !== undefined ? opts.key.split('/') : [])];
	const canonicalPath = '/' + pathSegments.map(uriEncode).join('/');

	const query = opts.query ?? {};
	const canonicalQuery = Object.keys(query)
		.sort()
		.map((k) => `${uriEncode(k)}=${uriEncode(query[k]!)}`)
		.join('&');

	const now = new Date();
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
	const dateStamp = amzDate.slice(0, 8);
	const payloadHash = opts.body ? 'UNSIGNED-PAYLOAD' : EMPTY_PAYLOAD_HASH;

	const headersToSign: Record<string, string> = {
		host,
		'x-amz-content-sha256': payloadHash,
		'x-amz-date': amzDate,
	};
	for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) headersToSign[k.toLowerCase()] = v;

	const signedHeaderNames = Object.keys(headersToSign).sort();
	const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headersToSign[h]!.trim()}\n`).join('');
	const signedHeaders = signedHeaderNames.join(';');

	const canonicalRequest = [opts.method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');

	const credentialScope = `${dateStamp}/${REGION}/s3/aws4_request`;
	const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');

	const signingKey = await deriveSigningKey(cfg.secretKey, dateStamp);
	const signature = toHex(await hmac(signingKey, stringToSign));

	const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	const url = `${scheme}://${host}${canonicalPath}${canonicalQuery ? '?' + canonicalQuery : ''}`;

	// `host` stays in headersToSign (S3 requires it in SignedHeaders) but is not sent
	// explicitly — see the ERR_INVALID_ARGUMENT note above. The network layer sets it from `url`.
	const { host: _host, ...sendHeaders } = headersToSign;
	return requestUrl({
		url,
		method: opts.method,
		headers: { ...sendHeaders, Authorization: authorization },
		body: opts.body,
		throw: false,
	});
}

export interface S3ObjectSummary {
	key: string;
	etag: string;
	lastModified: number;
	size: number;
}

export class S3Client {
	constructor(private cfg: S3Config) {}

	async bucketExists(): Promise<boolean> {
		const res = await s3Request(this.cfg, { method: 'HEAD' });
		if (res.status === 200) return true;
		if (res.status === 404) return false;
		throw new Error(`Unexpected response checking bucket (status ${res.status})`);
	}

	async listAllObjects(): Promise<S3ObjectSummary[]> {
		const results: S3ObjectSummary[] = [];
		let continuationToken: string | undefined;

		do {
			const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1000' };
			if (continuationToken) query['continuation-token'] = continuationToken;

			const res = await s3Request(this.cfg, { method: 'GET', query });
			if (res.status !== 200) throw new Error(`Failed to list bucket (status ${res.status})`);

			const xml = new DOMParser().parseFromString(res.text, 'application/xml');
			const contents = xml.getElementsByTagName('Contents');
			for (let i = 0; i < contents.length; i++) {
				const node = contents[i]!;
				const key = node.getElementsByTagName('Key')[0]?.textContent;
				if (!key) continue;
				const etag = (node.getElementsByTagName('ETag')[0]?.textContent ?? '').replace(/"/g, '');
				const lastModifiedStr = node.getElementsByTagName('LastModified')[0]?.textContent;
				const size = Number(node.getElementsByTagName('Size')[0]?.textContent ?? '0');
				results.push({
					key,
					etag,
					lastModified: lastModifiedStr ? new Date(lastModifiedStr).getTime() : 0,
					size,
				});
			}

			const isTruncated = xml.getElementsByTagName('IsTruncated')[0]?.textContent === 'true';
			continuationToken = isTruncated ? (xml.getElementsByTagName('NextContinuationToken')[0]?.textContent ?? undefined) : undefined;
		} while (continuationToken);

		return results;
	}

	async statObject(key: string): Promise<{ etag: string } | null> {
		const res = await s3Request(this.cfg, { method: 'HEAD', key });
		if (res.status !== 200) return null;
		return { etag: (res.headers['etag'] ?? '').replace(/"/g, '') };
	}

	async getObject(key: string): Promise<ArrayBuffer> {
		const res = await s3Request(this.cfg, { method: 'GET', key });
		if (res.status !== 200) throw new Error(`Failed to download ${key} (status ${res.status})`);
		return res.arrayBuffer;
	}

	async putObject(key: string, data: ArrayBuffer, extraHeaders?: Record<string, string>): Promise<{ etag: string }> {
		const res = await s3Request(this.cfg, { method: 'PUT', key, body: data, extraHeaders });
		if (res.status !== 200) throw new Error(`Failed to upload ${key} (status ${res.status})`);
		return { etag: (res.headers['etag'] ?? '').replace(/"/g, '') };
	}

	async deleteObject(key: string): Promise<void> {
		const res = await s3Request(this.cfg, { method: 'DELETE', key });
		if (res.status !== 204 && res.status !== 200) throw new Error(`Failed to delete ${key} (status ${res.status})`);
	}

	/** Returns false if the source object doesn't exist, true on success, throws otherwise. */
	async copyObject(sourceKey: string, destKey: string): Promise<boolean> {
		const copySource = '/' + [this.cfg.bucket, ...sourceKey.split('/')].map(uriEncode).join('/');
		const res = await s3Request(this.cfg, {
			method: 'PUT',
			key: destKey,
			extraHeaders: { 'x-amz-copy-source': copySource },
		});
		if (res.status === 404) return false;
		if (res.status !== 200) throw new Error(`Failed to copy ${sourceKey} to ${destKey} (status ${res.status})`);
		return true;
	}
}
