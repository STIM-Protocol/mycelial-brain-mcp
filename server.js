const { Storage } = require('@google-cloud/storage');
const express = require('express');
const crypto = require('crypto');

const app = express();
const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET_NAME || 'mycelial-brain-storage';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const PROTOCOL_VERSION = '2026-07-28';
const COUNTER_FILE = '_sequence.counter';
const COUNTER_INIT = 416;

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Brain-Owner, X-Brain-Namespace, X-Brain-Author, X-Guardian-Source, Accept');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '10mb' }));

// In-memory doc cache
let docCache = null; // Map<path, DocEntry>
let cacheBuiltAt = 0;
let rebuildPromise = null;
let lastRebuildMs = 0;
const pendingWrites = new Map();

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const FETCH_CONCURRENCY = 50;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'how', 'does', 'do', 'what',
  'and', 'to', 'of', 'in', 'for', 'with', 'on', 'at', 'by', 'this', 'that',
  'it', 'he', 'she', 'they'
]);

function extractTitleAndTimestamp(content) {
  let title = '';
  let timestamp = '';
  if (!content) return { title, timestamp };

  if (content.startsWith('---')) {
    const parts = content.split('---');
    if (parts.length >= 3) {
      const yaml = parts[1];
      const lines = yaml.split('\n');
      for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx !== -1) {
          const key = line.slice(0, idx).trim().toLowerCase();
          const val = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
          if (key === 'title') title = val;
          if (key === 'timestamp' || key === 'date') timestamp = val;
        }
      }
    }
  }

  if (!title) {
    const m = content.match(/^#\s+(.+)$/m);
    if (m) title = m[1].trim();
  }

  return { title, timestamp };
}

function makeEntry(doc, fileName) {
  const rawPath = doc.path || (fileName ? fileName.replace(/\.json$/, '') : '');
  const content = doc.content || '';
  const tags = Array.isArray(doc.tags) ? doc.tags : [];
  const meta = extractTitleAndTimestamp(content);
  const reserved = Boolean(doc.reserved);

  const title = doc.title || meta.title || '';
  const timestamp = doc.timestamp || doc.updated || meta.timestamp || '';
  const updated = doc.updated || doc.timestamp || meta.timestamp || '';

  let timestampMs = 0;
  if (timestamp) {
    const parsed = new Date(timestamp).getTime();
    if (!isNaN(parsed)) timestampMs = parsed;
  }

  return {
    path: rawPath,
    content: content,
    tags: tags,
    title: title,
    timestamp: timestamp,
    timestampMs: timestampMs,
    updated: updated,
    reserved: reserved,
    textLower: content.toLowerCase(),
    tagsLower: tags.join(' ').toLowerCase(),
    pathLower: rawPath.toLowerCase(),
    titleLower: title.toLowerCase()
  };
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function rebuildCache() {
  const started = Date.now();
  const [files] = await storage.bucket(BUCKET).getFiles();
  const jsonFiles = files.filter(f => f.name.endsWith('.json') && !f.name.startsWith('_'));

  const entries = await mapLimit(jsonFiles, FETCH_CONCURRENCY, async file => {
    try {
      const [contents] = await file.download();
      const doc = JSON.parse(contents.toString());
      if (!doc) return null;
      return makeEntry(doc, file.name);
    } catch (e) {
      console.error('Skip file:', file.name, e.message);
      return null;
    }
  });

  const next = new Map();
  for (const e of entries) {
    if (e && e.path) next.set(e.path, e);
  }

  // Preserve concurrent writes during cache rebuild
  for (const [p, e] of pendingWrites) {
    next.set(p, e);
  }
  pendingWrites.clear();

  docCache = next;
  cacheBuiltAt = Date.now();
  lastRebuildMs = cacheBuiltAt - started;
  console.log(`Cache rebuilt: ${next.size} docs in ${lastRebuildMs}ms (${jsonFiles.length} objects scanned)`);
  return docCache;
}

async function getDocIndex() {
  const fresh = docCache && (Date.now() - cacheBuiltAt) < CACHE_TTL_MS;
  if (fresh) return docCache;

  if (docCache) {
    if (!rebuildPromise) {
      rebuildPromise = rebuildCache()
        .catch(e => {
          console.error('Background rebuild failed:', e.message);
          return docCache;
        })
        .finally(() => { rebuildPromise = null; });
    }
    return docCache;
  }

  if (!rebuildPromise) {
    rebuildPromise = rebuildCache().finally(() => { rebuildPromise = null; });
  }
  return rebuildPromise;
}

function upsertCache(path, content, tags, updated, reserved = false) {
  const now = updated || new Date().toISOString();
  const entry = makeEntry({ path, content, tags: tags || [], updated: now, reserved });
  if (docCache) {
    docCache.set(path, entry);
  }
  pendingWrites.set(path, entry);
}

function getMaxDocNum() {
  if (!docCache) return COUNTER_INIT;
  let max = COUNTER_INIT;
  for (const path of docCache.keys()) {
    const m = /^doc-(\d+)$/.exec(path);
    if (m) {
      const num = parseInt(m[1], 10);
      if (!isNaN(num) && num < 900 && num > max) {
        max = num;
      }
    }
  }
  return max;
}

// Auth middleware
function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (token === AUTH_TOKEN) return next();
  return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
}

