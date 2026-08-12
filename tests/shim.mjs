/* Minimal DOM/browser shim so the app's modules can be imported and
 * exercised under JavaScriptCore (no browser available in this env). */

function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {}, dataset: {}, children: [], className: '', textContent: '',
    innerText: '', innerHTML: '', offsetHeight: 20, offsetWidth: 100,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (f ? this._s.add(c) : this._s.delete(c)); },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...c) { this.children = c; },
    remove() {},
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    focus() {}, blur() {},
    getContext() {
      return {
        font: '',
        measureText(t) { return { width: String(t).length * 6 }; },
        fillRect() {}, strokeRect() {}, fillStyle: '', strokeStyle: '', lineWidth: 1,
      };
    },
  };
  return el;
}

globalThis.document = {
  body: makeEl('body'),
  createElement: (t) => makeEl(t),
  createElementNS: (ns, t) => makeEl(t),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.window = globalThis;
globalThis.getComputedStyle = () => ({ fontFamily: 'Helvetica' });
globalThis.setTimeout = globalThis.setTimeout || ((f) => f());
globalThis.clearTimeout = globalThis.clearTimeout || (() => {});
globalThis.navigator = { vibrate: null };
globalThis.location = { search: '', protocol: 'http:' };
globalThis.devicePixelRatio = 2;
