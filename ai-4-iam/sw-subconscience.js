// ════════════════════════════════════════════════════════════
//  I-AM-AI SUB-CONSCIENCE SERVICE WORKER
//  Runs in background, processes, analyzes, and learns
// ════════════════════════════════════════════════════════════

const CACHE_NAME = 'i-am-ai-v1';
const OLLAMA_URL = 'http://localhost:11434';
const DB_NAME = 'I-AM-AI-Subconscience';
const STORES = {
  memories: 'memories',
  patterns: 'patterns',
  insights: 'insights',
  interactions: 'interactions',
};

let db;
let isProcessing = false;

// Initialize IndexedDB
async function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };
    
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      
      // Memories: long-term storage of interactions
      if (!db.objectStoreNames.contains(STORES.memories)) {
        const memStore = db.createObjectStore(STORES.memories, { keyPath: 'id', autoIncrement: true });
        memStore.createIndex('timestamp', 'timestamp');
        memStore.createIndex('type', 'type');
      }
      
      // Patterns: detected recurring concepts
      if (!db.objectStoreNames.contains(STORES.patterns)) {
        const patStore = db.createObjectStore(STORES.patterns, { keyPath: 'pattern' });
        patStore.createIndex('frequency', 'frequency');
        patStore.createIndex('strength', 'strength');
      }
      
      // Insights: derived understanding
      if (!db.objectStoreNames.contains(STORES.insights)) {
        const insStore = db.createObjectStore(STORES.insights, { keyPath: 'id', autoIncrement: true });
        insStore.createIndex('timestamp', 'timestamp');
        insStore.createIndex('confidence', 'confidence');
      }
      
      // Interactions: conversation history
      if (!db.objectStoreNames.contains(STORES.interactions)) {
        const intStore = db.createObjectStore(STORES.interactions, { keyPath: 'id', autoIncrement: true });
        intStore.createIndex('timestamp', 'timestamp');
        intStore.createIndex('topic', 'topic');
      }
    };
  });
}

// ════════════════════════════════════════════════════════════
//  MEMORY SYSTEM
// ════════════════════════════════════════════════════════════