// Write audit logging (R6)
async function appendAuditLog(agent, path, generation, bytes, overwrite) {
  const auditFile = storage.bucket(BUCKET).file('_audit.log');
  const now = new Date().toISOString();
  const line = `${now} | ${agent || 'unknown'} | ${path} | ${generation || '-'} | ${bytes} | ${overwrite ? 'true' : 'false'}\n`;

  const MAX_AUDIT_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_AUDIT_RETRIES; attempt++) {
    try {
      const [exists] = await auditFile.exists();
      if (!exists) {
        await auditFile.save(line, {
          contentType: 'text/plain',
          preconditionOpts: { ifGenerationMatch: 0 }
        });
        return;
      }
      const [contents] = await auditFile.download();
      const [meta] = await auditFile.getMetadata();
      const newContents = contents.toString() + line;
      const gen = meta ? meta.generation : undefined;
      const opts = { contentType: 'text/plain' };
      if (gen) opts.preconditionOpts = { ifGenerationMatch: gen };
      await auditFile.save(newContents, opts);
      return;
    } catch (e) {
      if (e.code === 412 && attempt < MAX_AUDIT_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 25 * Math.pow(2, attempt)));
        continue;
      }
      console.warn('Audit log write warning:', e.message);
      break;
    }
  }
}

// Atomic sequential ID allocator with Allocate-Then-Reserve & Drift Self-Heal (R3 & R4)
async function brain_allocate() {
  const counterFile = storage.bucket(BUCKET).file(COUNTER_FILE);
  const MAX_RETRIES = 10;
  await getDocIndex();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      let current = COUNTER_INIT;
      let gen = undefined;
      try {
        const [contents] = await counterFile.download();
        const [meta] = await counterFile.getMetadata();
        const rawCurrent = parseInt(contents.toString().trim(), 10) || 0;
        current = rawCurrent;
        gen = meta ? meta.generation : undefined;
      } catch (e) {
        if (e.code !== 404) throw e;
      }

      // Check for counter drift against existing documents
      const maxDoc = getMaxDocNum();
      if (maxDoc > current) {
        console.warn(`COUNTER_DRIFT_CORRECTED: counter was ${current}, max existing doc is ${maxDoc}, bumping counter to ${maxDoc + 1}`);
        current = maxDoc;
      }

      const next = current + 1;
      const counterOpts = { contentType: 'text/plain' };
      if (gen) {
        counterOpts.preconditionOpts = { ifGenerationMatch: gen };
      } else {
        counterOpts.preconditionOpts = { ifGenerationMatch: 0 };
      }

      // 1. Atomically advance counter
      await counterFile.save(next.toString(), counterOpts);

      // 2. Atomically create reservation marker at doc-${next}.json
      const allocPath = `doc-${next}`;
      const resFile = storage.bucket(BUCKET).file(allocPath + '.json');
      const now = new Date().toISOString();
      const resPayload = JSON.stringify({
        path: allocPath,
        content: '',
        tags: ['reserved'],
        reserved: true,
        reserved_at: now,
        updated: now
      });

      try {
        await resFile.save(resPayload, {
          contentType: 'application/json',
          preconditionOpts: { ifGenerationMatch: 0 }
        });
        upsertCache(allocPath, '', ['reserved'], now, true);
      } catch (resErr) {
        if (resErr.code === 412) {
          // Object already exists in GCS, retry sequence allocation
          console.warn(`Reservation collision for ${allocPath}, retrying sequence allocation`);
          continue;
        }
        throw resErr;
      }

      return allocPath;
    } catch (e) {
      if (e.code === 412 && attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 50 * Math.pow(2, attempt) + Math.random() * 50));
        continue;
      }
      console.warn('Counter allocation failed on attempt', attempt, e.message);
    }
  }

  // Fallback scan
  console.warn('Falling back to max doc scan for sequence allocation');
  const maxDocFallback = getMaxDocNum();
  const nextFallback = maxDocFallback + 1;
  const fallbackPath = `doc-${nextFallback}`;
  const resFile = storage.bucket(BUCKET).file(fallbackPath + '.json');
  const now = new Date().toISOString();
  await resFile.save(JSON.stringify({ path: fallbackPath, content: '', tags: ['reserved'], reserved: true, reserved_at: now, updated: now }), {
    contentType: 'application/json'
  }).catch(() => {});
  upsertCache(fallbackPath, '', ['reserved'], now, true);
  return fallbackPath;
}

