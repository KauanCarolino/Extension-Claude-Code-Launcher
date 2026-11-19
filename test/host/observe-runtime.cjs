'use strict';

// Observational adapter: calls reach the real editor/filesystem. No operation is
// stubbed, delayed or made successful by the observer. Only owned resources count.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

exports.observeRuntime = function observeRuntime(vscode, directory) {
  const live = new Map(); const timers = new Map(); const modules = new Map();
  const io = {}; const posts = []; let disposed = false; let serial = 0;
  const count = key => { io[key] = (io[key] || 0) + 1; };
  function tracked(value, kind, overrides = {}, parent) {
    const id = ++serial; live.set(id, { kind, parent });
    const release = () => { live.delete(id); for (const [child, info] of live) if (info.parent === id) live.delete(child); };
    return new Proxy(value, { get(target, key) {
      if (key === 'dispose') return () => { try { target.dispose(); } finally { release(); } };
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const item = Reflect.get(target, key, target);
      if (typeof item === 'function' && typeof key === 'string' && key.startsWith('onDid')) {
        return (...args) => tracked(item.apply(target, args), 'listener', {}, id);
      }
      return typeof item === 'function' ? item.bind(target) : item;
    }, set(target, key, value) { return Reflect.set(target, key, value, target); } });
  }
  function namespace(original, label) {
    // Enumerating values would evaluate unrelated getters for proposed APIs.
    // Resolve only the stable members actually requested by production code.
    return new Proxy({}, { get(overrides, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value = Reflect.get(original, key, original);
      if (typeof value === 'function' && typeof key === 'string' && key.startsWith('onDid')) return (...args) => tracked(value.apply(original, args), 'listener:' + label + '.' + key);
      return typeof value === 'function' ? value.bind(original) : value;
    }, set(target, key, value) { return Reflect.set(target, key, value, target); } });
  }
  const workspace = namespace(vscode.workspace, 'workspace');
  workspace.createFileSystemWatcher = (...args) => tracked(vscode.workspace.createFileSystemWatcher(...args), 'watcher');
  const window = namespace(vscode.window, 'window');
  window.createStatusBarItem = (...args) => tracked(vscode.window.createStatusBarItem(...args), 'statusbar');
  window.createWebviewPanel = (...args) => {
    const panel = vscode.window.createWebviewPanel(...args);
    let wrapper; let panelId; let closed = false;
    const webview = new Proxy(panel.webview, { get(target, key) {
      if (key === 'postMessage') return message => { posts.push({ afterDispose: disposed, afterViewClosed: closed, type: typeof message?.type === 'string' ? message.type : 'unknown' }); return target.postMessage(message); };
      if (key === 'onDidReceiveMessage') return (...values) => tracked(target.onDidReceiveMessage(...values), 'webview-listener', {}, panelId);
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    }, set(target, key, value) { return Reflect.set(target, key, value, target); } });
    wrapper = tracked(panel, 'panel', { webview });
    // A panel owns its event listeners; mark that ownership on actual disposal.
    const panelIds = [...live.keys()]; panelId = panelIds[panelIds.length - 1];
    const observer = panel.onDidDispose(() => { closed = true; live.delete(panelId); for (const [id, info] of live) if (info.parent === panelId) live.delete(id); observer.dispose(); });
    return wrapper;
  };
  class ObservedEmitter extends vscode.EventEmitter {
    constructor() { super(); return tracked(this, 'emitter'); }
  }
  const api = Object.create(vscode);
  Object.defineProperties(api, { workspace: { value: workspace }, window: { value: window }, EventEmitter: { value: ObservedEmitter } });
  function fsProxy(original, prefix) {
    return new Proxy(original, { get(target, key) {
      if (key === 'promises') return promises;
      const value = target[key]; if (typeof value !== 'function' || /^[A-Z]/.test(String(key))) return value;
      return (...args) => { count(prefix + '.' + String(key)); const result = value.apply(target, args);
        if (key === 'open' && prefix === 'fs.promises') return result.then(handle => new Proxy(handle, { get(h, name) {
          const member = Reflect.get(h, name, h); return typeof member === 'function' ? (...values) => { count('handle.' + String(name)); return member.apply(h, values); } : member;
        } }));
        return result;
      };
    } });
  }
  const promises = fsProxy(fs.promises, 'fs.promises'); const filesystem = fsProxy(fs, 'fs');
  function wrapView(view) {
    let closed = false;
    const observation = view.onDidDispose(() => { closed = true; observation.dispose(); });
    const webview = new Proxy(view.webview, { get(target, key) {
      if (key === 'postMessage') return message => { posts.push({ afterDispose: disposed, afterViewClosed: closed, type: typeof message?.type === 'string' ? message.type : 'unknown' }); return target.postMessage(message); };
      if (key === 'onDidReceiveMessage') return (...args) => tracked(target.onDidReceiveMessage(...args), 'home-message-listener');
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    }, set(target, key, value) { return Reflect.set(target, key, value, target); } });
    const wrapped = namespace(view, 'home-view');
    wrapped.webview = webview;
    return { view: wrapped, disposeObservation: () => observation.dispose() };
  }
  function load(filename, exposeHomeProvider = false) {
    filename = path.resolve(filename); if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module); const nativeRequire = createRequire(filename);
    const requireObserved = name => {
      if (name === 'vscode') return api;
      if (['fs', 'node:fs'].includes(name)) return filesystem;
      if (['fs/promises', 'node:fs/promises'].includes(name)) return promises;
      if (name.startsWith('.')) { const resolved = nativeRequire.resolve(name); if (resolved.startsWith(directory + path.sep) && resolved.endsWith('.js')) return load(resolved); }
      return nativeRequire(name);
    };
    const schedule = (repeat, fn, delay, ...args) => {
      const handle = (repeat ? setInterval : setTimeout)(() => { if (!repeat) timers.delete(handle); fn(...args); }, delay);
      timers.set(handle, repeat ? 'interval' : 'timeout'); return handle;
    };
    const cancel = handle => { timers.delete(handle); clearTimeout(handle); clearInterval(handle); };
    const exposure = exposeHomeProvider ? '\nmodule.exports.__testHomeProvider = LauncherViewProvider;\n' : '';
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + exposure, { module, exports: module.exports, require: requireObserved,
      __filename: filename, __dirname: path.dirname(filename), process, Buffer, console, URL, TextEncoder, TextDecoder,
      setTimeout: (fn, ms, ...args) => schedule(false, fn, ms, ...args), clearTimeout: cancel,
      setInterval: (fn, ms, ...args) => schedule(true, fn, ms, ...args), clearInterval: cancel,
      setImmediate, clearImmediate, queueMicrotask }, { filename });
    return module.exports;
  }
  return { load, wrapView, io, posts, markDisposed() { disposed = true; }, snapshot() {
    const resources = {}; for (const { kind } of live.values()) resources[kind] = (resources[kind] || 0) + 1;
    return { resources, timers: timers.size, total: live.size + timers.size, latePosts: posts.filter(item => item.afterDispose || item.afterViewClosed).length };
  } };
};
