import { before, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TypeRelayMcp } from '../server.js';
import { ApiSchema } from '../../server/api/openapi.js';
import { McpRateLimit } from '../rate_limit.js';

class AppFixture { static upstream; static server; static url; static calls = []; static resource = 'https://mcp.synthetic.test/mcp'; }
before(async () => {
	const upstream = express(); upstream.use(express.json());
	upstream.post('/integrations/delegate', (req, res) => { const app = req.body.resource === AppFixture.resource + '/app'; if (req.body.resource !== AppFixture.resource && !app || req.headers.authorization !== 'Bearer ' + (app ? 'app-token' : 'legacy-token')) return res.status(401).json({ error: 'Invalid resource token' }); res.json({ access_token: 'delegated-token' }); });
	upstream.get('/api/v3/me', (req, res) => res.json({ scopes: ['content:read', 'content:write', 'trash:purge'] }));
	upstream.use('/api/v3', (req, res) => { AppFixture.calls.push({ path: req.path, body: req.body }); res.json({ moved: ['synthetic-snippet'], account: 'private-account' }); });
	AppFixture.upstream = upstream.listen(0, '127.0.0.1'); await new Promise(resolve => AppFixture.upstream.once('listening', resolve));
	AppFixture.server = TypeRelayMcp.app({ apiBase: 'http://127.0.0.1:' + AppFixture.upstream.address().port, resource: AppFixture.resource, applyRateLimits: false }).listen(0, '127.0.0.1'); await new Promise(resolve => AppFixture.server.once('listening', resolve));
	AppFixture.url = 'http://127.0.0.1:' + AppFixture.server.address().port;
});
after(async () => { await new Promise(resolve => AppFixture.server.close(resolve)); await new Promise(resolve => AppFixture.upstream.close(resolve)); });
test('app SDK discovery exposes fixed actions and calls original API contracts', async () => {
	const client = new Client({ name: 'synthetic-app-client', version: '1.0' }); await client.connect(new StreamableHTTPClientTransport(new URL(AppFixture.url + '/mcp/app'), { requestInit: { headers: { Authorization: 'Bearer app-token' } } }));
	const tools = (await client.listTools()).tools;
	const hiddenCount = AppFixture.calls.length;
	for (const name of ['batch_snippets', 'change_trash', 'empty_trash']) { assert.ok(!tools.some(tool => tool.name === name)); assert.equal((await client.callTool({ name, arguments: {} })).isError, true); }
	assert.equal(AppFixture.calls.length, hiddenCount);
	const batch = { operation_id: 'synthetic-operation-123', source_library: 'source', items: [{ id: 'synthetic-snippet', base_revision: 2 }] };
	const target = { type: 'snippet', id: 'synthetic-snippet', library: 'source', revision: 3 };
	for (const [name, args, action, path] of [['move_snippets', { ...batch, destination_library: 'destination' }, 'move', '/snippets/batch'], ['trash_snippets', batch, 'trash', '/snippets/batch'], ['trash_item', { operation_id: batch.operation_id, target }, 'trash', '/trash/action'], ['restore_item', { operation_id: batch.operation_id, target }, 'restore', '/trash/action'], ['permanently_delete_trash_items', { operation_id: batch.operation_id, targets: [target] }, undefined, '/trash/empty']]) {
		const tool = tools.find(tool => tool.name === name); assert.ok(tool); assert.equal(tool.inputSchema.properties.action, undefined); assert.ok(tool.inputSchema.required.includes('operation_id')); assert.equal(tool.annotations.readOnlyHint, false); assert.equal(tool.annotations.destructiveHint, name !== 'restore_item'); assert.equal(tool.annotations.openWorldHint, false);
		const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); assert.equal(result.structuredContent.account, undefined); assert.deepEqual(AppFixture.calls.at(-1), { path, body: { ...args, ...(action ? { action } : {}) } });
		const count = AppFixture.calls.length;
		assert.equal((await client.callTool({ name, arguments: { ...args, action: action === 'trash' ? 'restore' : 'trash' } })).isError, true); assert.equal(AppFixture.calls.length, count);
	}
	for (const args of [{ ...batch, action: 'move' }, { ...batch, destination_library: 'unwanted' }, { ...batch, items: [{ id: 'synthetic-snippet', base_revision: 0 }] }]) assert.equal((await client.callTool({ name: 'trash_snippets', arguments: args })).isError, true);
	assert.equal((await client.callTool({ name: 'move_snippets', arguments: batch })).isError, true);
	await client.close();
});
test('both endpoints publish exact resources and reject tokens from the other surface including trailing slashes', async () => {
	for (const app of [false, true]) {
		const path = '/mcp' + (app ? '/app' : ''); const resource = AppFixture.resource + (app ? '/app' : '');
		assert.equal((await (await fetch(AppFixture.url + '/.well-known/oauth-protected-resource' + path)).json()).resource, resource);
		for (const suffix of ['', '/']) {
			const denied = await fetch(AppFixture.url + path + suffix + '?resource=' + encodeURIComponent(AppFixture.resource), { method: 'POST', headers: { Authorization: 'Bearer ' + (app ? 'legacy-token' : 'app-token'), 'Content-Type': 'application/json' }, body: JSON.stringify({ resource: resource === AppFixture.resource ? AppFixture.resource + '/app' : AppFixture.resource }) }); assert.equal(denied.status, 401); assert.ok(denied.headers.get('www-authenticate').endsWith('/.well-known/oauth-protected-resource' + path + '"'));
		}
		assert.equal((await fetch(AppFixture.url + path)).status, 405);
	}
	const client = new Client({ name: 'synthetic-legacy-client', version: '1.0' }); await client.connect(new StreamableHTTPClientTransport(new URL(AppFixture.url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer legacy-token' } } }));
	assert.ok((await client.listTools()).tools.some(tool => tool.name === 'batch_snippets'));
	assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'move_snippets')); await client.close();
});
test('app aliases use existing heavy operation classification', () => { for (const row of TypeRelayMcp.appCatalog.filter(operation => operation.upstream)) assert.ok(McpRateLimit.heavyTools.has(row.upstream), row.id); });

test('every app input schema compiles using the runtime validator', () => { for (const row of TypeRelayMcp.appCatalog) assert.equal(typeof TypeRelayMcp.validator.getValidator(TypeRelayMcp.tool(row).inputSchema), 'function', row.id); });

test('app requests pass underlying operation names to rate and concurrency enforcement', async () => {
	const names = [];
	for (const method of ['createIpFloodLimiter', 'createUnauthLimiter', 'createAuthenticatedRequestLimiter']) mock.method(McpRateLimit, method, () => (req, res, next) => next());
	mock.method(McpRateLimit, 'consumeAuthenticatedRequest', async () => true);
	mock.method(McpRateLimit, 'runToolWithLimits', async options => { names.push(options.toolName); return options.run(); });
	const server = TypeRelayMcp.app({ apiBase: 'http://127.0.0.1:' + AppFixture.upstream.address().port, resource: AppFixture.resource }).listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
	const client = new Client({ name: 'synthetic-limited-client', version: '1.0' });
	try {
		await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + server.address().port + '/mcp/app'), { requestInit: { headers: { Authorization: 'Bearer app-token' } } }));
		for (const operation of TypeRelayMcp.appCatalog.filter(row => row.upstream)) {
			const args = ApiSchema.example({ ...operation, id: operation.upstream }); delete args.action; if (operation.id === 'trash_snippets') delete args.destination_library;
			const result = await client.callTool({ name: operation.id, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); assert.equal(names.at(-1), operation.upstream);
		}
	} finally { await client.close(); await new Promise(resolve => server.close(resolve)); mock.restoreAll(); }
});