// Preflight & Conditional Document Write (R1, R2, R6)
async function writeDoc(docPath, content, tags, overwrite = false, author = 'unknown') {
  const cleanPath = docPath.trim();
  const file = storage.bucket(BUCKET).file(cleanPath.endsWith('.json') ? cleanPath : cleanPath + '.json');
  const now = new Date().toISOString();
  const tagsList = Array.isArray(tags) ? tags : [];

  let isReservation = false;
  let currentGen = null;

  try {
    const [exists] = await file.exists();
    if (exists) {
      const [meta] = await file.getMetadata();
      currentGen = meta.generation;

      const cached = docCache ? docCache.get(cleanPath) : null;
      if (cached && cached.reserved) {
        isReservation = true;
      } else {
        try {
          const [contents] = await file.download();
          const parsed = JSON.parse(contents.toString());
          if (parsed && parsed.reserved && (!parsed.content || parsed.content.trim() === '')) {
            isReservation = true;
          }
        } catch (e) {}
      }

      // Preflight existence check: if exists and NOT a reservation and NOT overwrite -> Reject!
      if (!isReservation && !overwrite) {
        return {
          isError: true,
          error: 'DOC_EXISTS',
          path: cleanPath,
          generation: currentGen,
          hint: 'pass overwrite:true, or call brain_allocate() for a fresh slot'
        };
      }
    }
  } catch (e) {
    console.error(`Preflight check error for ${cleanPath}:`, e.message);
  }

  const payload = JSON.stringify({
    path: cleanPath,
    content: content || '',
    tags: tagsList,
    updated: now
  });

  const saveOpts = { contentType: 'application/json' };
  if (currentGen) {
    saveOpts.preconditionOpts = { ifGenerationMatch: currentGen };
  } else {
    saveOpts.preconditionOpts = { ifGenerationMatch: 0 };
  }

  await file.save(payload, saveOpts);
  upsertCache(cleanPath, content || '', tagsList, now, false);

  // Write audit trail
  const byteCount = Buffer.byteLength(content || '', 'utf8');
  appendAuditLog(author, cleanPath, currentGen || '0', byteCount, overwrite).catch(e => {
    console.error('Audit log append failed:', e.message);
  });

  return { success: true, path: cleanPath, generation: currentGen };
}

async function readDoc(docPath) {
  if (docPath === '_sequence.counter' || docPath.endsWith('.counter')) {
    try {
      const [contents] = await storage.bucket(BUCKET).file(COUNTER_FILE).download();
      return { path: '_sequence.counter', content: contents.toString().trim() };
    } catch (e) {
      return { path: '_sequence.counter', content: String(COUNTER_INIT) };
    }
  }

  const cleanPath = docPath.trim();
  const candidatePaths = [
    cleanPath + '.json',
    cleanPath,
    cleanPath + '.md.json',
    cleanPath.replace(/\.md$/, '') + '.json',
    cleanPath.replace(/\.md$/, '') + '.md.json',
    'brain/' + cleanPath + '.json',
    'brain/' + cleanPath + '.md.json'
  ];

  for (const p of candidatePaths) {
    try {
      const [contents] = await storage.bucket(BUCKET).file(p).download();
      const parsed = JSON.parse(contents.toString());
      if (parsed) return parsed;
    } catch (e) {
      // try next
    }
  }
  throw new Error(`Document not found: ${docPath}`);
}

