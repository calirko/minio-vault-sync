function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required environment variable ${name}`);
	return value;
}

function bool(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (value === undefined || value === '') return fallback;
	return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function list(name: string, fallback: string[]): string[] {
	const value = process.env[name];
	if (value === undefined) return fallback;
	return value
		.split(',')
		.map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
		.filter(Boolean);
}

export interface Config {
	port: number;
	authToken: string;
	s3: {
		endpoint: string;
		accessKey: string;
		secretKey: string;
		bucket: string;
	};
	readOnly: boolean;
	/** Vault paths Claude can never see or touch (e.g. `.obsidian`). */
	hiddenPrefixes: string[];
	/** When non-empty, writes are only allowed under these prefixes. */
	writablePrefixes: string[];
	maxReadBytes: number;
	author: string;
}

export function loadConfig(): Config {
	const authToken = required('MCP_AUTH_TOKEN');
	if (authToken.length < 32) throw new Error('MCP_AUTH_TOKEN must be at least 32 characters');

	return {
		port: Number(process.env.PORT ?? 8787),
		authToken,
		s3: {
			// Full URL including scheme and port, e.g. https://minio.example.com:9000
			endpoint: required('S3_ENDPOINT'),
			accessKey: required('S3_ACCESS_KEY'),
			secretKey: required('S3_SECRET_KEY'),
			bucket: required('S3_BUCKET'),
		},
		readOnly: bool('VAULT_READ_ONLY', false),
		hiddenPrefixes: list('VAULT_HIDDEN_PREFIXES', ['.obsidian', '.trash']),
		writablePrefixes: list('VAULT_WRITABLE_PREFIXES', []),
		maxReadBytes: Number(process.env.VAULT_MAX_READ_BYTES ?? 1024 * 1024),
		author: process.env.VAULT_AUTHOR ?? 'claude',
	};
}
