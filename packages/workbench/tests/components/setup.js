import { vi } from 'vitest';

class ResizeObserverStub {
  observe() {}

  unobserve() {}

  disconnect() {}
}

function createDomRect({ height = 0, left = 0, top = 0, width = 0 } = {}) {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON() {
      return { bottom: this.bottom, height, left, right: this.right, top, width, x: left, y: top };
    },
  };
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: ResizeObserverStub,
  writable: true,
});

Object.defineProperty(globalThis.window, 'matchMedia', {
  configurable: true,
  value: vi.fn((media) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    matches: false,
    media,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn(),
  })),
  writable: true,
});

Object.defineProperty(globalThis.window, 'confirm', {
  configurable: true,
  value: vi.fn(() => true),
  writable: true,
});

Object.defineProperty(globalThis.Range.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => createDomRect(),
  writable: true,
});

Object.defineProperty(globalThis.Range.prototype, 'getClientRects', {
  configurable: true,
  value: () => [],
  writable: true,
});

Object.defineProperty(globalThis.HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => createDomRect({ height: 20, width: 800 }),
  writable: true,
});

// Node 26 exposes a disabled host localStorage; give renderer tests a window-local store.
const browserStorage = new Map();
Object.defineProperty(globalThis.window, 'localStorage', {
  configurable: true,
  value: {
    getItem: key => browserStorage.get(String(key)) ?? null,
    setItem: (key, value) => browserStorage.set(String(key), String(value)),
    removeItem: key => browserStorage.delete(String(key)),
    clear: () => browserStorage.clear(),
  },
});
