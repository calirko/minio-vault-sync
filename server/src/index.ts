import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './tools.js';
import { Vault } from './vault.js';

const cfg = loadConfig();
const vault = new Vault(cfg);
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Two ways to authenticate, both with the same secret:
 *  - `POST /mcp/<token>`: for claude.ai custom connectors, which can't send custom headers.
 *  - `POST /mcp` with `Authorization: Bearer <token>`: for Claude Code / other clients.
 */
function authorize(req: IncomingMessage, pathname: string): boolean {
	if (pathname.startsWith('/mcp/')) return safeEqual(decodeURIComponent(pathname.slice(5)), cfg.authToken);
	if (pathname === '/mcp') {
		const header = req.headers.authorization ?? '';
		return header.startsWith('Bearer ') && safeEqual(header.slice(7), cfg.authToken);
	}
	return false;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
		chunks.push(chunk as Buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const httpServer = createServer(async (req, res) => {
	const { pathname } = new URL(req.url ?? '/', 'http://localhost');

	// One access-log line per request, with the URL token redacted, so connection problems
	// (e.g. a proxy blocking the client, or an unexpected probe path) show up in the logs.
	const started = Date.now();
	res.on('finish', () => {
		if (pathname === '/healthz') return;
		const shownPath = pathname.startsWith('/mcp/') ? '/mcp/<token>' : pathname;
		const ua = req.headers['user-agent'] ?? '-';
		const auth = req.headers.authorization ? 'auth-header' : 'no-auth-header';
		console.log(`${req.method} ${shownPath} ${res.statusCode} ${Date.now() - started}ms ${auth} ua="${ua}"`);
	});

	if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
	if (!pathname.startsWith('/mcp')) return sendJson(res, 404, { error: 'Not found' });
	if (!authorize(req, pathname)) return sendJson(res, 401, { error: 'Unauthorized' });

	// Stateless mode: each POST gets its own server + transport, so there are no sessions
	// to keep alive and the process can restart at any time. GET (server-initiated stream)
	// and DELETE (session end) are not needed in this mode.
	if (req.method !== 'POST') {
		res.setHeader('allow', 'POST');
		return sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
	}

	let body: unknown;
	try {
		body = await readJsonBody(req);
	} catch {
		return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
	}

	const server = createMcpServer(vault);
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	res.on('close', () => {
		void transport.close();
		void server.close();
	});
	try {
		await server.connect(transport);
		await transport.handleRequest(req, res, body);
	} catch (err) {
		console.error('MCP request failed', err);
		if (!res.headersSent) {
			sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
		}
	}
});

httpServer.listen(cfg.port, () => {
	console.log(
		`vault-mcp listening on :${cfg.port} (bucket=${cfg.s3.bucket}, ${cfg.readOnly ? 'read-only' : 'read-write'})`,
	);
});
