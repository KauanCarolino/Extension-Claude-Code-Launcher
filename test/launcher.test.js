'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Explicit VS Code adapter: these tests exercise the compiled launcher, not an editor host.
function fixture(options = {}) {
  const commands = new Map(), calls = [], errors = [], messages = [], updates = [], groups = [];
  const settings = new Map(Object.entries(options.settings || {})), memento = new Map(), configurationHandlers = [];
  const changeSetting = (section, key, value, target = 'globalValue') => {
    const full = section + '.' + key;
    settings.set(full, { ...settings.get(full), [target]: value });
    for (const handler of configurationHandlers) handler({ affectsConfiguration: name => name === full || full.startsWith(name + '.') });
  };
  const disposed = [];
  const disposable = () => ({ dispose() { disposed.push(this); } });
  const event = () => disposable();
  let provider, tick = 0;
  class Uri {
    constructor(value) { this.value = value; this.scheme = 'file'; this.fsPath = value; }
    toString() { return this.value; }
    static file(value) { return new Uri(value); }
    static parse(value) { return new Uri(value); }
    static joinPath(base, ...parts) { return new Uri(base.toString() + '/' + parts.join('/')); }
  }
  class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
  const addTab = () => {
    const group = { viewColumn: 1, tabs: [] };
    const tab = { input: new TabInputWebview('claudeVSCodePanel'), label: 'Claude', isActive: true, group };
    group.tabs.push(tab); groups.push(group); return tab;
  };
  if (options.existingTab) addTab();
  const extension = options.missing ? undefined : { isActive: !options.activation,
    activate: options.activation || (async () => {}) };
  const available = options.available ?? ['claude-vscode.editor.open', 'claude-vscode.sidebar.open'];
  const vscode = {
    version: options.version ?? '1.147.0',
    Uri, TabInputWebview, RelativePattern: class {},
    StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1, Workspace: 2 },
    extensions: { getExtension: () => extension, onDidChange: event },
    env: { uriScheme: options.scheme || 'vscode', async openExternal(uri) {
      calls.push(['uri', uri.toString()]);
      if (options.uriResult !== false && options.createTab !== false) addTab();
      return options.uriResult !== false;
    } },
    commands: {
      registerCommand(name, handler) { commands.set(name, handler); return disposable(); },
      getCommands: async () => available,
      async executeCommand(name, ...args) {
        calls.push([name, ...args]);
        if (options.commandError) throw options.commandError;
        if (name === 'claude-vscode.editor.open' && options.createTab !== false) addTab();
      },
    },
    window: {
      registerWebviewViewProvider(_id, value) { provider = value; return disposable(); },
      createStatusBarItem: () => ({ show() {}, ...disposable() }),
      tabGroups: { all: groups, onDidChangeTabs: event, onDidChangeTabGroups: event },
      showErrorMessage: async message => { errors.push(message); },
      showWarningMessage: async message => { errors.push(message); },
      showInformationMessage: async message => { messages.push(message); },
    },
    workspace: {
      workspaceFolders: options.folder ? [{ uri: Uri.file('/fixture') }] : [],
      getConfiguration: section => ({ get: (key, fallback) => {
        const setting = settings.get(section + '.' + key);
        return setting?.workspaceValue ?? setting?.globalValue ?? fallback;
      }, inspect: key => settings.get(section + '.' + key) || {},
        async update(key, value, target) {
          updates.push([section, key, value, target]);
          changeSetting(section, key, value, target === 1 ? 'globalValue' : 'workspaceValue');
        } }),
      createFileSystemWatcher: () => ({ ...disposable(), onDidCreate: event, onDidChange: event, onDidDelete: event }),
      onDidChangeWorkspaceFolders: event,
      onDidChangeConfiguration(handler) { configurationHandlers.push(handler); return disposable(); },
    },
  };
  const source = path.resolve(__dirname, '../out/extension.js'), module = { exports: {} };
  const timers = new Set();
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    module, exports: module.exports, Error, Promise,
    Date: class extends Date { static now() { return tick += 500; } },
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms >= 8000 ? 25 : 0); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    require: id => {
      if (id === 'vscode') return vscode;
      if (id === './changes') return { registerChanges() { return options.changesController; } };
      if (id === './inline') return { registerInline() {} };
      if (id === './skills-view') return { registerSkills() {} };
      if (id === './catalog-view') return { registerCatalogs() {} };
      if (id === './sessions') return { sessionsDir: () => '/fixture/sessions',
        listSessionsAsync: options.listSessions || (async () => ({ sessions: [], partial: false })) };
      return id.startsWith('.') ? require(path.resolve(path.dirname(source), id)) : require(id);
    },
  }, { filename: source });
  const context = { extensionUri: Uri.file('/extension'), subscriptions: [],
    globalState: { get: (key, fallback) => memento.get(key) ?? fallback,
      async update(key, value) { memento.set(key, value); } } };
  module.exports.activate(context);
  const createView = () => {
    const subscriptions = [], published = [];
    let receive, disposeView;
    const subscribe = () => { const value = disposable(); subscriptions.push(value); return value; };
    const view = { visible: true,
      onDidChangeVisibility: subscribe,
      onDidDispose(handler) { disposeView = handler; return subscribe(); },
      webview: { cspSource: 'fixture:', asWebviewUri: uri => uri,
        onDidReceiveMessage(handler) { receive = handler; return subscribe(); },
        async postMessage(message) { published.push(message); return true; } },
    };
    provider.resolveWebviewView(view);
    return { receive: value => receive(value), close: () => disposeView(), published, subscriptions };
  };
  return { calls, errors, messages, updates, disposed, createView, settings, changeSetting,
    command: name => commands.get('claude-code-launcher.' + name)(),
    deactivate: () => module.exports.deactivate(),
    dispose() { module.exports.deactivate(); context.subscriptions.forEach(item => item.dispose()); timers.forEach(clearTimeout); } };
}

