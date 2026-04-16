// ════════════════════════════════════════════════════════════════════════════
//  ollama-local-ai.js  —  Local AI Integration via Ollama
//
//  Provides zero-dependency, completely local AI inference using Ollama.
//  No cloud calls. No external APIs. No Claude. 100% private.
//
//  Features:
//    • Auto-detect Ollama server (localhost:11434)
//    • Fallback models: llama2, mistral, neural-chat
//    • Streaming responses with progress tracking
//    • Context window management (4K-32K tokens)
//    • Local embedding generation
//    • Function extraction from prompts
//    • Cached model inference
//
//  Usage:
//    import { OllamaAI } from './ollama-local-ai.js';
//    const ai = new OllamaAI({ model: 'mistral' });
//    await ai.init();
//    const response = await ai.prompt('What is the capital of France?');
//    console.log(response);
// ════════════════════════════════════════════════════════════════════════════

// ── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
const DEFAULT_MODEL = 'mistral';
const FALLBACK_MODELS = ['llama2', 'neural-chat', 'orca-mini'];
const DEFAULT_CONTEXT_LENGTH = 4096;
const REQUEST_TIMEOUT_MS = 300000; // 5 minutes for long inference
const HEALTH_CHECK_INTERVAL_MS = 5000;

// ── Prompt Templates ──────────────────────────────────────────────────────────

const SYSTEM_PROMPTS = {
  default: `You are a helpful assistant running locally without internet access.
Provide accurate, concise responses.
Format code in markdown blocks.
Be honest about limitations.`,

  analyst: `You are a data analyst. Analyze events and state changes in the sovereign log.
Look for patterns, anomalies, and correlations.
Provide structured insights with evidence.`,

  validator: `You are a consensus validator reviewing events.
Verify event integrity, check signatures, detect fork proofs.
Reason through Byzantine fault tolerance scenarios.`,

  architect: `You are a system architect reviewing application design.
Analyze scalability, resilience, and security properties.
Suggest improvements and identify bottlenecks.`,

  debugger: `You are a debugger. Given logs and state, find issues.
Trace execution paths. Identify root causes.
Suggest fixes with explanation.`,
};

// ════════════════════════════════════════════════════════════════════════════
//  OllamaAI — Main Class
// ════════════════════════════════════════════════════════════════════════════

export class OllamaAI {
  /**
   * @param {object} opts
   * @param {string} [opts.host]         - Ollama server host (default: localhost:11434)
   * @param {string} [opts.model]        - Model name (default: mistral)
   * @param {number} [opts.contextLen]   - Context window size (default: 4096)
   * @param {string} [opts.systemPrompt] - System prompt type or custom string
   * @param {Function} [opts.onStatus]   - Status callback
   * @param {boolean} [opts.verbose]     - Log all requests
   */
  constructor(opts = {}) {
    this._host = opts.host || DEFAULT_OLLAMA_HOST;
    this._model = opts.model || DEFAULT_MODEL;
    this._contextLen = opts.contextLen || DEFAULT_CONTEXT_LENGTH;
    this._systemPrompt = opts.systemPrompt || 'default';
    this._onStatus = opts.onStatus || (() => {});
    this._verbose = opts.verbose || false;

    this._isReady = false;
    this._availableModels = [];
    this._responseCache = new Map();
    this._healthCheckTimer = null;
    this._requestQueue = [];
    this._inferenceInProgress = false;
  }

  // ── Initialization ────────────────────────────────────────────────────────

