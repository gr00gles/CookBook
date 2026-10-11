import test from 'node:test';
import assert from 'node:assert/strict';
import { InboxCore, handleRequest, LIMITS } from '../src/core.js';

// In-memory stand-ins for Durable Object storage and the namespace binding.
class MemoryStorage {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined; }
  async put(key, value) { this.map.set(key, structuredClone(value)); }
  async delete(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    let n = 0;
    for (const k of list) if (this.map.delete(k)) n++;
    return Array.isArray(keys) ? n : n > 0;
  }
  async list({ prefix = '' } = {}) {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    return new Map(keys.map((k) => [k, structuredClone(this.map.get(k))]));
  }
}

function makeEnv() {
  const inboxes = new Map();
  return {
    inboxes,
    INBOX: {
      idFromName: (name) => name,
      get: (id) => {
        if (!inboxes.has(id)) inboxes.set(id, new InboxCore(new MemoryStorage()));
        return inboxes.get(id);
      },
    },
  };
}

const ORIGIN = 'https://cookbook.test';
function req(env, method, path, { body, key } = {}) {
  const headers = { accept: 'application/json, text/event-stream' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers.authorization = 'Bearer ' + key;
  return handleRequest(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}

async function createInbox(env) {
  const res = await req(env, 'POST', '/v1/inboxes');
  assert.equal(res.status, 201);
  return res.json();
}

const mcpPath = (connectorUrl) => new URL(connectorUrl).pathname;
let nextId = 1;
const rpc = (method, params) => ({ jsonrpc: '2.0', id: nextId++, method, params });

const RECIPE_ARGS = {
  title: 'Weeknight Chili',
  description: 'Smoky and quick.',
  servings: '4',
  cook_time: '35 min',
  ingredients: [
    { items: ['1 lb ground beef', '1 can (15 oz) kidney beans'] },
    { group: 'Spices', items: ['2 tbsp chili powder', '1 tsp cumin'] },
  ],
  steps: [{ items: ['Brown 1 lb ground beef.', 'Stir in 2 tbsp chili powder and 1 tsp cumin.'] }],
  notes: ['Freezes well.'],
  tags: ['Dinner', '#beef', 'dinner'],
};

test('Claude connects over MCP and sees the save_recipe tool', async () => {
  const env = makeEnv();
  const { connectorUrl } = await createInbox(env);
  assert.match(connectorUrl, /^https:\/\/cookbook\.test\/mcp\/[\w-]+\.[\w-]+$/);
  const path = mcpPath(connectorUrl);

  const init = await (await req(env, 'POST', path, { body: rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } }) })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'cookbook');

  const notified = await req(env, 'POST', path, { body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(notified.status, 202);

  const list = await (await req(env, 'POST', path, { body: rpc('tools/list', {}) })).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), ['save_recipe']);
  assert.deepEqual(list.result.tools[0].inputSchema.required, ['title', 'ingredients', 'steps']);

  const get = await req(env, 'GET', path);
  assert.equal(get.status, 405);
  const unknown = await (await req(env, 'POST', path, { body: rpc('resources/list', {}) })).json();
  assert.equal(unknown.error.code, -32601);
});