test('launcher does not install a missing dependency without the user choosing installation', async t => {
  const f = fixture({ missing: true }); t.after(() => f.dispose());
  await f.command('openTab');
  assert.equal(f.calls.length, 0); assert.equal(f.messages.length, 1); assert.equal(f.updates.length, 0);
});

test('launcher observes a new official tab without modifying unmanaged preferences', async t => {
  const f = fixture(); t.after(() => f.dispose());
  await f.command('openTab');
  assert.equal(f.calls[0][0], 'claude-vscode.editor.open');
  assert.equal(f.errors.length, 0); assert.equal(f.updates.length, 0);
});

test('launcher uses the current editor protocol and handles URI refusal', async t => {
  const f = fixture({ available: [], scheme: 'cursor' }); t.after(() => f.dispose());
  await f.command('openTab');
  assert.deepEqual(f.calls, [['uri', 'cursor://anthropic.claude-code/open']]); assert.equal(f.errors.length, 0);
  const denied = fixture({ available: [], uriResult: false }); t.after(() => denied.dispose());
  await denied.command('openTab');
  assert.match(denied.errors[0], /não aceitou/);
});

test('an existing unchanged tab cannot masquerade as a newly opened conversation', async t => {
  const f = fixture({ existingTab: true, createTab: false }); t.after(() => f.dispose());
  await f.command('openTab');
  assert.match(f.errors[0], /não confirmei uma aba/);
});

test('launcher reports authentication failures and does not route them through another handler', async t => {
  const f = fixture({ commandError: new Error('401 authentication required') }); t.after(() => f.dispose());
  await f.command('openSidebar');
  assert.equal(f.calls.length, 1); assert.match(f.errors[0], /Faça login/);
});

test('launcher reports unsupported sidebar and activation timeout', async t => {
  const unsupported = fixture({ available: [] }); t.after(() => unsupported.dispose());
  await unsupported.command('openSidebar');
  assert.match(unsupported.errors[0], /comando conhecido/); assert.equal(unsupported.calls.length, 0);
  const stalled = fixture({ activation: () => new Promise(() => {}) }); t.after(() => stalled.dispose());
  await stalled.command('openTab');
  assert.match(stalled.errors[0], /terminou de iniciar/); assert.equal(stalled.calls.length, 0);
});

// Comandos medidos com a extensão oficial 2.1.330: o Cursor 3.30 (API 1.128) registra a view
// claudeVSCodeSidebarSecondary, mas não o contêiner claude-sidebar-secondary, e a view vai para o Explorer.
const OFFICIAL = ['claude-vscode.editor.open', 'claude-vscode.sidebar.open', 'claudeVSCodeSidebarSecondary.focus'];
const SECONDARY_CONTAINER = 'workbench.view.extension.claude-sidebar-secondary';

test('where the sidebar view would land in the Explorer, the sidebar action opens a chat tab instead', async t => {
  const f = fixture({ version: '1.128.0', available: OFFICIAL }); t.after(() => f.dispose());
  await f.command('openSidebar');
  assert.deepEqual(f.calls.map(call => call[0]), ['claude-vscode.editor.open']);
  assert.equal(f.errors.length, 0); assert.equal(f.updates.length, 0);
});

