// CookBook server logic: per-person recipe inboxes, the HTTP API the iPhone app
// uses, and the MCP endpoint Claude calls to send recipes.
//
// Nothing here depends on Cloudflare-only modules, so the tests run it under Node
// with an in-memory stand-in for Durable Object storage.

export const LIMITS = {
  maxPending: 100, // recipes waiting in one inbox
  maxRecipeBytes: 64 * 1024,
  ttlMs: 30 * 24 * 60 * 60 * 1000, // undelivered recipes are dropped after 30 days
};

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ---------------------------------------------------------------------------
// Tokens

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return base64url(a);
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return base64url(new Uint8Array(digest));
}

function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// One inbox. In production this lives in a Durable Object; `storage` is its
// key-value storage (get/put/delete/list).

export class InboxCore {
  constructor(storage) {
    this.storage = storage;
  }

  async init(readKeyHash, sendSecretHash) {
    if (await this.storage.get('meta')) return { ok: false, status: 409 };
    await this.storage.put('meta', { readKeyHash, sendSecretHash, createdAt: Date.now(), lastDeliveryAt: null });
    return { ok: true };
  }

  async authorized(readKey) {
    const meta = await this.storage.get('meta');
    if (!meta || !readKey) return null;
    return sameString(await sha256(readKey), meta.readKeyHash) ? meta : null;
  }

  async pending() {
    const items = await this.storage.list({ prefix: 'item:' });
    const cutoff = Date.now() - LIMITS.ttlMs;
    const expired = [];
    const fresh = [];
    for (const [key, item] of items) {
      if (item.receivedAt < cutoff) expired.push(key);
      else fresh.push(item);
    }
    if (expired.length) await this.storage.delete(expired);
    return fresh.sort((a, b) => a.receivedAt - b.receivedAt);
  }

  async list(readKey) {
    const meta = await this.authorized(readKey);
    if (!meta) return { ok: false, status: 401 };
    return { ok: true, recipes: await this.pending(), sending: !!meta.sendSecretHash, lastDeliveryAt: meta.lastDeliveryAt };
  }

  async ack(readKey, ids) {
    if (!(await this.authorized(readKey))) return { ok: false, status: 401 };
    const keys = (Array.isArray(ids) ? ids : [])
      .filter((id) => typeof id === 'string' && ID_RE.test(id))
      .slice(0, 128)
      .map((id) => 'item:' + id);
    if (keys.length) await this.storage.delete(keys);
    return { ok: true };
  }

  async rotate(readKey) {
    const meta = await this.authorized(readKey);
    if (!meta) return { ok: false, status: 401 };
    const sendSecret = randomToken();
    await this.storage.put('meta', { ...meta, sendSecretHash: await sha256(sendSecret) });
    return { ok: true, sendSecret };
  }

  async disable(readKey) {
    const meta = await this.authorized(readKey);
    if (!meta) return { ok: false, status: 401 };
    await this.storage.put('meta', { ...meta, sendSecretHash: null });
    return { ok: true };
  }

  async canSend(sendSecret) {
    const meta = await this.storage.get('meta');
    if (!meta || !meta.sendSecretHash || !sendSecret) return false;
    return sameString(await sha256(sendSecret), meta.sendSecretHash);
  }

  async deliver(sendSecret, recipe) {
    if (!(await this.canSend(sendSecret))) return { ok: false, status: 404 };
    const pending = await this.pending();
    if (pending.length >= LIMITS.maxPending) return { ok: false, status: 429 };
    const now = Date.now();
    const id = now.toString(36) + '-' + randomToken(6);
    await this.storage.put('item:' + id, { id, receivedAt: now, recipe });
    const meta = await this.storage.get('meta');
    await this.storage.put('meta', { ...meta, lastDeliveryAt: now });
    return { ok: true, id };
  }
}

// ---------------------------------------------------------------------------
// Validating what Claude sends

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, max) : '';
}

