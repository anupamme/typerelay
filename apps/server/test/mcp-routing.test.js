import { before, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { McpApi, TypeRelayMcp } from '../../mcp/server.js';
import { WhiteLabel } from '../services/white_label.js';
import { Billing } from '../services/billing.js';
import { Account } from '../model/index.js';

const requireMcp = createRequire(new URL('../../mcp/server.js', import.meta.url));
const { Client } = await import(requireMcp.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StreamableHTTPClientTransport } = await import(requireMcp.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));

class RoutingFixture { static upstream; static server; static base; static url; static calls = []; static scopes = ['content:read']; static expired = false; static saved = { APP_URL: process.env.APP_URL, WHITE_LABEL_ENABLED: process.env.WHITE_LABEL_ENABLED }; }
before(async () => {
	process.env.APP_URL = 'https://app.typerelay.test'; process.env.WHITE_LABEL_ENABLED = 'true';
	mock.method(Billing, 'hosted', () => true);
	mock.method(Account, 'findOne', () => ({ lean: async () => null }));
	const app = express(); app.use(express.json()); app.use(WhiteLabel.resolveRequest);
	app.use((req, res, next) => { RoutingFixture.calls.push({ path: req.path, host: req.headers.host, forwarded: req.headers['x-forwarded-host'], authorization: req.headers.authorization }); next(); });
	app.post('/integrations/delegate', (req, res) => {
		assert.equal(req.headers['x-mcp-secret'], 'synthetic-secret');
		if (req.headers.authorization !== 'Bearer synthetic-token') return res.status(401).send('Synthetic non-JSON auth rejection');
		res.json({ access_token: 'synthetic-delegated-token' });
	});
	app.get('/api/v3/me', (req, res) => { assert.equal(req.headers.authorization, 'Bearer synthetic-delegated-token'); res.json({ scopes: RoutingFixture.scopes }); });
	app.get('/api/v3/search', (req, res) => { assert.equal(req.headers.authorization, 'Bearer synthetic-delegated-token'); if (RoutingFixture.expired) return res.status(401).send('Synthetic non-JSON auth rejection'); res.json({ items: [{ id: 'synthetic-snippet', content: { type: 'plain_text', text: 'Synthetic greeting' } }], next_cursor: null }); });
	app.get('/malformed', (req, res) => res.send('Synthetic invalid JSON'));
	RoutingFixture.upstream = app.listen(0, '127.0.0.1'); await new Promise(resolve => RoutingFixture.upstream.once('listening', resolve));
	RoutingFixture.base = 'http://127.0.0.1:' + RoutingFixture.upstream.address().port;
	RoutingFixture.server = TypeRelayMcp.app({ apiBase: RoutingFixture.base, issuer: process.env.APP_URL, secret: () => 'synthetic-secret', applyRateLimits: false }).listen(0, '127.0.0.1'); await new Promise(resolve => RoutingFixture.server.once('listening', resolve));
	RoutingFixture.url = 'http://127.0.0.1:' + RoutingFixture.server.address().port + '/mcp';
});
after(async () => { await new Promise(resolve => RoutingFixture.server.close(resolve)); await new Promise(resolve => RoutingFixture.upstream.close(resolve)); mock.restoreAll(); for (const [key, value] of Object.entries(RoutingFixture.saved)) value === undefined ? delete process.env[key] : process.env[key] = value; });
test('real white-label middleware rejects internal and unconfigured tenant hosts', async () => {
	for (const headers of [{ Host: 'typerelay_app:3000' }, { Host: 'unconfigured.tenant.test' }, { Host: 'app.typerelay.test', 'X-Forwarded-Host': 'unconfigured.tenant.test' }]) {
		const response = await new Promise((resolve, reject) => { const req = request(RoutingFixture.base + '/api/v3/me', { headers }, res => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body })); }); req.on('error', reject); req.end(); });
		assert.equal(response.status, 404); assert.equal(response.body, 'Custom domain is not configured.');
	}
	const api = new McpApi(RoutingFixture.base, 'Bearer synthetic-token', 'http://typerelay_app:3000');
	await assert.rejects(api.request('/api/v3/me'), error => error.status === 404 && error.message === 'API request failed (HTTP 404)');
});
test('authenticated SDK handshake and content use trusted configured host and preserve scope gates', async () => {
	const client = new Client({ name: 'synthetic-routing-client', version: '1.0' });
	await client.connect(new StreamableHTTPClientTransport(new URL(RoutingFixture.url), { requestInit: { headers: { Authorization: 'Bearer synthetic-token', Host: 'unconfigured.tenant.test', 'X-Forwarded-Host': 'untrusted.tenant.test' } } }));
	assert.ok((await client.listTools()).tools.some(tool => tool.name === 'search_snippets'));
	assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'create_snippet'));
	assert.equal((await client.callTool({ name: 'search_snippets', arguments: { q: 'greeting' } })).structuredContent.items[0].id, 'synthetic-snippet');
	assert.equal((await client.callTool({ name: 'create_snippet', arguments: {} })).isError, true);
	RoutingFixture.expired = true;
	const expired = await client.callTool({ name: 'search_snippets', arguments: { q: 'greeting' } });
	assert.equal(expired.isError, true); assert.match(expired._meta['mcp/www_authenticate'][0], /resource_metadata/); assert.doesNotMatch(expired.content[0].text, /Synthetic non-JSON/);
	RoutingFixture.expired = false;
	await client.close();
	assert.ok(RoutingFixture.calls.some(call => call.path === '/integrations/delegate' && call.authorization === 'Bearer synthetic-token'));
	assert.ok(RoutingFixture.calls.some(call => call.path === '/api/v3/me' && call.authorization === 'Bearer synthetic-delegated-token'));
	for (const call of RoutingFixture.calls) { assert.equal(call.host, new URL(RoutingFixture.base).host); assert.equal(call.forwarded, 'app.typerelay.test'); }
});
test('malformed upstream responses preserve auth challenges and never expose raw bodies', async () => {
	const response = await fetch(RoutingFixture.url, { method: 'POST', headers: { Authorization: 'Bearer invalid-synthetic-token', 'Content-Type': 'application/json' }, body: '{}' });
	assert.equal(response.status, 401); assert.match(response.headers.get('www-authenticate'), /resource_metadata/); assert.doesNotMatch(await response.text(), /Synthetic non-JSON/);
	const api = new McpApi(RoutingFixture.base, 'Bearer synthetic-token', process.env.APP_URL);
	await assert.rejects(api.request('/malformed'), error => error.status === 502 && error.message === 'API returned an invalid JSON response');
});
