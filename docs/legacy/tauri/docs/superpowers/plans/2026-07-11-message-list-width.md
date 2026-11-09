# Message List Width Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let incoming and outgoing messages use 92% of the message pane while preserving left/right direction alignment.

**Architecture:** Keep the existing message DOM and direction classes. Change only the shared message CSS contract so rows use 92%, bubbles fill their row, headers wrap, and outgoing headers align right.

**Tech Stack:** Vue 3, CSS, Node test runner

---

### Task 1: Add the layout contract test

**Files:**
- Create: `tests/messageWidth.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');

test('message rows use 92 percent width while preserving directional alignment', () => {
  assert.match(css, /\.chat-msg\s*\{[^}]*width:\s*92%;[^}]*max-width:\s*92%;/s);
  assert.match(css, /\.chat-msg__bubble\s*\{[^}]*width:\s*100%;[^}]*box-sizing:\s*border-box;/s);
  assert.match(css, /\.chat-msg__header\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(css, /\.chat-msg--out \.chat-msg__header\s*\{[^}]*justify-content:\s*flex-end;/s);
});
```

- [ ] **Step 2: Run `node --test tests/messageWidth.test.js` and verify it fails on the old 75% rule**

### Task 2: Apply the shared message width rules

**Files:**
- Modify: `src/styles/base.css`

- [ ] **Step 1: Replace the row width and add wrapping rules**

```css
.chat-msg {
  width: 92%;
  max-width: 92%;
  box-sizing: border-box;
}

.chat-msg__header {
  flex-wrap: wrap;
}

.chat-msg--out .chat-msg__header {
  justify-content: flex-end;
}

.chat-msg__topic {
  min-width: 0;
  overflow-wrap: anywhere;
}

.chat-msg__bubble {
  width: 100%;
  box-sizing: border-box;
}
```

- [ ] **Step 2: Run the focused test and verify it passes**

### Task 3: Verify the application

**Files:**
- Verify: `src/styles/base.css`
- Verify: `tests/messageWidth.test.js`

- [ ] **Step 1: Run `npm test`**
- [ ] **Step 2: Run `npm run build`**
- [ ] **Step 3: Start the desktop client and visually verify incoming messages leave right-side space and outgoing messages leave left-side space**

The project is not a Git repository, so no commit step is available.