function cleanGroups(value, label, problems) {
  if (value == null) return [];
  if (!Array.isArray(value)) { problems.push(`${label} must be a list.`); return []; }
  const groups = [];
  let loose = null;
  for (const entry of value.slice(0, 40)) {
    if (typeof entry === 'string') {
      if (!loose) { loose = { title: '', items: [] }; groups.push(loose); }
      const item = cleanText(entry, 2000);
      if (item) loose.items.push(item);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const items = (Array.isArray(entry.items) ? entry.items : [])
      .slice(0, 150)
      .map((x) => cleanText(x, 2000))
      .filter(Boolean);
    if (items.length) groups.push({ title: cleanText(entry.group ?? entry.title, 120), items });
  }
  return groups.filter((g) => g.items.length);
}

export function normalizeRecipe(args) {
  const problems = [];
  const a = args && typeof args === 'object' ? args : {};
  const recipe = {
    title: cleanText(a.title, 200),
    description: cleanText(a.description, 2000),
    servings: cleanText(a.servings, 60),
    prepTime: cleanText(a.prep_time, 60),
    cookTime: cleanText(a.cook_time, 60),
    totalTime: cleanText(a.total_time, 60),
    ingredients: cleanGroups(a.ingredients, 'ingredients', problems),
    steps: cleanGroups(a.steps, 'steps', problems),
    notes: [],
    tags: [],
  };
  const notes = (Array.isArray(a.notes) ? a.notes : []).slice(0, 60).map((x) => cleanText(x, 2000)).filter(Boolean);
  if (notes.length) recipe.notes = [{ title: '', items: notes }];
  const tags = new Set();
  for (const t of Array.isArray(a.tags) ? a.tags : []) {
    const tag = cleanText(t, 30).toLowerCase().replace(/^#/, '').replace(/\s+/g, ' ');
    if (tag) tags.add(tag);
  }
  recipe.tags = Array.from(tags).slice(0, 12);

  if (!recipe.title) problems.push('title is required.');
  if (!recipe.ingredients.length) problems.push('ingredients needs at least one item.');
  if (!recipe.steps.length) problems.push('steps needs at least one item.');
  if (new TextEncoder().encode(JSON.stringify(recipe)).length > LIMITS.maxRecipeBytes) {
    problems.push('The recipe is too long. Keep it under 64 KB.');
  }
  return { recipe, problems };
}

// ---------------------------------------------------------------------------
// MCP (Streamable HTTP, JSON responses, no sessions)

const groupSchema = (what) => ({
  type: 'array',
  description: `${what} For a recipe without parts, send one entry with just "items".`,
  items: {
    type: 'object',
    properties: {
      group: { type: 'string', description: 'Optional heading for a part of the recipe, like "For the sauce".' },
      items: { type: 'array', items: { type: 'string' } },
    },
    required: ['items'],
  },
});

export const SAVE_RECIPE_TOOL = {
  name: 'save_recipe',
  title: 'Save recipe to CookBook',
  description:
    "Save a recipe to the user's CookBook iPhone app. Use this when the user asks to save, add, send or keep a recipe in CookBook. " +
    'Write the exact amount of every ingredient into each step where it is used ("Add 2 tbsp olive oil", never "add the oil"), ' +
    'as well as listing it under ingredients. The recipe appears in the app the next time it is opened.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Recipe name.' },
      description: { type: 'string', description: 'One or two sentences about the dish.' },
      servings: { type: 'string', description: 'How many it serves or makes, like "4" or "24 cookies".' },
      prep_time: { type: 'string', description: 'Like "15 min".' },
      cook_time: { type: 'string', description: 'Like "30 min".' },
      total_time: { type: 'string', description: 'Like "45 min".' },
      ingredients: groupSchema('Ingredients with amounts, like "2 tbsp olive oil".'),
      steps: groupSchema('Directions in order. Each step includes the amounts of the ingredients it uses.'),
      notes: { type: 'array', items: { type: 'string' }, description: 'Tips, swaps and storage notes.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'A few short lowercase tags, like "dinner" or "vegetarian".' },
    },
    required: ['title', 'ingredients', 'steps'],
  },
  annotations: {
    title: 'Save recipe to CookBook',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

const INSTRUCTIONS =
  "This connector sends recipes to the user's CookBook iPhone app. When the user asks to save or send a recipe to CookBook, " +
  'call save_recipe with the full recipe. Always write each ingredient amount into the step where it is used.';

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function toolText(text, isError) {
  const out = { content: [{ type: 'text', text }] };
  if (isError) out.isError = true;
  return out;
}

async function handleRpc(msg, inbox, sendSecret) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id != null ? msg.id : null, -32600, 'Invalid request');
  }
  const isNotification = !('id' in msg);
  if (isNotification) return null;
  const { id, method } = msg;
  const params = msg.params || {};

  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cookbook', title: 'CookBook', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: [SAVE_RECIPE_TOOL] });
    case 'tools/call': {
      if (params.name !== SAVE_RECIPE_TOOL.name) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      const { recipe, problems } = normalizeRecipe(params.arguments);
      if (problems.length) {
        return rpcResult(id, toolText('The recipe was not saved. Fix these and try again: ' + problems.join(' '), true));
      }
      const res = await inbox.deliver(sendSecret, recipe);
      if (res.ok) {
        return rpcResult(id, toolText(`Saved "${recipe.title}" to CookBook. It will show up in the app the next time it is opened.`));
      }
      if (res.status === 429) {
        return rpcResult(id, toolText('CookBook has too many recipes waiting. Ask the user to open the app so it can collect them, then try again.', true));
      }
      return rpcResult(id, toolText('This CookBook link is no longer active. Ask the user to turn on "Let Claude send recipes" in the app and reconnect.', true));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP routing

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : '';
}