test('where the sidebar view would land in the Explorer, the sidebar action focuses an open chat tab', async t => {
  const f = fixture({ version: '1.128.0', available: OFFICIAL, existingTab: true }); t.after(() => f.dispose());
  await f.command('openSidebar');
  assert.deepEqual(f.calls, [['workbench.action.focusFirstEditorGroup'], ['workbench.action.openEditorAtIndex', 0]]);
  assert.equal(f.errors.length, 0);
});

test('the sidebar action keeps the official sidebar where the editor shows it outside the Explorer', async t => {
  // VS Code com o contêiner da barra lateral secundária, e versões anteriores à 1.106, em que a oficial usa a Activity Bar.
  for (const [version, available] of [['1.147.0', [...OFFICIAL, SECONDARY_CONTAINER]], ['1.100.0', OFFICIAL]]) {
    const f = fixture({ version, available }); t.after(() => f.dispose());
    await f.command('openSidebar');
    assert.deepEqual(f.calls.map(call => call[0]), ['claude-vscode.sidebar.open'], version);
  }
});

test('home validates untrusted messages before calling official commands', async t => {
  const f = fixture(); t.after(() => f.dispose()); const view = f.createView();
  for (const value of [null, { command: 'openSession' }, { command: 'openSession', id: {} }, { command: 'unknown' }]) {
    await view.receive(value);
  }
  assert.equal(f.calls.length, 0);
  await view.receive({ command: 'openSession', id: 'fixture-session' });
  assert.deepEqual(f.calls[0], ['claude-vscode.editor.open', 'fixture-session']);
});

test('disposed views release listeners and cannot receive late session results', async t => {
  let finish; const listing = new Promise(resolve => { finish = resolve; });
  const f = fixture({ folder: true, listSessions: () => listing }); t.after(() => f.dispose());
  const view = f.createView(); view.close();
  finish({ sessions: [], partial: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.published.length, 0);
  assert(view.subscriptions.every(item => f.disposed.includes(item)));
  await view.receive({ command: 'newTab' }); assert.equal(f.calls.length, 0);
});

test('session listing failure publishes an explicit partial result without an unhandled rejection', async t => {
  const f = fixture({ folder: true, listSessions: async () => { throw new Error('read failed'); } });
  t.after(() => f.dispose()); const view = f.createView();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(view.published[0].coverageMessage, /não foi possível ler/);
});

test('manual preference change survives the configuration listener and later opt-out', async t => {
  const f = fixture({ settings: {
    'claudeCodeLauncher.manageEditorGroups': { globalValue: true },
    'claudeCode.preferredLocation': { globalValue: 'sidebar' },
  } });
  t.after(() => f.dispose());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.settings.get('claudeCode.preferredLocation').globalValue, 'panel');
  f.changeSetting('claudeCode', 'preferredLocation', 'sidebar');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.settings.get('claudeCode.preferredLocation').globalValue, 'sidebar');
  f.changeSetting('claudeCodeLauncher', 'manageEditorGroups', false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.settings.get('claudeCode.preferredLocation').globalValue, 'sidebar');
  assert.equal(f.updates.filter(([section, key]) => section === 'claudeCode' && key === 'preferredLocation').length, 1);
});

test('already matching preferences are observed without later overriding a human change', async t => {
  const f = fixture({ settings: {
    'claudeCodeLauncher.manageEditorGroups': { globalValue: true },
    'claudeCode.preferredLocation': { globalValue: 'panel' },
  } });
  t.after(() => f.dispose());
  await new Promise(resolve => setImmediate(resolve));
  f.changeSetting('claudeCode', 'preferredLocation', 'sidebar');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.settings.get('claudeCode.preferredLocation').globalValue, 'sidebar');
  assert.equal(f.updates.length, 0);
});

test('deactivate returns the controller disposal so the editor waits for the review lock to be released', async t => {
  let release, disposeCalls = 0;
  const disposal = new Promise(resolve => { release = resolve; });
  const changesController = { dispose() { disposeCalls++; }, whenDisposed: () => disposal };
  const f = fixture({ changesController }); t.after(() => f.dispose());
  const result = f.deactivate();
  assert.equal(disposeCalls, 1); assert.equal(typeof result?.then, 'function');
  let settled = false; result.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(settled, false);
  release(); await result; assert.equal(settled, true);
  // A second deactivation has nothing left to wait for and does not dispose again.
  assert.equal(f.deactivate(), undefined); assert.equal(disposeCalls, 1);
});

test('deactivate without a change controller completes synchronously', t => {
  const f = fixture(); t.after(() => f.dispose());
  assert.equal(f.deactivate(), undefined);
});