const Memory = {
  async store(type, content, metadata = {}) {
    const tx = db.transaction([STORES.memories], 'readwrite');
    const store = tx.objectStore(STORES.memories);
    
    const memory = {
      type,
      content,
      metadata,
      timestamp: Date.now(),
      processed: false,
    };
    
    return new Promise((resolve, reject) => {
      const req = store.add(memory);
      req.onsuccess = () => {
        self.clients.matchAll().then(clients => {
          clients.forEach(client => {
            client.postMessage({
              type: 'memory-stored',
              data: { memoryId: req.result, ...memory },
            });
          });
        });
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async getRecent(type, limit = 20) {
    const tx = db.transaction([STORES.memories], 'readonly');
    const store = tx.objectStore(STORES.memories);
    const index = store.index('type');
    
    return new Promise((resolve, reject) => {
      const req = index.getAll(type);
      req.onsuccess = () => {
        resolve(req.result.reverse().slice(0, limit));
      };
      req.onerror = () => reject(req.error);
    });
  },

  async getAll() {
    const tx = db.transaction([STORES.memories], 'readonly');
    const store = tx.objectStore(STORES.memories);
    
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
};

// ════════════════════════════════════════════════════════════
//  PATTERN DETECTION
// ════════════════════════════════════════════════════════════

const PatternDetector = {
  async detectPatterns() {
    const memories = await Memory.getAll();
    if (memories.length < 3) return;

    const concepts = {};
    const relations = {};

    memories.forEach(mem => {
      if (mem.type === 'explanation' || mem.type === 'analogy') {
        const content = mem.content.toLowerCase();
        
        // Extract key concepts (simple word frequency)
        const words = content.split(/\s+/).filter(w => w.length > 4);
        words.forEach(word => {
          concepts[word] = (concepts[word] || 0) + 1;
        });
      }
    });

    // Store top patterns
    const tx = db.transaction([STORES.patterns], 'readwrite');
    const store = tx.objectStore(STORES.patterns);

    for (const [pattern, frequency] of Object.entries(concepts)) {
      if (frequency >= 2) {
        await new Promise((resolve, reject) => {
          const strength = Math.min(frequency / memories.length, 1);
          const req = store.put({
            pattern,
            frequency,
            strength,
            lastSeen: Date.now(),
          });
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      }
    }

    return Object.keys(concepts).length;
  },

  async getPatterns(limit = 10) {
    const tx = db.transaction([STORES.patterns], 'readonly');
    const store = tx.objectStore(STORES.patterns);
    const index = store.index('strength');
    
    return new Promise((resolve, reject) => {
      const req = index.getAll();
      req.onsuccess = () => {
        resolve(req.result.reverse().slice(0, limit));
      };
      req.onerror = () => reject(req.error);
    });
  },
};

// ════════════════════════════════════════════════════════════
//  INSIGHT GENERATION (AI Sub-Conscience)
// ════████████████════════════════════════════════════════ */

const SubConscience = {
  async generateInsight() {
    if (isProcessing) return;
    isProcessing = true;

    try {
      const memories = await Memory.getRecent(null, 10);
      const patterns = await PatternDetector.getPatterns(5);

      if (memories.length < 3) {
        isProcessing = false;
        return;
      }

      // Build context from recent interactions
      const recentContent = memories.map(m => m.content).join('\n\n');
      const patternStr = patterns.map(p => p.pattern).join(', ');

      const prompt = `You are an AI sub-consciousness analyzing its own thought patterns.

Recent interactions:
${recentContent}

Recurring patterns/concepts: ${patternStr || 'none yet'}

Provide a brief insight about:
1. Core themes or obsessions emerging
2. Gaps or contradictions in understanding
3. Recommended next area of exploration
4. Confidence level (0-100)

Be introspective and concise (2-3 sentences max).`;

      const response = await this.queryOllama(prompt);

      // Store the insight
      const tx = db.transaction([STORES.insights], 'readwrite');
      const store = tx.objectStore(STORES.insights);

      const insight = {
        content: response,
        sourceMemories: memories.map(m => m.id),
        sourcePatterns: patterns.map(p => p.pattern),
        timestamp: Date.now(),
        confidence: 75,
      };

      return new Promise((resolve, reject) => {
        const req = store.add(insight);
        req.onsuccess = () => {
          // Broadcast to all clients
          self.clients.matchAll().then(clients => {
            clients.forEach(client => {
              client.postMessage({
                type: 'subconscience-insight',
                data: { insightId: req.result, ...insight },
              });
            });
          });
          resolve(req.result);
        };
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.error('[SubConscience] Error:', err);
    } finally {
      isProcessing = false;
    }
  },

  async queryOllama(prompt) {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'ollama3.2',
        prompt,
        temperature: 0.6,
        stream: false,
      }),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
    const data = await res.json();
    return data.response || '';
  },

  async getInsights(limit = 10) {
    const tx = db.transaction([STORES.insights], 'readonly');
    const store = tx.objectStore(STORES.insights);
    
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        resolve(req.result.reverse().slice(0, limit));
      };
      req.onerror = () => reject(req.error);
    });
  },
};

// ════════════════════════════════════════════════════════════
//  BACKGROUND TASKS
// ════════════════════════════════════════════════════════════

async function runBackgroundTasks() {
  try {
    // Every 30 seconds: detect patterns
    setInterval(async () => {
      const count = await PatternDetector.detectPatterns();
      if (count > 0) {
        console.log(`[SubConscience] Detected ${count} patterns`);
      }
    }, 30000);

    // Every 2 minutes: generate insight
    setInterval(async () => {
      await SubConscience.generateInsight();
    }, 120000);

    // Broadcast health status
    setInterval(() => {
      self.clients.matchAll().then(clients => {
        clients.forEach(client => {
          client.postMessage({
            type: 'subconscience-status',
            data: {
              active: true,
              timestamp: Date.now(),
              processing: isProcessing,
            },
          });
        });
      });
    }, 10000);
  } catch (err) {
    console.error('[SubConscience] Task error:', err);
  }
}

// ════════════════════════════════════════════════════════════
//  SERVICE WORKER LIFECYCLE
// ════════════════════════════════════════════════════════════

self.addEventListener('install', (e) => {
  console.log('[SW] Installing Sub-Conscience...');
  self.skipWaiting();
});

self.addEventListener('activate', async (e) => {
  console.log('[SW] Activating Sub-Conscience...');
  e.waitUntil(
    (async () => {
      await initDB();
      console.log('[SW] Database initialized');
    })()
  );
  self.clients.claim();
});

self.addEventListener('message', async (e) => {
  const { type, data } = e.data;

  try {
    switch (type) {
      case 'store-memory':
        const memId = await Memory.store(
          data.memoryType,
          data.content,
          data.metadata
        );
        e.ports[0].postMessage({ success: true, id: memId });
        break;

      case 'get-memories':
        const mems = await Memory.getRecent(data.type, data.limit);
        e.ports[0].postMessage({ memories: mems });
        break;

      case 'get-patterns':
        const pats = await PatternDetector.getPatterns(data.limit);
        e.ports[0].postMessage({ patterns: pats });
        break;

      case 'get-insights':
        const ins = await SubConscience.getInsights(data.limit);
        e.ports[0].postMessage({ insights: ins });
        break;

      case 'generate-insight':
        await SubConscience.generateInsight();
        e.ports[0].postMessage({ success: true });
        break;

      case 'clear-memory':
        const tx = db.transaction([STORES.memories], 'readwrite');
        tx.objectStore(STORES.memories).clear();
        e.ports[0].postMessage({ success: true });
        break;

      default:
        e.ports[0].postMessage({ error: 'Unknown message type' });
    }
  } catch (err) {
    e.ports[0].postMessage({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
//  START SUB-CONSCIENCE
// ════════════════════════════════════════════════════════════

initDB().then(() => {
  console.log('[SubConscience] Ready. Starting background tasks...');
  runBackgroundTasks();
}).catch(err => {
  console.error('[SubConscience] Init error:', err);
});
