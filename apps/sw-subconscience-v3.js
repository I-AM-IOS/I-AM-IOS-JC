// ════════════════════════════════════════════════════════════
//  I-AM-AI v3 — SUB-CONSCIENCE SERVICE WORKER
//  Background learning · Pattern detection · Insight generation
//  Local-only · IndexedDB · Ollama
// ════════════════════════════════════════════════════════════

const SW_VERSION = 'i-am-ai-v3.0';
const DB_NAME    = 'I-AM-AI-SubConscience-v3';
const DB_VERSION = 3;

const STORES = {
  memories:     'memories',
  patterns:     'patterns',
  insights:     'insights',
  summaries:    'summaries',
};

let CONFIG = {
  ollamaUrl: 'http://localhost:11434',
  model:     'llama3.2',
  temp:       0.55,
};

let db            = null;
let dbReady       = false;
let dbInitPromise = null;
let isProcessing  = false;
let memStoreCount = 0;

// ════════════════════════════════════════════════════════════
//  DATABASE
// ════════════════════════════════════════════════════════════
function initDB() {
  if (dbInitPromise) return dbInitPromise;
  dbInitPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { db = req.result; dbReady = true; resolve(db); };
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORES.memories)) {
        const s = d.createObjectStore(STORES.memories, { keyPath: 'id', autoIncrement: true });
        s.createIndex('timestamp', 'timestamp', { unique: false });
        s.createIndex('type',      'type',      { unique: false });
        s.createIndex('session',   'session',   { unique: false });
      }
      if (!d.objectStoreNames.contains(STORES.patterns)) {
        const s = d.createObjectStore(STORES.patterns, { keyPath: 'pattern' });
        s.createIndex('strength',  'strength',  { unique: false });
        s.createIndex('frequency', 'frequency', { unique: false });
        s.createIndex('category',  'category',  { unique: false });
      }
      if (!d.objectStoreNames.contains(STORES.insights)) {
        const s = d.createObjectStore(STORES.insights, { keyPath: 'id', autoIncrement: true });
        s.createIndex('timestamp',  'timestamp',  { unique: false });
        s.createIndex('confidence', 'confidence', { unique: false });
        s.createIndex('type',       'type',       { unique: false });
      }
      if (!d.objectStoreNames.contains(STORES.summaries)) {
        const s = d.createObjectStore(STORES.summaries, { keyPath: 'id', autoIncrement: true });
        s.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
  return dbInitPromise;
}

async function requireDB() {
  if (!dbReady) await initDB();
  if (!db) throw new Error('Database not available');
}

// ════════════════════════════════════════════════════════════
//  MEMORY SYSTEM
// ════════════════════════════════════════════════════════════
const Memory = {
  async store(type, content, metadata = {}) {
    await requireDB();
    const memory = { type, content, metadata, timestamp: Date.now(), processed: false, session: metadata.session || 'default' };
    return new Promise((resolve, reject) => {
      const tx  = db.transaction([STORES.memories], 'readwrite');
      const req = tx.objectStore(STORES.memories).add(memory);
      req.onsuccess = () => {
        memStoreCount++;
        broadcast('memory-stored', { memoryId: req.result, memoryType: type });
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async getRecent(type, limit = 30) {
    await requireDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction([STORES.memories], 'readonly');
      const store = tx.objectStore(STORES.memories);
      const req   = type ? store.index('type').getAll(type) : store.getAll();
      req.onsuccess = () => resolve((req.result || []).slice().reverse().slice(0, limit));
      req.onerror   = () => reject(req.error);
    });
  },

  async getAll() {
    await requireDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction([STORES.memories], 'readonly');
      const req = tx.objectStore(STORES.memories).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  },

  async count() {
    await requireDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction([STORES.memories], 'readonly');
      const req = tx.objectStore(STORES.memories).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  },

  async clearStore(storeName) {
    await requireDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction([storeName], 'readwrite');
      const req = tx.objectStore(storeName).clear();
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  },

  async clearAll() {
    await Promise.all(Object.values(STORES).map(s => this.clearStore(s)));
    memStoreCount = 0;
  },

  async getStats() {
    await requireDB();
    const [memCount, patCount, insCount] = await Promise.all([
      this.count(),
      new Promise((res, rej) => {
        const req = db.transaction([STORES.patterns], 'readonly').objectStore(STORES.patterns).count();
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
      }),
      new Promise((res, rej) => {
        const req = db.transaction([STORES.insights], 'readonly').objectStore(STORES.insights).count();
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
      }),
    ]);
    return { memories: memCount, patterns: patCount, insights: insCount };
  }
};

// ════════════════════════════════════════════════════════════
//  PATTERN DETECTION — enhanced with bigrams + categories
// ════════════════════════════════════════════════════════════
const STOPWORDS = new Set([
  'about','after','again','also','another','around','because','been','before',
  'being','between','could','doing','down','during','each','every','first',
  'from','going','have','having','here','into','just','know','like','make',
  'many','more','most','much','need','only','other','over','same','some',
  'such','than','that','their','them','then','there','these','they','thing',
  'think','this','those','through','time','under','until','using','very',
  'want','well','were','what','when','where','which','while','will','with',
  'would','your','said','says','can','get','got','let','may','might','must',
  'shall','should','used','way','way',
]);

const PatternDetector = {
  categorize(word) {
    const techTerms = new Set(['model','token','context','neural','data','code','function','api','llm','prompt']);
    const sciTerms  = new Set(['quantum','entropy','system','theory','structure','process','analysis','network']);
    if (techTerms.has(word)) return 'technical';
    if (sciTerms.has(word))  return 'scientific';
    return 'general';
  },

  async detect() {
    await requireDB();
    const memories = await Memory.getAll();
    if (memories.length < 2) return 0;

    const freq = {};
    const bigramFreq = {};

    memories.forEach(mem => {
      if (!['interaction','explanation','analogy','session-summary'].includes(mem.type)) return;
      const words = (mem.content || '')
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !STOPWORDS.has(w));
      words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
      for (let i = 0; i < words.length - 1; i++) {
        const bg = `${words[i]} ${words[i+1]}`;
        bigramFreq[bg] = (bigramFreq[bg] || 0) + 1;
      }
    });

    const total = memories.length;
    const tx    = db.transaction([STORES.patterns], 'readwrite');
    const store = tx.objectStore(STORES.patterns);
    let stored  = 0;

    for (const [pattern, frequency] of Object.entries(freq)) {
      if (frequency < 2) continue;
      const strength = Math.min(frequency / total, 1);
      const category = this.categorize(pattern);
      await new Promise((res, rej) => {
        const req = store.put({ pattern, frequency, strength, category, lastSeen: Date.now(), isBigram: false });
        req.onsuccess = () => { stored++; res(); };
        req.onerror = () => rej(req.error);
      });
    }

    for (const [pattern, frequency] of Object.entries(bigramFreq)) {
      if (frequency < 2) continue;
      const strength = Math.min(frequency / total, 1);
      await new Promise((res, rej) => {
        const req = store.put({ pattern, frequency, strength, category: 'phrase', lastSeen: Date.now(), isBigram: true });
        req.onsuccess = () => { stored++; res(); };
        req.onerror = () => rej(req.error);
      });
    }

    return stored;
  },

  async getPatterns(limit = 30) {
    await requireDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction([STORES.patterns], 'readonly');
      const req = tx.objectStore(STORES.patterns).index('strength').getAll();
      req.onsuccess = () => resolve((req.result || []).sort((a,b) => b.strength - a.strength).slice(0, limit));
      req.onerror = () => reject(req.error);
    });
  },
};