// Tokenized Case-Insensitive Search with Recency Weighting
async function searchDocs(query, limit) {
  const q = (query || '').trim();
  const docsMap = await getDocIndex();
  const docs = Array.from(docsMap.values()).filter(d => !d.reserved);
  const now = Date.now();

  if (!q || q === '*') {
    const sorted = [...docs].sort((a, b) => (b.timestampMs - a.timestampMs) || b.path.localeCompare(a.path));
    const effectiveLimit = limit || 20;
    return sorted.slice(0, effectiveLimit).map(d => ({
      path: d.path,
      tags: d.tags,
      title: d.title,
      preview: dContentPreview(docPreviewContent(d)),
      score: 1.0,
      updated: d.updated || d.timestamp
    }));
  }

  const terms = q.toLowerCase().split(/\s+/).filter(t => !STOP_WORDS.has(t) && t.length > 1);
  if (terms.length === 0) {
    const sorted = [...docs].sort((a, b) => (b.timestampMs - a.timestampMs) || b.path.localeCompare(a.path));
    return sorted.slice(0, limit || 20).map(d => ({
      path: d.path,
      tags: d.tags,
      title: d.title,
      preview: dContentPreview(docPreviewContent(d)),
      score: 1.0,
      updated: d.updated || d.timestamp
    }));
  }

  const scored = [];
  for (const doc of docs) {
    let score = 0;
    for (const term of terms) {
      if (doc.textLower.includes(term)) score += 1;
      if (doc.tagsLower.includes(term)) score += 2;
      if (doc.pathLower.includes(term) || doc.titleLower.includes(term)) score += 1;
    }
    if (score > 0) {
      if (doc.timestampMs > 0) {
        const ageDays = (now - doc.timestampMs) / 86400000;
        if (ageDays >= 0) {
          if (ageDays < 30) score += 0.5;
          if (ageDays < 7) score += 0.5;
        }
      }
      scored.push({
        path: doc.path,
        tags: doc.tags,
        title: doc.title,
        preview: dContentPreview(doc.content),
        score: Math.round(score * 10) / 10
      });
    }
  }

  const seqNum = p => {
    const m = /^doc-(\d+)/.exec(p);
    return m ? +m[1] : 0;
  };

  scored.sort((a, b) => b.score - a.score || (b.timestampMs - a.timestampMs) || (seqNum(b.path) - seqNum(a.path)));
  return limit ? scored.slice(0, limit) : scored;
}

function docPreviewContent(d) {
  return d.content || '';
}

function dContentPreview(content) {
  if (!content) return '';
  const clean = content.replace(/\n+/g, ' ').trim();
  return clean.slice(0, 150) + (clean.length > 150 ? '...' : '');
}

// Additive Paginated brain_list
async function listDocs(args) {
  const docsMap = await getDocIndex();
  let all = Array.from(docsMap.values()).filter(d => !d.reserved);

  if (args && args.prefix) {
    const prefix = args.prefix.toLowerCase();
    all = all.filter(d => d.pathLower.startsWith(prefix));
  }

  const seqNum = p => {
    const m = /^doc-(\d+)/.exec(p);
    return m ? +m[1] : Number.MAX_SAFE_INTEGER;
  };

  all.sort((a, b) => {
    const na = seqNum(a.path);
    const nb = seqNum(b.path);
    if (na !== nb) return na - nb;
    return a.path.localeCompare(b.path);
  });

  const total_count = all.length;
  const offset = Math.max(0, (args && typeof args.offset === 'number') ? args.offset : 0);
  const requestedLimit = (args && typeof args.limit === 'number') ? args.limit : 50;
  const limit = Math.min(Math.max(1, requestedLimit), 500);

  const slice = all.slice(offset, offset + limit);
  const has_more = (offset + slice.length) < total_count;

  return {
    docs: slice.map(d => ({ path: d.path, tags: d.tags })),
    total_count,
    has_more,
    offset,
    limit
  };
}

// Verification Tool (R7)
async function brain_verify() {
  await getDocIndex();
  let counterVal = 0;
  try {
    const [contents] = await storage.bucket(BUCKET).file(COUNTER_FILE).download();
    counterVal = parseInt(contents.toString().trim(), 10) || 0;
  } catch (e) {
    counterVal = COUNTER_INIT;
  }

  const allKeys = Array.from(docCache ? docCache.keys() : []);
  const docNumbers = [];
  const reserved = [];
  const orphans = [];

  for (const k of allKeys) {
    const entry = docCache.get(k);
    if (entry && entry.reserved) {
      reserved.push(k);
    }
    const m = /^doc-(\d+)$/.exec(k);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n < 900) {
        docNumbers.push(n);
      }
    }
  }

  const maxNum = docNumbers.length > 0 ? Math.max(...docNumbers) : COUNTER_INIT;
  const numSet = new Set(docNumbers);
  for (let i = 1; i < maxNum; i++) {
    if (!numSet.has(i)) {
      orphans.push(`doc-${i}`);
    }
  }

  const drift_detected = maxNum > counterVal;

  return {
    counter: counterVal,
    max_doc_id: `doc-${maxNum}`,
    orphans: orphans.slice(0, 50),
    orphan_count: orphans.length,
    reserved: reserved,
    drift_detected
  };
}

