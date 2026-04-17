# I-AM-AI: Ollama3.2 + Sub-Conscience Service Worker

## 🚀 Quick Start

### Step 1: Install Ollama3.2
```bash
# Download Ollama from https://ollama.ai
# Then pull the model:
ollama pull ollama3.2

# Start the server (port 11434)
ollama serve
```

### Step 2: Open Files Properly
1. Create a local folder: `/path/to/i-am-ai/`
2. Place both files there:
   - `I-AM-AI-OLLAMA3.html`
   - `sw-subconscience.js`
3. Run a local server (required for Service Workers):
   ```bash
   # Using Python:
   python -m http.server 8000
   
   # Or using Node.js:
   npx http-server
   ```
4. Open: `http://localhost:8000/I-AM-AI-OLLAMA3.html`

---

## 🧠 Architecture

### Main Thread (HTML)
- UI for explanations, analogies, deep dives
- Concept builder for manual analogy creation
- Stats dashboard
- Communication hub with Service Worker

### Service Worker (sw-subconscience.js)
The "sub-conscience" - runs in background:
- **Memory System** - IndexedDB stores all interactions
- **Pattern Detection** - Finds recurring concepts
- **Insight Generation** - Uses Ollama3.2 to derive understanding
- **Long-term Learning** - Continuously improves

---

## 🎯 Features

### 1. **Explain Tab**
- **Explain** - Clear definitions + examples
- **Analogy** - Generates structural metaphors
- **Deep Dive** - Historical, research, future directions

All explanations are automatically stored in the sub-conscience's memory.

### 2. **Sub-Conscience Tab**
The AI's background self-reflection:
- **Generate Insight Now** - Triggers immediate insight generation
- **Refresh Insights** - Shows stored insights from memory
- **Show Patterns** - Displays recurring concepts the AI noticed

**How it works:**
1. Every explanation/analogy is stored as a "memory"
2. Service Worker runs pattern detection (every 30 seconds)
3. Service Worker generates insights (every 2 minutes)
4. Insights appear as glowing violet boxes with reasoning
5. Shows confidence level and source references

### 3. **Builder Tab**
Manual analogy creation:
- Add structured concept relationships (A—[relation]→B in Domain)
- Solve A:B :: C:? analogies using local graph
- Persistent history stored in localStorage

### 4. **Stats Tab**
Real-time metrics:
- Ollama connection status
- Sub-Conscience active/idle status
- Memory count
- Insights generated
- Patterns detected
- Concepts added

---

## 🔧 How Sub-Conscience Works

### IndexedDB Stores

**memories**
```
{
  id: auto,
  type: 'explanation' | 'analogy' | 'interaction',
  content: string,
  metadata: { topic, timestamp, ... },
  timestamp: milliseconds,
  processed: boolean
}
```

**patterns**
```
{
  pattern: string (concept word),
  frequency: number,
  strength: 0-1 (frequency / total_memories),
  lastSeen: timestamp
}
```

**insights**
```
{
  id: auto,
  content: string (AI-generated insight),
  sourceMemories: [id, id, ...],
  sourcePatterns: [word, word, ...],
  timestamp: milliseconds,
  confidence: 0-100
}
```

### Background Tasks

1. **Every 30 seconds** - Pattern Detection
   - Extracts common words from memories
   - Tracks frequency & strength
   - Stores in patterns store

2. **Every 2 minutes** - Insight Generation
   - Takes last 10 memories
   - Gets top 5 patterns
   - Sends to Ollama3.2 with context
   - Generates new insight
   - Broadcasts to main thread

3. **Every 10 seconds** - Health Status
   - Tells main thread if processing/active
   - UI updates status dot color

---

## 📊 Message Flow

### Main Thread → Service Worker
```javascript
// Store memory
await sendToSW('store-memory', {
  memoryType: 'explanation',
  content: 'The concept explanation',
  metadata: { topic: 'Photosynthesis' }
});

// Get memories
const { memories } = await sendToSW('get-memories', { 
  type: 'explanation', 
  limit: 20 
});

// Get patterns
const { patterns } = await sendToSW('get-patterns', { limit: 10 });

// Get insights
const { insights } = await sendToSW('get-insights', { limit: 10 });

// Trigger insight generation
await sendToSW('generate-insight', {});
```

### Service Worker → Main Thread (Broadcasts)
```javascript
// When insight generated
client.postMessage({
  type: 'subconscience-insight',
  data: { insightId, content, confidence, ... }
});

// Status updates
client.postMessage({
  type: 'subconscience-status',
  data: { active: true, processing: false, timestamp }
});

// Memory stored
client.postMessage({
  type: 'memory-stored',
  data: { memoryId, type, content, ... }
});
```