test('a saved recipe waits in the inbox until the app collects it', async () => {
  const env = makeEnv();
  const { inboxId, readKey, connectorUrl } = await createInbox(env);
  const path = mcpPath(connectorUrl);

  const call = await (await req(env, 'POST', path, { body: rpc('tools/call', { name: 'save_recipe', arguments: RECIPE_ARGS }) })).json();
  assert.equal(call.result.isError, undefined);
  assert.match(call.result.content[0].text, /Saved "Weeknight Chili"/);

  assert.equal((await req(env, 'GET', `/v1/inboxes/${inboxId}/recipes`)).status, 401);
  assert.equal((await req(env, 'GET', `/v1/inboxes/${inboxId}/recipes`, { key: 'wrong' })).status, 401);

  const inbox = await (await req(env, 'GET', `/v1/inboxes/${inboxId}/recipes`, { key: readKey })).json();
  assert.equal(inbox.sending, true);
  assert.equal(inbox.recipes.length, 1);
  const { id, recipe } = inbox.recipes[0];
  assert.deepEqual(recipe, {
    title: 'Weeknight Chili',
    description: 'Smoky and quick.',
    servings: '4',
    prepTime: '',
    cookTime: '35 min',
    totalTime: '',
    ingredients: [
      { title: '', items: ['1 lb ground beef', '1 can (15 oz) kidney beans'] },
      { title: 'Spices', items: ['2 tbsp chili powder', '1 tsp cumin'] },
    ],
    steps: [{ title: '', items: ['Brown 1 lb ground beef.', 'Stir in 2 tbsp chili powder and 1 tsp cumin.'] }],
    notes: [{ title: '', items: ['Freezes well.'] }],
    tags: ['dinner', 'beef'],
  });

  assert.equal((await req(env, 'POST', `/v1/inboxes/${inboxId}/ack`, { key: readKey, body: { ids: [id] } })).status, 204);
  const after = await (await req(env, 'GET', `/v1/inboxes/${inboxId}/recipes`, { key: readKey })).json();
  assert.deepEqual(after.recipes, []);
});

test('incomplete recipes come back to Claude as a fixable error', async () => {
  const env = makeEnv();
  const { connectorUrl } = await createInbox(env);
  const call = await (await req(env, 'POST', mcpPath(connectorUrl), {
    body: rpc('tools/call', { name: 'save_recipe', arguments: { title: 'Toast', ingredients: ['1 slice bread'] } }),
  })).json();
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /steps needs at least one item/);
});

test('turning sending off or making a new link cuts off the old link', async () => {
  const env = makeEnv();
  const { inboxId, readKey, connectorUrl } = await createInbox(env);
  const oldPath = mcpPath(connectorUrl);

  const rotated = await (await req(env, 'POST', `/v1/inboxes/${inboxId}/connector`, { key: readKey })).json();
  assert.notEqual(rotated.connectorUrl, connectorUrl);
  assert.equal((await req(env, 'POST', oldPath, { body: rpc('tools/list', {}) })).status, 404);
  assert.equal((await req(env, 'POST', mcpPath(rotated.connectorUrl), { body: rpc('tools/list', {}) })).status, 200);

  assert.equal((await req(env, 'DELETE', `/v1/inboxes/${inboxId}/connector`, { key: readKey })).status, 204);
  assert.equal((await req(env, 'POST', mcpPath(rotated.connectorUrl), { body: rpc('tools/list', {}) })).status, 404);
  const inbox = await (await req(env, 'GET', `/v1/inboxes/${inboxId}/recipes`, { key: readKey })).json();
  assert.equal(inbox.sending, false);

  assert.equal((await req(env, 'POST', '/mcp/not-a-token', { body: rpc('tools/list', {}) })).status, 404);
  assert.equal((await req(env, 'POST', `/v1/inboxes/${inboxId}/connector`, { key: 'wrong' })).status, 401);
});

test('each person has their own inbox', async () => {
  const env = makeEnv();
  const a = await createInbox(env);
  const b = await createInbox(env);
  await req(env, 'POST', mcpPath(a.connectorUrl), { body: rpc('tools/call', { name: 'save_recipe', arguments: RECIPE_ARGS }) });
  const bInbox = await (await req(env, 'GET', `/v1/inboxes/${b.inboxId}/recipes`, { key: b.readKey })).json();
  assert.deepEqual(bInbox.recipes, []);
  assert.equal((await req(env, 'GET', `/v1/inboxes/${b.inboxId}/recipes`, { key: a.readKey })).status, 401);
});

test('a full inbox refuses more recipes', async () => {
  const env = makeEnv();
  const { connectorUrl } = await createInbox(env);
  const path = mcpPath(connectorUrl);
  for (let i = 0; i < LIMITS.maxPending; i++) {
    await req(env, 'POST', path, { body: rpc('tools/call', { name: 'save_recipe', arguments: RECIPE_ARGS }) });
  }
  const call = await (await req(env, 'POST', path, { body: rpc('tools/call', { name: 'save_recipe', arguments: RECIPE_ARGS }) })).json();
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /too many recipes waiting/);
});
