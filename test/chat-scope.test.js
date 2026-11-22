// O painel Mudanças por conversa, de ponta a ponta: extension.js decide a conversa em foco a partir das
// abas e dos transcripts, e o ChangesController real filtra. Só o editor é simulado.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture, entry, writeLog, OUT } = require('./helpers/changes-fixture.cjs');

// Rótulo que o webview oficial (2.1.329) põe na aba: no máximo 25 caracteres, 24 + "…" acima disso.
const officialTabLabel = (summary) => !summary ? 'Claude Code' : summary.length > 25 ? summary.substring(0, 24) + '…' : summary;

function launcher(t, { tabs, sessions }) {
  const chats = [], tabHandlers = [], transcriptHandlers = [];
  let listing = sessions;
  class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
  const group = { viewColumn: 1, tabs: [] };
  const setTabs = (list) => {
    group.tabs.splice(0, group.tabs.length, ...list.map((item) => ({ input: new TabInputWebview(item.viewType || 'claudeVSCodePanel'), label: item.label, isActive: Boolean(item.active), group })));
  };
  setTabs(tabs);
  const disposable = () => ({ dispose() {} });
  const vscode = {
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file', toString: () => p }), joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join('/') }) },
    TabInputWebview, TabInputText: class {}, RelativePattern: class {}, StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1, Workspace: 2 },
    extensions: { getExtension: () => ({ isActive: true }), onDidChange: disposable },
    env: { uriScheme: 'vscode' },
    commands: { registerCommand: disposable, getCommands: async () => [], executeCommand: async () => undefined },
    window: {
      registerWebviewViewProvider: disposable, createStatusBarItem: () => ({ show() {}, dispose() {} }),
      tabGroups: { all: [group], get activeTabGroup() { return { activeTab: group.tabs.find((tab) => tab.isActive) }; },
        onDidChangeTabs: (handler) => { tabHandlers.push(handler); return disposable(); }, onDidChangeTabGroups: disposable },
      showWarningMessage: async () => undefined, showErrorMessage: async () => undefined, showInformationMessage: async () => undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/fixture', scheme: 'file' } }],
      getConfiguration: () => ({ get: (_key, fallback) => fallback, inspect: () => ({}), update: async () => {} }),
      createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: (h) => { transcriptHandlers.push(h); return disposable(); },
        onDidChange: (h) => { transcriptHandlers.push(h); return disposable(); }, onDidDelete: disposable }),
      onDidChangeWorkspaceFolders: disposable, onDidChangeConfiguration: disposable,
    },
  };
  const timers = new Set();
  const source = path.join(OUT, 'extension.js'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    module, exports: module.exports, Error, Promise,
    setTimeout: (fn) => { const timer = setTimeout(fn, 0); timers.add(timer); return timer; },
    clearTimeout: (timer) => { clearTimeout(timer); timers.delete(timer); },
    require: (id) => id === 'vscode' ? vscode
      : id === './changes' ? { registerChanges: () => ({ setActiveChat: (chat) => chats.push(chat === null ? null : JSON.parse(JSON.stringify(chat))), refreshShellActivity() {}, dispose() {}, whenDisposed: async () => {} }) }
      : id === './inline' ? { registerInline() {} } : id === './skills-view' ? { registerSkills() {} }
      : id === './catalog-view' ? { registerCatalogs() {} }
      : id === './sessions' ? { sessionsDir: () => '/fixture/sessions', listSessionsAsync: async () => ({ sessions: listing, partial: false }) }
      : id.startsWith('.') ? require(path.resolve(OUT, id)) : require(id),
  }, { filename: source });
  const context = { extensionUri: { fsPath: '/extension' }, subscriptions: [], globalState: { get: (_key, fallback) => fallback, update: async () => {} } };
  module.exports.activate(context);
  t.after(() => { module.exports.deactivate(); timers.forEach(clearTimeout); });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return {
    chats, settle,
    last: async () => { await settle(); return chats.at(-1); },
    tabsChanged: async (list) => { setTabs(list); tabHandlers.forEach((handler) => handler({ opened: [], closed: [], changed: [] })); return (await settle(), chats.at(-1)); },
    transcriptChanged: async (next) => { listing = next; transcriptHandlers.forEach((handler) => handler()); return (await settle(), chats.at(-1)); },
  };
}