  async init() {
    this._log('Initializing Ollama AI...');

    try {
      // 1. Check if Ollama is running
      await this._healthCheck();
      this._log(`✓ Ollama server detected at ${this._host}`);

      // 2. List available models
      this._availableModels = await this._listModels();
      this._log(`✓ Available models: ${this._availableModels.join(', ')}`);

      // 3. Verify requested model is available, fall back if needed
      if (!this._availableModels.includes(this._model)) {
        const fallback = FALLBACK_MODELS.find(m => this._availableModels.includes(m));
        if (fallback) {
          this._log(`⚠ Model '${this._model}' not found, using '${fallback}'`);
          this._model = fallback;
        } else {
          throw new Error(`No suitable models found. Available: ${this._availableModels.join(', ')}`);
        }
      }

      this._isReady = true;
      this._onStatus('initialized', { model: this._model, host: this._host });

      // 4. Start background health checks
      this._startHealthChecks();

      return this;
    } catch (err) {
      this._log(`✗ Initialization failed: ${err.message}`);
      this._onStatus('error', { error: err.message });
      throw err;
    }
  }

  // ── Core API ──────────────────────────────────────────────────────────────

  /**
   * Send a prompt to the local Ollama model.
   * Streams response and returns complete text.
   *
   * @param {string} prompt - The prompt
   * @param {object} opts
   * @param {number} [opts.temperature] - 0.0-1.0 (default 0.7)
   * @param {number} [opts.topK] - nucleus sampling (default 40)
   * @param {number} [opts.topP] - nucleus sampling (default 0.9)
   * @param {string} [opts.systemPrompt] - override system prompt
   * @returns {Promise<string>}
   */
  async prompt(prompt, opts = {}) {
    if (!this._isReady) {
      throw new Error('OllamaAI not initialized. Call init() first.');
    }

    const cacheKey = `${this._model}:${prompt}`;
    if (this._responseCache.has(cacheKey)) {
      this._log(`[cache hit] ${prompt.slice(0, 50)}...`);
      return this._responseCache.get(cacheKey);
    }

    const request = {
      model: this._model,
      prompt,
      system: this._getSystemPrompt(opts.systemPrompt),
      stream: true,
      temperature: opts.temperature ?? 0.7,
      top_k: opts.topK ?? 40,
      top_p: opts.topP ?? 0.9,
      context_length: this._contextLen,
    };

    this._log(`[prompt] ${prompt.slice(0, 60)}...`);

    try {
      const response = await this._inferenceWithQueue(request);
      this._responseCache.set(cacheKey, response);
      return response;
    } catch (err) {
      this._log(`✗ Prompt failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Stream response directly (for real-time processing).
   *
   * @param {string} prompt
   * @param {Function} onChunk - called with each streamed chunk
   * @param {object} opts
   * @returns {Promise<void>}
   */
  async promptStream(prompt, onChunk, opts = {}) {
    if (!this._isReady) {
      throw new Error('OllamaAI not initialized.');
    }

    const request = {
      model: this._model,
      prompt,
      system: this._getSystemPrompt(opts.systemPrompt),
      stream: true,
      temperature: opts.temperature ?? 0.7,
      context_length: this._contextLen,
    };

    return this._streamInference(request, onChunk);
  }

  /**
   * Generate embeddings (vector representation of text).
   *
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async embed(text) {
    if (!this._isReady) {
      throw new Error('OllamaAI not initialized.');
    }

    try {
      const response = await fetch(`${this._host}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this._model,
          prompt: text,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Embedding failed: ${response.statusText}`);
      }

      const data = await response.json();
      return data.embedding || [];
    } catch (err) {
      this._log(`✗ Embedding failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Extract function calls from a prompt response.
   * Looks for patterns like: function_name(arg1, arg2)
   *
   * @param {string} response
   * @returns {Array<{name: string, args: any[]}>}
   */
  extractFunctions(response) {
    const functionPattern = /(\w+)\s*\(\s*([^)]*)\s*\)/g;
    const functions = [];

    let match;
    while ((match = functionPattern.exec(response)) !== null) {
      const name = match[1];
      const argsStr = match[2];

      try {
        const args = argsStr
          .split(',')
          .map(arg => arg.trim())
          .filter(arg => arg.length > 0)
          .map(arg => {
            // Try to parse as JSON or return as string
            try {
              return JSON.parse(arg);
            } catch {
              return arg;
            }
          });

        functions.push({ name, args });
      } catch (_) {
        // Ignore parse errors
      }
    }

    return functions;
  }

  /**
   * Analyze sovereign-log events with the local AI.
   *
   * @param {Array} events - sovereign-log events
   * @param {string} question - what to analyze
   * @returns {Promise<string>}
   */
  async analyzeLog(events, question) {
    const logSummary = events.slice(-50).map(e => ({
      type: e.type,
      seq: e.seq,
      ts: e.ts,
      data: JSON.stringify(e).slice(0, 100),
    }));

    const prompt = `
Analyze these recent events from the sovereign log:

${JSON.stringify(logSummary, null, 2)}

Question: ${question}

Provide structured analysis with evidence from the log.
`;

    return this.prompt(prompt, { systemPrompt: 'analyst' });
  }

  /**
   * Get system status.
   *
   * @returns {object}
   */
  status() {
    return {
      isReady: this._isReady,
      model: this._model,
      host: this._host,
      availableModels: this._availableModels,
      contextLength: this._contextLen,
      cacheSize: this._responseCache.size,
      queueLength: this._requestQueue.length,
      inProgress: this._inferenceInProgress,
    };
  }

  // ── Private Methods ───────────────────────────────────────────────────────

  async _healthCheck() {
    try {
      const response = await fetch(`${this._host}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.statusText}`);
      }
      return true;
    } catch (err) {
      throw new Error(`Ollama server not reachable at ${this._host}: ${err.message}`);
    }
  }

  async _listModels() {
    try {
      const response = await fetch(`${this._host}/api/tags`, {
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      return (data.models || []).map(m => m.name);
    } catch (err) {
      this._log(`⚠ Could not list models: ${err.message}`);
      return [];
    }
  }

  async _inferenceWithQueue(request) {
    // Queue requests to avoid overwhelming the local model
    return new Promise((resolve, reject) => {
      this._requestQueue.push(async () => {
        try {
          const result = await this._runInference(request);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this._inferenceInProgress || this._requestQueue.length === 0) {
      return;
    }

    this._inferenceInProgress = true;
    const request = this._requestQueue.shift();

    try {
      await request();
    } finally {
      this._inferenceInProgress = false;
      this._processQueue();
    }
  }

  async _runInference(request) {
    let fullResponse = '';

    await this._streamInference(request, chunk => {
      fullResponse += chunk;
    });

    return fullResponse;
  }

  async _streamInference(request, onChunk) {
    try {
      const response = await fetch(`${this._host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Inference failed: ${response.statusText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            if (data.response) {
              onChunk(data.response);
            }
          } catch (_) {
            // Skip malformed JSON lines
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('Inference timeout (model taking too long)');
      }
      throw err;
    }
  }

  _getSystemPrompt(override) {
    if (override) {
      return typeof override === 'string' ? override : SYSTEM_PROMPTS[override] || SYSTEM_PROMPTS.default;
    }
    return typeof this._systemPrompt === 'string' && !SYSTEM_PROMPTS[this._systemPrompt]
      ? this._systemPrompt
      : SYSTEM_PROMPTS[this._systemPrompt] || SYSTEM_PROMPTS.default;
  }

  _startHealthChecks() {
    this._healthCheckTimer = setInterval(async () => {
      try {
        await this._healthCheck();
        this._onStatus('healthy', { model: this._model });
      } catch (err) {
        this._onStatus('unhealthy', { error: err.message });
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  _log(msg) {
    if (this._verbose) {
      console.log(`[ollama-local-ai] ${msg}`);
    }
  }

  destroy() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
    }
    this._responseCache.clear();
    this._requestQueue = [];
  }
}

// ── Singleton Instance ────────────────────────────────────────────────────────

let _aiInstance = null;

export async function initializeAI(opts = {}) {
  if (_aiInstance) return _aiInstance;

  _aiInstance = new OllamaAI(opts);
  await _aiInstance.init();
  return _aiInstance;
}

export function getAI() {
  if (!_aiInstance) {
    throw new Error('AI not initialized. Call initializeAI() first.');
  }
  return _aiInstance;
}

export default OllamaAI;