---

## 🎨 Status Indicators

**Header dots:**
- 🟢 **GREEN** - Online/Active (pulsing)
- 🟡 **ORANGE** - Warning
- 🟣 **VIOLET** - Busy/Processing (pulsing)
- 🔴 **RED** - Offline/Dead

**Toast notifications:**
- ✓ Green = success
- ✗ Red = error
- ℹ️ Cyan = info
- 🧠 Violet = insight

---

## 💾 Data Persistence

### Automatic Storage
- **IndexedDB** - Service Worker memories (permanent across sessions)
- **localStorage** - Concept analogies (manual additions)
- **sessionStorage** - Transient settings

### Export Data
To backup your sub-conscience:
```javascript
// In browser console:
const tx = db.transaction(['memories', 'patterns', 'insights'], 'readonly');
const all = {};
Object.keys(tx.objectStoreNames).forEach(store => {
  all[store] = tx.objectStore(store).getAll();
});
```

---

## 🚨 Troubleshooting

### Service Worker Not Registering
- Must be served over HTTP (localhost:8000)
- Not file:// protocol
- Check browser console for errors

### Ollama Connection Fails
- Ensure Ollama is running: `ollama serve`
- Default URL is `http://localhost:11434`
- Check firewall

### Sub-Conscience Not Generating Insights
- Enable it with the button (goes purple)
- Ensure you've created some memories (explanations)
- Wait 2+ minutes for first insight
- Check browser console for errors

### Service Worker Not Receiving Messages
- Make sure HTTPS or localhost
- Check that sw-subconscience.js is in same folder
- Reload page if registration fails

---

## 🎓 Advanced Usage

### Custom Ollama Models
The system is hardcoded for `ollama3.2`. To use others:

In `I-AM-AI-OLLAMA3.html`, find:
```javascript
const Ollama = {
  async generate(prompt) {
    // Change 'ollama3.2' to your model:
    body: JSON.stringify({
      model: 'mistral',  // or 'neural-chat', 'llama2', etc.
      // ...
    })
  }
}
```

In `sw-subconscience.js`, find:
```javascript
async queryOllama(prompt) {
  // Change 'ollama3.2' here too:
  body: JSON.stringify({
    model: 'ollama3.2',
    // ...
  })
}
```

### Adjusting Insight Frequency
In `sw-subconscience.js`, find `runBackgroundTasks()`:
```javascript
// Every 2 minutes (120000ms) - change to 60000 for every minute:
setInterval(async () => {
  await SubConscience.generateInsight();
}, 120000);
```

### Clearing Sub-Conscience Memory
In browser DevTools console:
```javascript
// Clear all memories
const tx = db.transaction(['memories', 'patterns', 'insights'], 'readwrite');
['memories', 'patterns', 'insights'].forEach(store => {
  tx.objectStore(store).clear();
});
```

---

## 🔬 Example Workflow

1. **Enable Ollama**
   - Click "Test Ollama3.2"
   - See green dot in header

2. **Enable Sub-Conscience**
   - Click "Enable Sub-Conscience"
   - See purple dot

3. **Generate Content**
   - Go to Explain tab
   - Enter: "What is emergence?"
   - Click "Explain"
   - Memory stored automatically

4. **Wait for Sub-Conscience**
   - After 2+ minutes
   - Get notification: "🧠 Sub-conscience generated insight!"
   - Go to Sub-Conscience tab
   - See insight in violet box

5. **Explore Patterns**
   - Click "Show Patterns"
   - See recurring concepts detected
   - Shows frequency + strength

6. **Build Analogies**
   - Go to Builder tab
   - Add: Emergence —[requires]→ Agents in Systems
   - Solve: Ant:Anthill :: Brain:?

---

## 📚 What Gets Stored

### By Service Worker
- Every explanation you generate
- Every analogy you ask for
- Deep dive responses
- Metadata about topics

### Pattern Detection
- Word frequency analysis
- Concept co-occurrence
- Strength calculation

### Insights
- AI-generated understanding
- Connections between topics
- Gaps and recommendations
- Confidence scoring

---

## 🎯 Philosophy

**I-AM-AI** is a knowledge exploration tool where:
1. **You** explore concepts actively (main thread)
2. **The Sub-Conscience** learns passively (Service Worker)
3. **Analogies** map understanding across domains
4. **Insights** emerge from patterns
5. **Everything** stays local (Ollama on your machine)

The Service Worker is your AI co-thinker - always processing, finding patterns, generating understanding even when you're not directly interacting.

---

## 📝 License & Credits
Built for local AI exploration. No API keys, no telemetry, no cloud dependency.
Runs entirely on your machine with Ollama3.2.

Enjoy your journey of discovery! 🚀✨