async function panel(t, activeChat, sessionsOfEntries) {
  const f = fixture(t);
  writeLog(f, sessionsOfEntries.map(([id, session]) => ({ ...entry(f.root, id), session })));
  f.controller.entries = await f.controller.loadEntries();
  f.controller.setActiveChat(activeChat);
  let state; f.controller.post({ postMessage: async (value) => { state = value; } }, false);
  return state;
}

test('a short generated title shared with an old conversation no longer hides the current conversation changes', async (t) => {
  // A aba já mostra o título gerado; o transcript novo ainda só tem a 1ª mensagem ("oi").
  const sessions = [
    { id: 'nova', title: 'oi', aliases: ['oi'], updated: 2 },
    { id: 'antiga', title: 'Saudação inicial', aliases: ['Saudação inicial', 'olá'], updated: 1 },
  ];
  const l = launcher(t, { tabs: [{ label: officialTabLabel('Saudação inicial'), active: true }], sessions });
  const chat = await l.last();
  assert.deepEqual(chat, { sessions: ['antiga'], title: 'Saudação inicial', elsewhere: [] });
  const state = await panel(t, chat, [['edit-nova', 'nova'], ['edit-antiga', 'antiga']]);
  assert.deepEqual(state.entries.map((item) => item.id).sort(), ['edit-antiga', 'edit-nova']);
  assert.equal(state.chat.unclaimed, 1);
  assert.equal(state.chat.others, 0);
});

test('the focused conversation is recomputed when its transcript gains the generated title', async (t) => {
  const label = officialTabLabel('Saudação inicial');
  const l = launcher(t, { tabs: [{ label, active: true }], sessions: [{ id: 'antiga', title: 'Saudação inicial', aliases: ['Saudação inicial'], updated: 1 }] });
  assert.deepEqual((await l.last()).sessions, ['antiga']);
  const chat = await l.transcriptChanged([
    { id: 'nova', title: 'Saudação inicial', aliases: ['Saudação inicial', 'oi'], updated: 2 },
    { id: 'antiga', title: 'Saudação inicial', aliases: ['Saudação inicial'], updated: 1 },
  ]);
  assert.deepEqual(chat.sessions, ['nova', 'antiga']);
});

test('long titles cut by the official tab still identify the conversation', async (t) => {
  const long = 'Ajustar o painel de mudanças por conversa';
  const l = launcher(t, { tabs: [{ label: officialTabLabel(long), active: true }], sessions: [{ id: 'longa', title: long, aliases: [long], updated: 1 }] });
  assert.deepEqual(await l.last(), { sessions: ['longa'], title: 'Ajustar o painel de muda…', elsewhere: [] });
});

test('a sidebar chat keeps its pending changes visible and closing every chat tab shows everything', async (t) => {
  const sessions = [
    { id: 'A', title: 'Conversa A', aliases: ['Conversa A'], updated: 1 },
    { id: 'B', title: 'Conversa B', aliases: ['Conversa B'], updated: 2 },
    { id: 'lateral', title: 'pedido na lateral', aliases: ['pedido na lateral'], updated: 3 },
  ];
  const l = launcher(t, { tabs: [{ label: 'Conversa A', active: true }, { label: 'Conversa B' }], sessions });
  const chat = await l.last();
  assert.deepEqual(chat, { sessions: ['A'], title: 'Conversa A', elsewhere: ['B'] });
  // O chat da barra lateral não é aba: a conversa dele não pertence a nenhuma aba aberta.
  const state = await panel(t, chat, [['edit-A', 'A'], ['edit-B', 'B'], ['edit-lateral', 'lateral']]);
  assert.deepEqual(state.entries.map((item) => item.id).sort(), ['edit-A', 'edit-lateral'], 'B stays hidden: its own tab claims it');
  // Foco num arquivo mantém a última conversa; sem nenhuma aba de chat, mostra tudo.
  assert.deepEqual(await l.tabsChanged([{ label: 'Conversa A' }, { label: 'arquivo.ts', viewType: 'text', active: true }]), chat);
  assert.equal(await l.tabsChanged([{ label: 'arquivo.ts', viewType: 'text', active: true }]), null);
});
