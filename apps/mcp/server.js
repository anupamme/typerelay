// Streamable HTTP and API adapter pattern adapted from Mailtwine (AGPL-3.0).
import express from 'express';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { operations } from '../server/api/catalog.js';
import { ApiSchema } from '../server/api/openapi.js';
import { McpCache } from './cache.js';
import { McpRateLimit } from './rate_limit.js';
import { recordException, shutdownObservability } from '@typerelay/observability';

export class McpApi {
	constructor(base, authorization) { this.base = base; this.authorization = authorization; }
	async request(path, method = 'GET', body, headers = {}) {
		const response = await fetch(this.base + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json', Authorization: this.authorization, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const result = await response.json();
		if (!response.ok) { const error = new Error(result.error || 'API request failed'); error.status = response.status; throw error; }
		return result;
	}
}
export class TypeRelayMcp {
	static catalog = operations.filter(operation => operation.mcp);
	static descriptions = {
		list_libraries: 'List libraries accessible to the connected TypeRelay account with current revisions and read, edit and manage permissions. Use returned IDs to select a library; page using next_cursor.',
		get_library: 'Read metadata for one accessible TypeRelay library by ID, including revision, sharing grants and permissions. Use list_snippets to read its active snippets.',
		create_library: 'Create a new private TypeRelay library with a name and optional snippets or YAML. Does not publish or share the library.',
		update_library: 'Rename a TypeRelay library or change its sharing and edit permissions for specified members or groups. Requires manage permission and the current library revision.',
		list_snippets: 'List active snippets in one accessible TypeRelay library, including saved content and snippet revisions. Page using next_cursor.',
		get_snippet: 'Read the saved content of one accessible TypeRelay snippet using both its library ID and snippet ID.',
		create_snippet: 'Add a new reusable text, code, template or rich-text snippet to an editable TypeRelay library. Supply a unique snippet ID and current library revision.',
		update_snippet: 'Edit a saved TypeRelay snippet in an editable library using current library and snippet revisions. A stale edit may create a conflict; inspect returned conflict IDs before reporting success.',
		batch_snippets: 'Move an explicit selection of snippets between editable TypeRelay libraries or move them to Trash atomically. Supply each snippet ID and revision; Trash retains items for up to 30 days.',
		search_snippets: 'Search active snippets accessible to the connected TypeRelay account by text query. Returns matching content and IDs; page using next_cursor. Does not search other accounts or the public web.',
		get_asset_metadata: 'Read metadata for a rich-text image referenced by accessible TypeRelay content. Returns image format, size and dimensions; does not download image bytes or fetch remote URLs.',
		export_library: 'Export snippets from one accessible TypeRelay library as YAML. Rich text containing images requires the separate REST bundle export and cannot be exported with this tool.',
		preview_import: 'Parse a supplied supported snippet export and preview entries, normalized abbreviations and warnings without saving any libraries or snippets. Use entry keys to select an import.',
		commit_import: 'Import explicitly selected preview entry keys from a supplied snippet export into new private TypeRelay libraries. Existing libraries are not overwritten; inspect import_summary for renamed abbreviations and skipped entries.',
		list_trash: 'List accessible, unexpired TypeRelay Trash items with IDs, current revisions, retention expiry and restore/purge permissions. Page using next_cursor.',
		change_trash: 'Move one explicit TypeRelay library or snippet to Trash, or restore a trashed item, using its type, ID, library and current revision. Trash expires after 30 days; this tool does not permanently purge.',
		purge_item: 'Permanently remove one explicit trashed TypeRelay library or snippet using its current revision. Requires manage permission and trash:purge scope. This cannot be undone.',
		empty_trash: 'Permanently remove only an explicit selection of trashed TypeRelay items with their current revisions. Requires manage permission and trash:purge scope. This cannot be undone and does not implicitly empty all Trash.',
		list_conflicts: 'List unresolved snippet edits in TypeRelay libraries the connected user can edit, including local, base and server values. Page using next_cursor to select a conflict for review.',
		resolve_conflict: 'Resolve one TypeRelay snippet edit conflict by accepting the server value, applying the local value or saving an explicit merged value. Requires the current library revision; inspect any new conflicts.',
		get_operation: 'Look up a previously saved TypeRelay mutation receipt by its operation_id after an uncertain response. Returns found and the currently accessible result; requires the original mutation scope as well as content:read.',
	};
	static project(value, kind) {
		if (value == null || typeof value !== 'object') return value;
		if (!kind) return structuredClone(value);
		if (Array.isArray(value)) return value.map(item => TypeRelayMcp.project(item, kind));
		const fields = {
			library: 'id name revision shared editable members groups state deleted permissions snippets', snippet: 'id library library_name title trigger content position revision state effective_trigger abbreviation_collision personal',
			content: 'version type text markdown language assets variables', permissions: 'read edit manage', personal: 'snippet trigger revision conflicts', personal_conflict: 'id trigger base_revision',
			conflict: 'id library snippet local base server', value: 'title trigger content', trash: 'type id library name library_name revision expires_at can_restore can_purge', target: 'type id library revision',
			preview: 'key folder name title trigger original_trigger content warnings error review', asset: 'id mime_type size width height animated', summary: 'imported skipped renamed', renamed: 'key title original trigger',
			result: 'library libraries conflicts moved trashed purged affected found resolved import_summary',
		};
		const nested = { library: 'library', libraries: 'library', snippets: 'snippet', content: 'content', permissions: 'permissions', personal: 'personal', local: 'value', base: 'value', server: 'snippet', affected: 'target', import_summary: 'summary', renamed: 'renamed' };
		return Object.fromEntries((fields[kind] || '').split(' ').filter(key => Object.hasOwn(value, key)).map(key => [key, TypeRelayMcp.project(value[key], kind === 'personal' && key === 'conflicts' ? 'personal_conflict' : nested[key])]));
	}
	static response(name, result) {
		const kind = { list_libraries: 'library', list_snippets: 'snippet', search_snippets: 'snippet', list_trash: 'trash', list_conflicts: 'conflict' }[name];
		if (kind) return { items: (result.items || []).map(item => { const projected = TypeRelayMcp.project(item, kind); if (name === 'list_libraries') delete projected.snippets; return projected; }), next_cursor: result.next_cursor ?? null };
		if (name === 'export_library') return { yaml: result.yaml };
		if (name === 'preview_import') return { entries: TypeRelayMcp.project(result.entries || [], 'preview'), warnings: result.warnings || [] };
		return TypeRelayMcp.project(result, { get_library: 'library', get_snippet: 'snippet', get_asset_metadata: 'asset' }[name] || 'result');
	}
	static tool(operation) {
		const schema = operation.method === 'get' ? { type: 'object', properties: {}, required: [], additionalProperties: false } : structuredClone(ApiSchema.body(operation));
		// Path arguments are nested so a new snippet's ID cannot shadow its library ID.
		const path = [...operation.path.matchAll(/:([a-z_]+)/g)].map(match => match[1]);
		if (path.length) { schema.properties.path = { type: 'object', properties: Object.fromEntries(path.map(name => [name, { type: 'string' }])), required: path, additionalProperties: false }; schema.required.push('path'); }
		if (operation.id.startsWith('list_') || operation.id === 'search_snippets') Object.assign(schema.properties, { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } });
		if (operation.id === 'search_snippets') { schema.properties.q = { type: 'string', minLength: 1 }; schema.required.push('q'); }
		return { name: operation.id, description: TypeRelayMcp.descriptions[operation.id] + ' Requires ' + operation.scope + '. ' + (operation.mutation ? 'Persist operation_id for identical retries; supply current revisions. Check returned conflicts before treating edits as accepted.' : ''), inputSchema: schema, annotations: { readOnlyHint: !operation.mutation, destructiveHint: operation.mutation && !['create_library', 'create_snippet', 'commit_import'].includes(operation.id), idempotentHint: true, openWorldHint: false }, securitySchemes: [{ type: 'oauth2', scopes: [operation.scope] }], _meta: { securitySchemes: [{ type: 'oauth2', scopes: [operation.scope] }] } };
	}
	static async call(api, name, args) {
		const operation = TypeRelayMcp.catalog.find(operation => operation.id === name);
		if (!operation) throw new Error('Unknown tool');
		const body = { ...args }; delete body.path;
		const path = operation.path.replace(/:([a-z_]+)/g, (match, key) => { if (typeof args.path?.[key] !== 'string' || !args.path[key]) throw new Error('Missing path.' + key); return encodeURIComponent(args.path[key]); });
		const query = operation.method === 'get' ? new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])) : null;
		return TypeRelayMcp.response(name, await api.request('/api/v3' + path + (query?.size ? '?' + query : ''), operation.method.toUpperCase(), operation.method === 'get' ? undefined : body));
	}
	static app({ apiBase = process.env.API_BASE_URL || 'http://localhost:3040', resource = (process.env.MCP_BASE_URL || 'http://localhost:3041').replace(/\/$/, '') + '/mcp', issuer = process.env.APP_URL || 'http://localhost:3040', secret = () => process.env.JWT_SECRET || 'change-me', applyRateLimits = true } = {}) {
		const app = express();
		if (process.env.IS_DOCKER === 'true') app.set('trust proxy', 1);
		app.disable('x-powered-by');
		const origin = new URL(resource).origin;
		const metadata = origin + '/.well-known/oauth-protected-resource' + new URL(resource).pathname;
		app.use((req, res, next) => {
			if (req.headers.origin && ![origin, issuer, ...(process.env.MCP_ALLOWED_ORIGINS || '').split(',')].includes(req.headers.origin)) return res.status(403).json({ error: 'Invalid Origin' });
			res.set('Cache-Control', 'no-store'); next();
		});
		app.get('/health', (req, res) => res.json({ ok: true, transport: 'streamable-http' }));
		app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => res.json({ resource, authorization_servers: [issuer], scopes_supported: [...new Set(TypeRelayMcp.catalog.map(operation => operation.scope))], bearer_methods_supported: ['header'] }));
		if (applyRateLimits) { app.use(McpRateLimit.createIpFloodLimiter()); app.use(McpRateLimit.createUnauthLimiter()); }
		const authenticatedRequestLimiter = applyRateLimits ? McpRateLimit.createAuthenticatedRequestLimiter() : null;
		app.use(express.json({ limit: '12mb' }));
		app.post('/mcp', async (req, res) => {
			let server; let transport;
			try {
				if (!/^(Bearer|Token) [^ ]+$/.test(req.headers.authorization || '')) { const error = new Error('Authentication required'); error.status = 401; throw error; }
				const upstream = new McpApi(apiBase, req.headers.authorization);
				const delegated = await upstream.request('/integrations/delegate', 'POST', {}, { 'X-MCP-Secret': secret() });
				if (applyRateLimits && !await McpRateLimit.consumeAuthenticatedRequest(authenticatedRequestLimiter, req, res)) return;
				const rateLimitKey = applyRateLimits ? McpRateLimit.getCredentialOrIpKey(req) : null;
				const api = new McpApi(apiBase, 'Bearer ' + delegated.access_token);
				const identity = await api.request('/api/v3/me');
				server = new Server({ name: 'typerelay', version: '0.1.0' }, { capabilities: { tools: {} } });
				server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TypeRelayMcp.catalog.filter(operation => identity.scopes.includes(operation.scope)).map(TypeRelayMcp.tool) }));
				server.setRequestHandler(CallToolRequestSchema, async request => {
					try {
						const operation = TypeRelayMcp.catalog.find(operation => operation.id === request.params.name);
						if (!operation || !identity.scopes.includes(operation.scope)) throw new Error('Unknown tool or insufficient scope');
						const args = request.params.arguments || {};
						const run = () => TypeRelayMcp.call(api, request.params.name, args);
						const result = applyRateLimits ? await McpRateLimit.runToolWithLimits({ toolName: request.params.name, args, rateLimitKey, run }) : await run();
						if (result?.isError) return result;
						return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
					} catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }], ...(error.status === 401 ? { _meta: { 'mcp/www_authenticate': ['Bearer resource_metadata="' + metadata + '", error="invalid_token", error_description="Sign in to TypeRelay again"'] } } : {}) }; }
				});
				transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
				res.on('close', () => { transport?.close(); server?.close(); });
				await server.connect(transport);
				// JSON-only clients need not advertise SSE, matching Mailtwine.
				req.headers.accept = 'application/json, text/event-stream';
				await transport.handleRequest(req, res, req.body);
			} catch (error) {
				if (res.headersSent) return;
				if (!error.status || error.status >= 500) recordException(error);
				if (error.status === 401) res.set('WWW-Authenticate', 'Bearer resource_metadata="' + metadata + '"');
				res.status(error.status || 500).json({ error: error.status ? error.message : 'MCP request failed' });
			}
		});
		app.all('/mcp', (req, res) => res.set('Allow', 'POST').status(405).json({ error: 'Use POST with Streamable HTTP' }));
		app.use((error, req, res, next) => { if (!error.status || error.status >= 500) recordException(error); res.status(error.status || 500).json({ error: error.status === 413 ? 'Request too large' : 'Invalid request' }); });
		return app;
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		if (McpRateLimit.getConfig().enabled) await McpCache.connect();
		const port = Number(process.env.PORT || 3041);
		TypeRelayMcp.app().listen(port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'service_started', service: process.env.OTEL_SERVICE_NAME || 'typerelay-mcp', mode: 'mcp', port, version: process.env.APP_VERSION || 'development' })));
	} catch (error) {
		recordException(error);
		console.error(JSON.stringify({ event: 'service_start_failed', service: process.env.OTEL_SERVICE_NAME || 'typerelay-mcp', error: error.message || String(error) }));
		await shutdownObservability();
		process.exit(1);
	}
}