// ════════════════════════════════════════════════════════════
//  SUB-CONSCIENCE — insight generation
// ════════════════════════════════════════════════════════════
const SubConscience = {
  async generateInsight(type = 'general') {
    if (isProcessing) return null;
    isProcessing = true;
    broadcastStatus({ active: true, processing: true });

    try {
      const [memories, patterns] = await Promise.all([
        Memory.getRecent(null, 20),
        PatternDetector.getPatterns(15),
      ]);
      if (memories.length < 2) return null;

      const memSnippet = memories.slice(0, 10).map(m => m.content.slice(0, 200)).join('\n---\n');
      const patSnippet = patterns.slice(0, 8).map(p => `"${p.pattern}" (${p.isBigram?'phrase':'term'}, strength:${p.strength.toFixed(2)})`).join(', ');

      const prompts = {
        general: `You are a background analytical process. Review these conversation memories and detected patterns. Generate a concise, novel insight about the user's thinking patterns, interests, or knowledge gaps.\n\nMemories:\n${memSnippet}\n\nKey patterns: ${patSnippet || 'none yet'}\n\nRespond with a single insightful observation in 2-4 sentences. Be specific, not generic.`,
        deep:    `You are a meta-cognitive analyzer. Study these interactions and find a deeper structural pattern — a recurring cognitive framework, bias, or knowledge architecture the user is building.\n\nMemories:\n${memSnippet}\n\nPatterns: ${patSnippet || 'none'}\n\nRespond with one deep structural insight (3-5 sentences). Reference specific concepts from the data.`,
        question:`You are a Socratic sub-process. Based on these interactions, generate the single most important clarifying question that would most advance the user's understanding.\n\nMemories:\n${memSnippet}\n\nRespond with one powerful question and brief reasoning (2-3 sentences total).`,
      };

      const raw = await this.queryOllama(prompts[type] || prompts.general);
      if (!raw.trim()) return null;

      const confidence = Math.min(0.95, 0.4 + (memories.length / 40) + (patterns.length / 30));
      const insight = {
        text:           raw.trim(),
        type,
        confidence,
        sourcePatterns: patterns.slice(0,5).map(p => p.pattern),
        sourceMemCount: memories.length,
        model:          CONFIG.model,
        timestamp:      Date.now(),
      };

      const id = await this.storeInsight(insight);
      broadcast('subconscience-insight', { insightId: id, ...insight });
      return id;

    } catch (err) {
      console.error('[SubConscience] generateInsight error:', err.message);
      return null;
    } finally {
      isProcessing = false;
      broadcastStatus({ active: true, processing: false });
    }
  },

  async storeInsight(insight) {
    await requireDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction([STORES.insights], 'readwrite');
      const req = tx.objectStore(STORES.insights).add(insight);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async getInsights(limit = 15) {
    await requireDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction([STORES.insights], 'readonly');
      const req = tx.objectStore(STORES.insights).getAll();
      req.onsuccess = () => resolve((req.result || []).slice().reverse().slice(0, limit));
      req.onerror = () => reject(req.error);
    });
  },

  async queryOllama(prompt) {
    const res = await fetch(`${CONFIG.ollamaUrl}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: CONFIG.model, prompt, stream: false, options: { temperature: CONFIG.temp } }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = await res.json();
    return data.response || '';
  },
};

// ════════════════════════════════════════════════════════════
//  BROADCAST HELPERS
// ════════════════════════════════════════════════════════════
function broadcast(type, data = {}) {
  self.clients.matchAll().then(clients => {
    clients.forEach(c => c.postMessage({ type, data: { timestamp: Date.now(), ...data } }));
  });
}

function broadcastStatus(data) {
  broadcast('subconscience-status', data);
}

// ════════════════════════════════════════════════════════════
//  BACKGROUND TASKS
// ════════════════════════════════════════════════════════════
function scheduleHeartbeat() {
  setTimeout(() => {
    broadcastStatus({ active: true, processing: isProcessing });
    scheduleHeartbeat();
  }, 10_000);
}

function schedulePatternScan() {
  setTimeout(async () => {
    try {
      const n = await PatternDetector.detect();
      memStoreCount = 0;
      if (n > 0) {
        console.log(`[SubConscience] Patterns updated: ${n}`);
        const stats = await Memory.getStats();
        broadcast('stats-update', stats);
      }
    } catch (err) { console.warn('[SubConscience] Pattern scan error:', err.message); }
    schedulePatternScan();
  }, 40_000);
}

function scheduleInsightGeneration() {
  setTimeout(async () => {
    try {
      const count = await Memory.count();
      if (count >= 3) {
        // Alternate insight types for variety
        const types = ['general', 'deep', 'question'];
        const type  = types[Math.floor(Date.now() / 180_000) % 3];
        await SubConscience.generateInsight(type);
      }
    } catch (err) { console.warn('[SubConscience] Auto-insight error:', err.message); }
    scheduleInsightGeneration();
  }, 180_000);
}

function startBackgroundTasks() {
  scheduleHeartbeat();
  schedulePatternScan();
  scheduleInsightGeneration();
  console.log('[SubConscience v3] Background tasks started');
}

// ════════════════════════════════════════════════════════════
//  SERVICE WORKER LIFECYCLE
// ════════════════════════════════════════════════════════════
self.addEventListener('install', () => {
  console.log('[SW v3] Installing...');
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  console.log('[SW v3] Activating...');
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SW_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
    await initDB();
    console.log('[SW v3] DB ready');
    startBackgroundTasks();
  })());
});

// ════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ════════════════════════════════════════════════════════════
self.addEventListener('message', async (e) => {
  if (!e.data || !e.ports[0]) return;
  const { type, data = {} } = e.data;
  const port = e.ports[0];

  try {
    await requireDB();
  } catch (err) {
    port.postMessage({ error: 'DB not ready: ' + err.message });
    return;
  }

  try {
    switch (type) {
      case 'set-config':
        if (data.model)     CONFIG.model     = data.model;
        if (data.ollamaUrl) CONFIG.ollamaUrl = data.ollamaUrl;
        if (data.temp)      CONFIG.temp      = data.temp;
        port.postMessage({ success: true, config: CONFIG });
        break;

      case 'store-memory': {
        const id = await Memory.store(data.memoryType || 'generic', data.content || '', data.metadata || {});
        port.postMessage({ success: true, id });
        break;
      }

      case 'get-memories': {
        const mems = await Memory.getRecent(data.type || null, data.limit || 30);
        port.postMessage({ memories: mems });
        break;
      }

      case 'memory-count': {
        const count = await Memory.count();
        port.postMessage({ count });
        break;
      }

      case 'get-stats': {
        const stats = await Memory.getStats();
        port.postMessage({ stats });
        break;
      }

      case 'get-patterns': {
        const pats = await PatternDetector.getPatterns(data.limit || 30);
        port.postMessage({ patterns: pats });
        break;
      }

      case 'get-insights': {
        const ins = await SubConscience.getInsights(data.limit || 15);
        port.postMessage({ insights: ins });
        break;
      }

      case 'generate-insight': {
        const insId = await SubConscience.generateInsight(data.type || 'general');
        port.postMessage({ success: true, insightId: insId });
        break;
      }

      case 'run-pattern-scan': {
        const n = await PatternDetector.detect();
        port.postMessage({ success: true, patternsFound: n });
        break;
      }

      case 'clear-memory': {
        await Memory.clearAll();
        port.postMessage({ success: true });
        break;
      }

      default:
        port.postMessage({ error: `Unknown type: "${type}"` });
    }
  } catch (err) {
    console.error(`[SW v3] Handler error (${type}):`, err.message);
    port.postMessage({ error: err.message });
  }
});