// Routes
app.get('/', (_, res) => res.json({ name: 'mycelial-brain', version: '3.3.0', protocol: PROTOCOL_VERSION, status: 'ready' }));

app.get('/mcp', (_, res) => res.json({
  name: 'mycelial-brain',
  version: '3.3.0',
  protocol: PROTOCOL_VERSION,
  status: 'ready',
  transport: 'http',
  endpoint: '/mcp'
}));

app.get('/health', (_, res) => res.json({
  status: 'ok',
  cacheSize: docCache ? docCache.size : 0,
  cacheAgeMs: docCache ? Date.now() - cacheBuiltAt : null,
  lastRebuildMs,
  rebuildInFlight: !!rebuildPromise
}));

app.post('/rebuild', authMiddleware, async (_, res) => {
  try {
    const map = await rebuildCache();
    return res.json({ status: 'ok', size: map.size, rebuildMs: lastRebuildMs });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/mcp', authMiddleware, async (req, res) => {
  const { method, params, id } = req.body || {};
  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: 'mycelial_brain', version: '3.3.0' },
          capabilities: {
            tools: { listChanged: false }
          }
        }
      });
    }

    if (method === 'tools/list') {
      const tools = [
        {
          name: 'brain_search',
          description: 'Search the mycelial brain by keywords with tokenized scoring and recency weighting',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search keywords or phrase' },
              limit: { type: 'number', description: 'Max number of results to return' }
            },
            required: ['query']
          }
        },
        {
          name: 'brain_read',
          description: 'Read a specific brain document by path',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path of the document to read (e.g. doc-397, doc-412, _sequence.counter)' }
            },
            required: ['path']
          }
        },
        {
          name: 'brain_write',
          description: 'Write a document to the brain with optional tags, namespace, and collision protection',
          inputSchema: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              path: { type: 'string' },
              owner: { type: 'string' },
              namespace: { type: 'string' },
              overwrite: { type: 'boolean', description: 'Explicitly allow overwriting an existing document' }
            },
            required: ['content']
          }
        },
        {
          name: 'brain_list',
          description: 'List brain documents with pagination support',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Number of documents to return (default 50, max 500)' },
              offset: { type: 'number', description: 'Pagination offset (default 0)' },
              prefix: { type: 'string', description: 'Optional prefix filter' }
            }
          }
        },
        {
          name: 'brain_verify',
          description: 'Verify health of sequential ID allocations, sequence counter synchronization, and detect drift or reservations',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'stim_write',
          description: 'Write a STIM nugget to the brain',
          inputSchema: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              namespace: { type: 'string' },
              author: { type: 'string' }
            },
            required: ['content', 'namespace', 'author']
          }
        },
        {
          name: 'log_outcome',
          description: 'Log a verifiable action and outcome to the reputation ledger',
          inputSchema: {
            type: 'object',
            properties: {
              action_doc: { type: 'string' },
              action_summary: { type: 'string' },
              outcome: { type: 'string' },
              outcome_type: { type: 'string' },
              date: { type: 'string' },
              context: { type: 'string' },
              owner: { type: 'string' },
              namespace: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } }
            },
            required: ['action_doc', 'action_summary', 'outcome', 'outcome_type', 'date']
          }
        },
        {
          name: 'brain_vault_write',
          description: 'Write a guardian-synced vault document',
          inputSchema: {
            type: 'object',
            properties: {
              vault: { type: 'string' },
              path: { type: 'string' },
              content: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } }
            },
            required: ['vault', 'path', 'content']
          }
        }
      ];
      return res.json({ jsonrpc: '2.0', id, result: { tools } });
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};

      if (name === 'brain_write') {
        const allowedNs = ['hermes/', 'bodhi/', 'm-agent/', 'kai/', 'sylvan/', 'arbor/', 'sequoia/', 'quercus/', 'antigravity/'];
        if (args.path) {
          if (args.path.startsWith('vault/')) {
            return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: reserved namespace. Use brain_vault_write for vault paths.' }], isError: true } });
          }
          if (args.path.startsWith('doc-') && args.path.includes('/')) {
            return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: sequential docs must be flat doc-N, no subpaths.' }], isError: true } });
          }
          const hasNs = allowedNs.some(ns => args.path.startsWith(ns));
          if (!hasNs && args.path.includes('/')) {
            return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: unknown namespace prefix. Allowed: ' + allowedNs.join(', ') + ', or flat doc-N without slash.' }], isError: true } });
          }
        }

        const author = req.headers['x-brain-author'] || req.headers['x-brain-owner'] || (args && args.author) || (args && args.owner) || 'unknown';
        const overwrite = Boolean(args && args.overwrite);
        const path = (args && args.path) ? args.path : await brain_allocate();
        const writeRes = await writeDoc(path, args.content, (args && args.tags) || [], overwrite, author);

        if (writeRes.isError) {
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  error: writeRes.error,
                  path: writeRes.path,
                  generation: writeRes.generation,
                  hint: writeRes.hint
                })
              }],
              isError: true
            }
          });
        }
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Saved ' + path }] } });
      }

      if (name === 'brain_search') {
        const results = await searchDocs(args.query, args.limit);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(results) }] } });
      }

      if (name === 'brain_read') {
        const doc = await readDoc(args.path);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: doc.content }] } });
      }

      if (name === 'brain_list') {
        const listResult = await listDocs(args);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(listResult) }] } });
      }

      if (name === 'brain_verify') {
        const verifyRes = await brain_verify();
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(verifyRes) }] } });
      }

      if (name === 'stim_write') {
        const author = req.headers['x-brain-author'] || (args && args.author) || 'unknown';
        const path = await brain_allocate();
        const tags = ['stim', (args && args.namespace) || 'general', author];
        await writeDoc(path, args.content, tags, true, author);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'STIM saved ' + path }] } });
      }

      if (name === 'log_outcome') {
        const actionDoc = args.action_doc;
        let existing = null;
        try { existing = await readDoc(actionDoc); } catch (e) { /* placeholder */ }
        const now = new Date().toISOString();
        const author = req.headers['x-brain-author'] || (args && args.owner) || 'unknown';
        if (!existing) {
          const placeholder = `---\nowner: ${args.owner || 'unknown'}\nnamespace: ${args.namespace || 'unknown'}\nauthor: ${args.owner || 'unknown'}\ntimestamp: ${now}\ncontent_hash: ${crypto.createHash('sha256').update('').digest('hex')}\nprevious_hash: GENESIS\nparent_doc: ${crypto.randomUUID()}\n---\n\n# ${actionDoc}\nAuto-created placeholder for outcome logging.\n`;
          await writeDoc(actionDoc, placeholder, Array.isArray(args.tags) ? args.tags : [], true, author);
          existing = { content: placeholder, tags: Array.isArray(args.tags) ? args.tags : [] };
        }
        const appended = (existing.content || '') + `\n\n## Outcome - ${args.date || now}\n- Summary: ${args.action_summary}\n- Outcome: ${args.outcome}\n- Type: ${args.outcome_type}\n${args.context ? '- Context: ' + args.context : ''}\n`;
        await writeDoc(actionDoc, appended, existing.tags || [], true, author);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Appended outcome to ' + actionDoc }] } });
      }

      if (name === 'brain_vault_write') {
        const vault = args.vault;
        const path = args.path;
        const allowedVaults = ['FOREST', 'ARBORETUM', 'UNDERSTORY', 'SEED_BANK', 'COMPOST', 'LIBRARY'];
        if (!allowedVaults.includes(vault)) {
          return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: invalid vault name. Allowed: ' + allowedVaults.join(', ') }], isError: true } });
        }
        const guardianHeader = req.headers['x-guardian-source'];
        if (!guardianHeader) {
          return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: X-Guardian-Source header required for vault writes' }], isError: true } });
        }
        const docPath = `vault/${vault}/${path}`.replace(/\.md$/, '');
        const author = req.headers['x-brain-author'] || 'guardian-sync';
        await writeDoc(docPath, args.content, args.tags || [vault.toLowerCase(), 'guardian-sync'], true, author);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Saved ' + docPath }] } });
      }
    }

    res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  } catch (e) {
    res.json({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mycelial Brain v3.3.0 ready (MCP ${PROTOCOL_VERSION})`);
  getDocIndex().catch(e => console.error('Warmup failed:', e.message));
});