function inboxFor(env, inboxId) {
  return env.INBOX.get(env.INBOX.idFromName(inboxId));
}

function failure(res) {
  const messages = { 401: 'Not authorized for this inbox.', 404: 'Not found.', 409: 'That inbox already exists.', 429: 'Too many recipes waiting.' };
  return json({ error: messages[res.status] || 'Request failed.' }, res.status || 400);
}

async function handleMcp(request, env, token) {
  if (request.method !== 'POST') {
    return new Response('This MCP endpoint accepts POST requests only.', { status: 405, headers: { allow: 'POST' } });
  }
  const dot = token.indexOf('.');
  const inboxId = token.slice(0, dot);
  const sendSecret = token.slice(dot + 1);
  if (dot < 0 || !ID_RE.test(inboxId) || !sendSecret) return json(rpcError(null, -32001, 'Unknown CookBook link.'), 404);

  const inbox = inboxFor(env, inboxId);
  if (!(await inbox.canSend(sendSecret))) {
    return json(rpcError(null, -32001, 'This CookBook link is no longer active. Make a new link in the CookBook app under Settings.'), 404);
  }

  let body;
  try { body = await request.json(); } catch (e) { return json(rpcError(null, -32700, 'Parse error'), 400); }
  const batch = Array.isArray(body);
  const replies = [];
  for (const msg of batch ? body : [body]) {
    const reply = await handleRpc(msg, inbox, sendSecret);
    if (reply) replies.push(reply);
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return json(batch ? replies : replies[0]);
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts.length === 0) {
    return new Response('CookBook server is running.\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  if (parts[0] === 'mcp' && parts.length === 2) return handleMcp(request, env, parts[1]);

  if (parts[0] !== 'v1' || parts[1] !== 'inboxes') return json({ error: 'Not found.' }, 404);

  // POST /v1/inboxes -> a new inbox for one person's app
  if (parts.length === 2) {
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    const inboxId = randomToken(12);
    const readKey = randomToken(32);
    const sendSecret = randomToken();
    const res = await inboxFor(env, inboxId).init(await sha256(readKey), await sha256(sendSecret));
    if (!res.ok) return failure(res);
    return json({ inboxId, readKey, connectorUrl: `${url.origin}/mcp/${inboxId}.${sendSecret}` }, 201);
  }

  const inboxId = parts[2];
  if (!ID_RE.test(inboxId)) return json({ error: 'Not found.' }, 404);
  const inbox = inboxFor(env, inboxId);
  const key = bearer(request);
  const route = request.method + ' ' + parts.slice(3).join('/');

  switch (route) {
    case 'GET recipes': {
      const res = await inbox.list(key);
      return res.ok ? json({ recipes: res.recipes, sending: res.sending, lastDeliveryAt: res.lastDeliveryAt }) : failure(res);
    }
    case 'POST ack': {
      let body = {};
      try { body = await request.json(); } catch (e) { /* empty body */ }
      const res = await inbox.ack(key, body.ids);
      return res.ok ? new Response(null, { status: 204 }) : failure(res);
    }
    case 'POST connector': {
      const res = await inbox.rotate(key);
      return res.ok ? json({ connectorUrl: `${url.origin}/mcp/${inboxId}.${res.sendSecret}` }) : failure(res);
    }
    case 'DELETE connector': {
      const res = await inbox.disable(key);
      return res.ok ? new Response(null, { status: 204 }) : failure(res);
    }
    default:
      return json({ error: 'Not found.' }, 404);
  }
}
