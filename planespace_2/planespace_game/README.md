# PlanespaceGame

**A narrative game framework built on Planespace.**

Make games like a flipbook, not a physics engine. Define scenes as layered HTML. Sequence them. Planespace makes them feel spatial. You write the story.

---

## The idea in one sentence

A game is just a sequence of **layered scenes** with **clickable objects** that change **state** and advance the story. That's it.

```
Scene  =  CSS art layers at different depths  +  interactive objects
Story  =  scenes sequenced by player choices
Depth  =  Planespace making it feel 3D
```

---

## Quickstart

```js
import { PlanespaceGame } from './planespace-game.js';

const game = new PlanespaceGame({
  container: document.getElementById('game'),
  maxAngle: 5,
});

game.scene('forest', {
  layers: [
    { z: -400, style: 'background: linear-gradient(#0a1a0a, #050f05)' },
    { z: -200, html: '<div class="trees"></div>' },
    { z:    0, html: '<div class="ground"></div>' },
  ],
  objects: [
    {
      id: 'chest',
      z: 40, x: '60%', y: '68%',
      label: 'Open chest',
      html: '<div class="chest">📦</div>',
      action: 'openChest',
    },
  ],
  onEnter: async (state, { say }) => {
    await say([{ text: 'The forest is quiet. Too quiet.' }]);
  },
});

game.action('openChest', async (state, { say, go }) => {
  state.set('hasKey', true);
  await say([
    { speaker: 'You', text: 'A key. This must open the gate.' },
  ]);
  go('gate');
});

game.start('forest');
```

---

## Scene definition

```js
game.scene('myScene', {
  // Depth layers — pure HTML/CSS art
  layers: [
    {
      z: -400,                      // Z depth (more negative = farther back)
      style: 'background: #0a0a10', // inline CSS on the layer div
      html: '<div>...</div>',       // HTML content
      className: 'my-layer',        // CSS class
    },
  ],

  // Interactive objects
  objects: [
    {
      id: 'door',          // optional, used for DOM id
      z: 30,               // Z depth
      x: '40%', y: '65%', // position (% or px, relative to scene)
      label: 'Enter room', // hover tooltip
      html: '<div class="door"></div>',
      style: 'width: 60px; height: 100px;',

      // Action: string name or inline function
      action: 'enterRoom',
      // action: (state, { go, say, choice }) => { ... }

      // Conditional visibility
      condition: (state) => state.get('doorUnlocked') === true,
    },
  ],

  // Called after scene loads and fades in
  onEnter: async (state, api) => {
    await api.say([{ text: 'You step through the door.' }]);
  },

  // Called before scene transitions away
  onExit: async (state, api) => { ... },
});
```

---

## Action handlers

```js
game.action('myAction', async (state, api) => {
  const { go, say, choice, flash, state: s, reload } = api;

  // Navigate to a scene
  go('sceneName');

  // Show dialogue
  await say([
    { speaker: 'Detective', text: 'Something happened here.' },
    { text: 'No speaker = narration.' },
  ]);

  // Show a choice menu
  const answer = await choice('What do you do?', [
    { text: 'Search the room', value: 'search' },
    { text: 'Leave',           value: 'leave' },
  ]);
  if (answer === 'search') go('room-searched');

  // Flash the screen (color, duration in ms)
  await flash('#ff4444', 100); // red flash

  // State
  state.set('key', 'value');
  state.get('key');
  state.has('key');
  state.toggle('flag');

  // Reload current scene (after state change affects visible objects)
  reload();
});
```

---

## Constructor options

```js
new PlanespaceGame({
  container:    document.getElementById('game'), // mount point
  maxAngle:     5,       // parallax tilt in degrees
  lerpFactor:   0.055,   // camera smoothing
  perspective:  1100,    // CSS perspective depth
  cursorColor:  '#c9a84c', // custom cursor color (false to disable)
  theme: {               // dialogue box styling
    bg:         'rgba(6,4,12,0.93)',
    border:     'rgba(255,255,255,0.1)',
    nameColor:  '#c9a84c',
    textColor:  '#e0d8c4',
    fontSize:   '1.08rem',
    fontFamily: '"Crimson Text", Georgia, serif',
    monoFont:   '"JetBrains Mono", monospace',
  },
});
```

---

## What you can build

| Genre | Notes |
|---|---|
| Point & click adventure | Examine objects, collect items, sequence scenes |
| Visual novel | Dialogue trees, character portraits as layers |
| Horror / atmosphere | Layered fog, flicker effects, sound design |
| Puzzle game | State-conditional object visibility |
| Interactive poem | Pure atmosphere, minimal interaction |
| Side-scrolling narrative | Scenes as "rooms" player moves between |

---

## Design philosophy

You are not simulating a world. You are **authoring an experience**.

- **Scenes are pages.** Write them in HTML and CSS.
- **Depth is free.** Add `z` values and Planespace handles the parallax.
- **State is a dictionary.** No complex data structures needed.
- **Dialogue is async.** `await say([...])` — the game waits for the player.

The engine handles: parallax rendering, scene transitions, dialogue box, custom cursor, conditional objects.

You handle: the art, the story, the logic.

---

## Demo

See `demo/the-last-transmission.html` for a complete 4-scene noir mystery game.

---

## License

MIT
