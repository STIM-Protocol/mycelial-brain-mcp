const { Storage } = require('@google-cloud/storage');
const express = require('express');
const crypto = require('crypto');

const app = express();
const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET_NAME || 'mycelial-brain-storage';
const PREFIX = 'doc-';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || ''; // Set in Cloud Run env
const PROTOCOL_VERSION = '2026-07-28';

app.use(express.json());

// --- In-memory doc cache (eliminates per-query GCS downloads) ---
let docCache = null;
let cacheBuiltAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // refresh every 5 min

async function getDocIndex() {
  const now = Date.now();
  if (docCache && (now - cacheBuiltAt) < CACHE_TTL_MS) {
    return docCache;
  }
  const [files] = await storage.bucket(BUCKET).getFiles({ prefix: PREFIX });
  const docs = [];
  for (const file of files) {
    try {
      const [contents] = await file.download();
      const doc = JSON.parse(contents.toString());
      docs.push({
        path: doc.path,
        content: doc.content,
        tags: doc.tags || [],
        textLower: (doc.content || '').toLowerCase(),
        tagsLower: (doc.tags || []).join(' ').toLowerCase()
      });
    } catch (e) { console.error('Skip:', file.name, e.message); }
  }
  docCache = docs;
  cacheBuiltAt = now;
  console.log(`Cache rebuilt: ${docs.length} docs`);
  return docCache;
}

// Invalidate cache on writes
function invalidateCache() {
  docCache = null;
}

// --- Auth middleware ---
function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next(); // No token set = open mode (backward compat)
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (token === AUTH_TOKEN) return next();
  return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
}

// --- Core operations ---
async function getNextDocPath() {
  const docs = await getDocIndex();
  const nums = docs.map(d => parseInt(d.path.replace('doc-', ''))).filter(n => !isNaN(n));
  return 'doc-' + (Math.max(...nums, 0) + 1);
}

async function writeDoc(path, content, tags) {
  const file = storage.bucket(BUCKET).file(path + '.json');
  await file.save(JSON.stringify({ path, content, tags, updated: new Date().toISOString() }), { contentType: 'application/json' });
  invalidateCache();
}

async function searchDocs(query, limit) {
  const synonyms = {
    scares: ['fears','anxieties','afraid'],
    scared: ['fears','anxieties'],
    fear: ['fears','anxieties'],
    failed: ['failures','mistakes','learned'],
    fail: ['failures','mistakes'],
    morning: ['routine','daily'],
    family: ['chelsea','kids','legacy'],
    work: ['how-george-works','field-work'],
    working: ['how-george-works','field-work']
  };

  let expandedTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  for (const term of [...expandedTerms]) {
    if (synonyms[term]) expandedTerms.push(...synonyms[term]);
  }
  const terms = [...new Set(expandedTerms)];
  if (terms.length === 0) return [];

  const docs = await getDocIndex();
  const scored = [];

  for (const doc of docs) {
    let score = 0;
    for (const term of terms) {
      if (doc.textLower.includes(term)) score += 2;
      if (doc.tagsLower.includes(term)) score += 3;
    }
    if (score > 0) {
      scored.push({ path: doc.path, tags: doc.tags, preview: doc.content.slice(0, 150), score });
    }
  }

  scored.sort((a, b) => b.score - a.score || parseInt(a.path.replace('doc-', '')) - parseInt(b.path.replace('doc-', '')));
  return limit ? scored.slice(0, limit) : scored;
}

// --- Routes ---
app.get('/', (_, res) => res.json({ name: 'mycelial-brain', version: '3.0', protocol: PROTOCOL_VERSION }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.post('/mcp', authMiddleware, async (req, res) => {
  const { method, params, id } = req.body || {};
  try {
    // --- MCP initialize ---
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: 'mycelial_brain', version: '3.0.0' },
          capabilities: {
            tools: { listChanged: false }
          }
        }
      });
    }

    // --- tools/list ---
    if (method === 'tools/list') {
      const tools = [
        { name: 'brain_search', description: 'Search the mycelial brain by keywords', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
        { name: 'brain_read', description: 'Read a specific brain document by path', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
        { name: 'brain_write', description: 'Write a document to the brain', inputSchema: { type: 'object', properties: { content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, path: { type: 'string' } }, required: ['content'] } },
        { name: 'brain_list', description: 'List all brain documents with tags', inputSchema: { type: 'object', properties: {} } },
        { name: 'stim_write', description: 'Write a STIM nugget to the brain', inputSchema: { type: 'object', properties: { content: { type: 'string' }, namespace: { type: 'string' }, author: { type: 'string' } }, required: ['content', 'namespace', 'author'] } }
      ];
      return res.json({ jsonrpc: '2.0', id, result: { tools } });
    }

    // --- tools/call ---
    if (method === 'tools/call') {
      const { name, arguments: args } = params;

      if (name === 'brain_write') {
        const path = args.path || await getNextDocPath();
        await writeDoc(path, args.content, args.tags || []);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Saved ' + path }] } });
      }

      if (name === 'brain_search') {
        const results = await searchDocs(args.query, args.limit);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(results) }] } });
      }

      if (name === 'brain_read') {
        const [contents] = await storage.bucket(BUCKET).file(args.path + '.json').download();
        const doc = JSON.parse(contents);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: doc.content }] } });
      }

      if (name === 'brain_list') {
        const docs = await getDocIndex();
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(docs.map(d => ({ path: d.path, tags: d.tags }))) }] } });
      }

      if (name === 'stim_write') {
        const path = await getNextDocPath();
        const tags = ['stim', args.namespace || 'general', args.author || 'unknown'];
        await writeDoc(path, args.content, tags);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'STIM saved ' + path }] } });
      }
    }

    res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  } catch (e) {
    res.json({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Mycelial Brain v3.0 ready (MCP ${PROTOCOL_VERSION})`));
