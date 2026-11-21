// Testes das abas de regras, agentes e MCP: leitura do disco, alterações e o controlador da view com o editor simulado.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const OUT = process.env.LAUNCHER_TEST_OUT || path.resolve(__dirname, '../out');
const fm = require(path.join(OUT, 'frontmatter.js'));
const catalog = require(path.join(OUT, 'catalog.js'));
const rules = require(path.join(OUT, 'rules.js'));
const agents = require(path.join(OUT, 'agents.js'));
const mcp = require(path.join(OUT, 'mcp.js'));

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// ---- Frontmatter -------------------------------------------------------------------

test('paths aceita lista YAML, lista entre colchetes e texto com vírgulas, sem quebrar globs com chaves', () => {
  assert.deepEqual(fm.frontmatterList('---\npaths:\n  - "src/**/*.ts"\n  - lib/*.js\nname: x\n---\n', 'paths'), ['src/**/*.ts', 'lib/*.js']);
  assert.deepEqual(fm.frontmatterList('---\npaths: ["a/**", \'b\']\n---', 'paths'), ['a/**', 'b']);
  assert.deepEqual(fm.frontmatterList('---\npaths: src/**/*.{ts,tsx}, docs/**\n---', 'paths'), ['src/**/*.{ts,tsx}', 'docs/**']);
  assert.deepEqual(fm.frontmatterList('---\r\npaths:\r\n  - a\r\n---\r\n', 'paths'), ['a']);
  assert.deepEqual(fm.frontmatterList('sem frontmatter', 'paths'), []);
  assert.deepEqual(fm.frontmatterList('---\nname: x\n---', 'paths'), []);
  assert.equal(fm.frontmatterBody('---\nname: x\n---\n# Título\n'), '# Título\n');
  assert.equal(fm.frontmatterBody('\uFEFF# Só corpo'), '# Só corpo');
  assert.deepEqual(fm.frontmatterFields('---\nname: a\nmodel: "sonnet"\n---'), { name: 'a', model: 'sonnet' });
});

// ---- Árvore de .md -----------------------------------------------------------------

test('a varredura de .md entra em subpastas, ignora ocultos e outros arquivos, e prefere a versão ativa', async (t) => {
  const root = tempRoot(t);
  write(path.join(root, 'b.md'), 'b');
  write(path.join(root, 'sub', 'a.md'), 'a');
  write(path.join(root, 'sub', 'off.md.disabled'), 'off');
  write(path.join(root, 'dupla.md'), 'ativa');
  write(path.join(root, 'dupla.md.disabled'), 'desativada');
  write(path.join(root, '.oculto', 'x.md'), 'x');
  write(path.join(root, '.x.md'), 'x');
  write(path.join(root, 'notas.txt'), 'x');
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(root, 'nao-existe.md'), path.join(root, 'quebrado.md'));
    fs.symlinkSync(root, path.join(root, 'sub', 'ciclo'));
  }
  const list = await catalog.scanMarkdownTree(root);
  assert.deepEqual(list.map((e) => [e.rel, e.state]), [
    ['b.md', 'active'], ['dupla.md', 'active'],
    ...(process.platform !== 'win32' ? [['quebrado.md', 'broken']] : []),
    ['sub/a.md', 'active'], ['sub/off.md', 'disabled'],
  ]);
  const off = list.find((e) => e.rel === 'sub/off.md');
  assert.equal(off.file, path.join(root, 'sub', 'off.md'));
  assert.equal(off.actual, path.join(root, 'sub', 'off.md.disabled'));
  assert.deepEqual(await catalog.scanMarkdownTree(path.join(root, 'nada')), []);
});

test('ativar e desativar renomeiam para .md.disabled e recusam estados inconsistentes sem apagar nada', async (t) => {
  const root = tempRoot(t);
  const file = path.join(root, 'r.md');
  write(file, 'regra');
  await catalog.setFileEnabled(file, false);
  assert.equal(fs.existsSync(file + '.disabled'), true);
  await assert.rejects(catalog.setFileEnabled(file, false), /já está desativado/);
  await catalog.setFileEnabled(file, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'regra');
  write(file + '.disabled', 'outra');
  await assert.rejects(catalog.setFileEnabled(file, false), /Já existe r\.md\.disabled/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'regra');
  assert.equal(fs.readFileSync(file + '.disabled', 'utf8'), 'outra');
});

test('a gravação condicional recusa quando o arquivo mudou e nunca deixa temporários', async (t) => {
  const root = tempRoot(t);
  const file = path.join(root, 'nova', 'x.json');
  await catalog.writeTextIfUnchanged(file, undefined, '{"a":1}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
  await assert.rejects(catalog.writeTextIfUnchanged(file, '{"velho":true}\n', '{}\n'), /mudou enquanto era editado/);
  await assert.rejects(catalog.writeTextIfUnchanged(file, undefined, '{}\n'), /mudou/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
  await catalog.writeTextIfUnchanged(file, '{"a":1}\n', '{"a":2}\n');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['x.json']);
});

// ---- Regras ------------------------------------------------------------------------

test('regras e arquivos de memória trazem descrição, paths e estado', async (t) => {
  const root = tempRoot(t);
  write(path.join(root, 'CLAUDE.md'), '\n# Regras do projeto\n\nTexto');
  write(path.join(root, '.claude', 'CLAUDE.md.disabled'), 'desligado');
  write(path.join(root, '.claude', 'rules', 'ts.md'), '---\npaths:\n  - "src/**/*.ts"\n---\n- Use tipos estritos.\n');
  write(path.join(root, '.claude', 'rules', 'geral', 'tom.md'), '---\ndescription: Tom das respostas\n---\nCorpo');
  const memory = await rules.scanMemory(root, rules.PROJECT_MEMORY, 'project');
  assert.deepEqual(memory.map((r) => [r.id, r.name, r.state, r.description]), [
    ['project:memory:CLAUDE.md', 'CLAUDE.md', 'active', 'Regras do projeto'],
    ['project:memory:.claude/CLAUDE.md', '.claude/CLAUDE.md', 'disabled', 'desligado'],
  ]);
  const list = await rules.scanRules(path.join(root, '.claude', 'rules'), 'project');
  assert.deepEqual(list.map((r) => [r.name, r.description, r.paths]), [
    ['geral/tom.md', 'Tom das respostas', []],
    ['ts.md', 'Use tipos estritos.', ['src/**/*.ts']],
  ]);
});

test('criar regra grava paths entre aspas, valida o nome e nunca sobrescreve, nem a versão desativada', async (t) => {
  const root = tempRoot(t);
  const file = await rules.createRule(path.join(root, 'rules'), 'estilo', rules.parsePathsInput('src/**/*.{ts,tsx}, "docs/*"'));
  const text = fs.readFileSync(file, 'utf8');
  assert.deepEqual(fm.frontmatterList(text, 'paths'), ['src/**/*.{ts,tsx}', 'docs/*']);
  assert.match(text, /^---\npaths:\n {2}- "src\/\*\*\/\*\.\{ts,tsx\}"\n/);
  const plain = fs.readFileSync(await rules.createRule(path.join(root, 'rules'), 'sempre', []), 'utf8');
  assert.equal(plain.startsWith('---'), false, 'sem paths, a regra vale sempre e não tem frontmatter');
  await assert.rejects(rules.createRule(path.join(root, 'rules'), 'estilo', []));
  fs.renameSync(file, file + '.disabled');
  await assert.rejects(rules.createRule(path.join(root, 'rules'), 'estilo', []), /desativado/);
  for (const bad of ['', 'A', '../x', 'a/b', 'com espaço']) { await assert.rejects(rules.createRule(root, bad, []), /minúsculas/); }
  assert.deepEqual(fs.readdirSync(path.join(root, 'rules')).sort(), ['estilo.md.disabled', 'sempre.md']);
});

// ---- Agentes -----------------------------------------------------------------------

test('agentes usam o name do frontmatter, mostram o modelo e o global encoberto pelo projeto', async (t) => {
  const root = tempRoot(t);
  write(path.join(root, 'p', 'revisor.md'), '---\nname: revisor\ndescription: Revisa\nmodel: opus\n---\n');
  write(path.join(root, 'g', 'outro-arquivo.md'), '---\nname: revisor\ndescription: Global\n---\n');
  write(path.join(root, 'g', 'sub', 'sem-nome.md'), 'corpo');
  const list = agents.markShadowedAgents([...await agents.scanAgents(path.join(root, 'p'), 'project'), ...await agents.scanAgents(path.join(root, 'g'), 'global')]);
  assert.deepEqual(list.map((a) => [a.id, a.name, a.model, a.shadowed]), [
    ['project:revisor.md', 'revisor', 'opus', false],
    ['global:outro-arquivo.md', 'revisor', '', true],
    ['global:sub/sem-nome.md', 'sem-nome', '', false],
  ]);
  fs.renameSync(path.join(root, 'p', 'revisor.md'), path.join(root, 'p', 'revisor.md.disabled'));
  const again = agents.markShadowedAgents([...await agents.scanAgents(path.join(root, 'p'), 'project'), ...await agents.scanAgents(path.join(root, 'g'), 'global')]);
  assert.equal(again.find((a) => a.scope === 'global' && a.name === 'revisor').shadowed, false, 'um agente desativado não encobre');
});

test('criar agente gera YAML válido e nunca sobrescreve', async (t) => {
  const root = tempRoot(t);
  const file = await agents.createAgent(root, 'revisor', 'Use quando "revisar" C:\\temp\nsegunda linha');
  assert.deepEqual(fm.parseFrontmatter(fs.readFileSync(file, 'utf8')), { name: 'revisor', description: 'Use quando "revisar" C:\\temp segunda linha' });
  await assert.rejects(agents.createAgent(root, 'revisor', 'outra'));
  await assert.rejects(agents.createAgent(root, 'Revisor', ''), /minúsculas/);
});

// ---- MCP ---------------------------------------------------------------------------

function mcpFixture(t, { global = {}, mcpJson, local, shared, user, managed } = {}) {
  const base = tempRoot(t), project = path.join(base, 'projeto'), config = path.join(base, 'config');
  fs.mkdirSync(project, { recursive: true });
  const loc = { project, globalConfig: path.join(config, '.claude.json'), userSettings: path.join(config, 'settings.json'), managed: path.join(base, 'managed-mcp.json'), platform: 'linux' };
  const put = (file, value) => { if (value !== undefined) { write(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); } };
  put(loc.globalConfig, typeof global === 'function' ? global(project) : global);
  put(path.join(project, '.mcp.json'), mcpJson);
  put(path.join(project, '.claude', 'settings.local.json'), local);
  put(path.join(project, '.claude', 'settings.json'), shared);
  put(loc.userSettings, user);
  put(loc.managed, managed);
  return { loc, project, base };
}

test('MCP lista os quatro escopos com aprovação, recusa, /mcp e prioridade de nomes', async (t) => {
  const f = mcpFixture(t, {
    global: (project) => ({
      mcpServers: { github: { type: 'http', url: 'https://api.example.com/mcp?token=abc' }, so_usuario: { command: 'node', args: ['srv.js'] } },
      projects: { [project]: { mcpServers: { github: { command: 'npx', args: ['gh-mcp', '--token', 'ghp_123456789'] } }, disabledMcpServers: ['desligado'] } },
    }),
    mcpJson: { mcpServers: { aprovado: { command: 'a' }, pendente: { command: 'b' }, recusado: { command: 'c' }, compartilhado: { command: 'd' }, desligado: { command: 'e' }, github: { command: 'f' }, quebrado: { url: 'https://x' } } },
    local: { enabledMcpjsonServers: ['aprovado'], disabledMcpjsonServers: ['recusado'] },
    shared: { disabledMcpjsonServers: ['compartilhado'] },
    managed: { mcpServers: { empresa: { type: 'sse', url: 'https://user:senha@corp.example/sse' } } },
  });
  const { servers, problems, managedPolicy } = await mcp.loadMcp(f.loc);
  assert.deepEqual(problems, []);
  assert.equal(managedPolicy, true);
  const by = Object.fromEntries(servers.map((s) => [s.id, s]));
  assert.deepEqual(servers.map((s) => s.id), [
    'local:github',
    'project:aprovado', 'project:compartilhado', 'project:desligado', 'project:github', 'project:pendente', 'project:quebrado', 'project:recusado',
    'user:github', 'user:so_usuario', 'managed:empresa',
  ]);
  assert.deepEqual(['aprovado', 'pendente', 'recusado', 'compartilhado', 'desligado', 'quebrado'].map((n) => [n, by['project:' + n].state, by['project:' + n].canToggle]), [
    ['aprovado', 'active', true], ['pendente', 'pending', true], ['recusado', 'disabled', true],
    ['compartilhado', 'disabled', false], ['desligado', 'disabled', false], ['quebrado', 'broken', false],
  ]);
  assert.match(by['project:compartilhado'].note, /\.claude\/settings\.json/);
  assert.match(by['project:desligado'].note, /\/mcp/);
  assert.match(by['project:quebrado'].note, /falta "type"/);
  assert.equal(by['local:github'].shadowedBy, undefined);
  assert.equal(by['project:github'].shadowedBy, 'local');
  assert.equal(by['user:github'].shadowedBy, 'local');
  assert.equal(by['user:so_usuario'].canToggle, false);
  assert.equal(by['local:github'].target, 'npx gh-mcp --token •••');
  assert.equal(by['user:github'].target, 'https://api.example.com/mcp?…');
  assert.equal(by['managed:empresa'].target, 'https://corp.example/sse');
  assert.equal(by['managed:empresa'].transport, 'sse');
  assert.deepEqual(by['local:github'].keyPath, ['projects', f.project, 'mcpServers', 'github']);
});

test('MCP aceita enableAllProjectMcpServers, relata JSON inválido e acha a pasta com barras do Windows', async (t) => {
  const f = mcpFixture(t, { global: '{ quebrado', mcpJson: { mcpServers: { a: { command: 'x' } } }, user: { enableAllProjectMcpServers: true } });
  const listing = await mcp.loadMcp(f.loc);
  assert.equal(listing.servers[0].state, 'active');
  assert.deepEqual(listing.problems, ['.claude.json não é um JSON válido.']);
  assert.equal(mcp.projectKey({ 'C:/Users/u/proj': {} }, 'c:\\Users\\u\\proj\\', 'win32'), 'C:/Users/u/proj');
  assert.equal(mcp.projectKey({ '/home/u/Proj': {} }, '/home/u/proj', 'linux'), undefined);
  assert.equal(mcp.globalConfigFile({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/u'), path.join('/cfg', '.claude.json'));
  assert.equal(mcp.globalConfigFile({}, '/home/u'), path.join('/home/u', '.claude.json'));
});

test('descrições de MCP escondem segredos aparentes em argumentos e URLs', () => {
  assert.deepEqual(mcp.redactArgs(['--api-key=abc', '--token', 'xyz', 'API_TOKEN=1', '-y', '@scope/pacote', 'sk-abcdef', 'ab12cd34ef56gh78ij90kl12mn34op56']),
    ['--api-key=•••', '--token', '•••', 'API_TOKEN=•••', '-y', '@scope/pacote', '•••', '•••']);
  assert.equal(mcp.redactUrl('https://u:p@h.example:8080/a/b?k=1#x'), 'https://h.example:8080/a/b?…');
  assert.equal(mcp.redactUrl('https://h.example/'), 'https://h.example');
  assert.equal(mcp.describeEntry({ type: 'ws', url: 'wss://x' }).transport, 'ws');
  assert.match(mcp.describeEntry([]).problem, /objeto/);
  assert.match(mcp.describeEntry({ type: 'http' }).problem, /url/);
});

test('aprovar e recusar mexem só nas listas do servidor e preservam o resto do settings.local.json', () => {
  const start = JSON.stringify({ hooks: { PreToolUse: [] }, enabledMcpjsonServers: ['x', 'outro'] });
  const off = JSON.parse(mcp.planApproval(start, 'x', false));
  assert.deepEqual(off, { hooks: { PreToolUse: [] }, enabledMcpjsonServers: ['outro'], disabledMcpjsonServers: ['x'] });
  const on = JSON.parse(mcp.planApproval(JSON.stringify(off), 'x', true));
  assert.deepEqual(on, { hooks: { PreToolUse: [] }, enabledMcpjsonServers: ['outro', 'x'] });
  assert.deepEqual(JSON.parse(mcp.planApproval(undefined, 'novo', true)), { enabledMcpjsonServers: ['novo'] });
  assert.deepEqual(JSON.parse(mcp.planApproval('{"disabledMcpjsonServers":["y"]}', 'y', true)), { enabledMcpjsonServers: ['y'] });
  assert.throws(() => mcp.planApproval('{ inválido', 'x', true), /JSON válido/);
  assert.throws(() => mcp.planApproval('{"enabledMcpjsonServers":"x"}', 'x', true), /lista de nomes/);
  assert.throws(() => mcp.planApproval('[]', 'x', true), /objeto/);
});

test('adicionar e remover servidores do .mcp.json validam nome, duplicata e formato', () => {
  const added = mcp.planAddServer(undefined, 'fs', mcp.entryFromInput('npx -y "@m/server fs" \'C:\\dir\''));
  assert.deepEqual(JSON.parse(added), { mcpServers: { fs: { type: 'stdio', command: 'npx', args: ['-y', '@m/server fs', 'C:\\dir'] } } });
  const both = mcp.planAddServer(added, 'web', mcp.entryFromInput(' https://mcp.example.com/mcp '));
  assert.deepEqual(JSON.parse(both).mcpServers.web, { type: 'http', url: 'https://mcp.example.com/mcp' });
  assert.throws(() => mcp.planAddServer(both, 'fs', {}), /Já existe/);
  assert.throws(() => mcp.planAddServer(both, 'com espaço', {}), /letras/);
  assert.throws(() => mcp.planAddServer('{"mcpServers":[]}', 'a', {}), /não é um objeto/);
  assert.deepEqual(Object.keys(JSON.parse(mcp.planRemoveServer(both, 'fs')).mcpServers), ['web']);
  assert.throws(() => mcp.planRemoveServer(both, 'nao-tem'), /não está mais/);
  assert.throws(() => mcp.entryFromInput('   '), /Informe/);
  assert.throws(() => mcp.entryFromInput('node "sem fim'), /Aspas/);
  assert.deepEqual(mcp.splitCommandLine('a  "b \\"c\\"" d\\e'), ['a', 'b "c"', 'd\\e']);
  assert.deepEqual(mcp.splitCommandLine('a ""'), ['a', '']);
});

test('a localização no JSON acha a chave certa mesmo com o mesmo nome em outro lugar', () => {
  const text = '{\n  "projects": {\n    "/p": {\n      "mcpServers": {\n        "gh": {}\n      }\n    }\n  },\n  "lista": [{"mcpServers": {"gh": 1}}],\n  "mcpServers": {\n    "gh": { "s": "a\\"}" }\n  }\n}';
  const user = mcp.findJsonKey(text, ['mcpServers', 'gh']);
  assert.deepEqual(mcp.lineAt(text, user), { line: 10, character: 4 });
  assert.deepEqual(mcp.lineAt(text, mcp.findJsonKey(text, ['projects', '/p', 'mcpServers', 'gh'])), { line: 4, character: 8 });
  assert.equal(mcp.findJsonKey(text, ['mcpServers', 'nao']), undefined);
  assert.equal(mcp.findJsonKey('{ quebrado', ['a']), undefined);
  assert.equal(mcp.findJsonKey('', ['a']), undefined);
});

// ---- Controlador da view -----------------------------------------------------------

function controllerFixture(t, { project, config, answers = {} }) {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => { if (previous === undefined) { delete process.env.CLAUDE_CONFIG_DIR; } else { process.env.CLAUDE_CONFIG_DIR = previous; } });
  const posted = [], errors = [], warnings = [], opened = [], deleted = [], executed = [], commands = new Map(), watchers = [];
  const Uri = { file: (fsPath) => ({ fsPath, scheme: 'file' }) };
  const event = () => ({ dispose() {} });
  const vscode = {
    Uri,
    Range: class { constructor(l, c) { this.start = { line: l, character: c }; } },
    RelativePattern: class { constructor(base, pattern) { this.base = base.fsPath; this.pattern = pattern; } },
    window: {
      showTextDocument: async (uri, options) => { opened.push([uri.fsPath, options?.selection?.start]); },
      showWarningMessage: async (message, ...rest) => { warnings.push(message); return answers.warning?.(message, ...rest); },
      showErrorMessage: async (message) => { errors.push(message); },
      showInputBox: async (options) => answers.input?.shift()?.(options),
    },
    workspace: {
      workspaceFolders: project ? [{ uri: Uri.file(project) }] : undefined,
      fs: { delete: async (uri, options) => { deleted.push([uri.fsPath, options]); fs.rmSync(uri.fsPath); } },
      createFileSystemWatcher: (pattern) => {
        const handlers = [];
        const w = { pattern, fire: () => handlers.forEach((h) => h()), dispose() {} };
        w.onDidCreate = w.onDidChange = w.onDidDelete = (h) => { handlers.push(h); return event(); };
        watchers.push(w);
        return w;
      },
      onDidChangeWorkspaceFolders: event,
    },
    commands: {
      executeCommand: async (...args) => { executed.push(args); },
      registerCommand: (id, fn) => { commands.set(id, fn); return event(); },
    },
  };
  const filename = path.join(OUT, 'catalog-view.js'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, setTimeout, clearTimeout, process, Error,
    require: (id) => id === 'vscode' ? vscode : id.startsWith('.') ? require(path.join(OUT, id)) : require(id),
  }, { filename });
  const context = { subscriptions: [] };
  const catalogs = module.exports.registerCatalogs(context, (message) => posted.push(JSON.parse(JSON.stringify(message))));
  t.after(() => context.subscriptions.forEach((s) => s.dispose()));
  const last = (kind) => posted.filter((m) => m.type === 'catalog' && m.kind === kind).at(-1);
  return { catalogs, posted, errors, warnings, opened, deleted, executed, commands, watchers, last };
}

function catalogRoots(t) {
  const base = tempRoot(t), config = path.join(base, 'config'), project = path.join(base, 'projeto');
  write(path.join(config, 'CLAUDE.md'), '# Global');
  write(path.join(config, 'rules', 'g.md'), 'regra global');
  write(path.join(project, 'CLAUDE.md'), '# Projeto');
  write(path.join(project, '.claude', 'rules', 'p.md'), 'regra do projeto');
  write(path.join(project, '.claude', 'agents', 'rev.md'), '---\nname: rev\ndescription: r\n---\n');
  write(path.join(config, 'agents', 'glob.md'), '---\nname: glob\n---\n');
  write(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { srv: { command: 'node', args: ['s.js'] } } }, null, 2));
  write(path.join(config, '.claude.json'), JSON.stringify({ mcpServers: { usr: { type: 'http', url: 'https://u.example/mcp' } } }));
  return { base, config, project };
}

test('o controlador publica as três abas sem caminhos absolutos e ignora ids que não vieram da listagem', async (t) => {
  const roots = catalogRoots(t);
  const c = controllerFixture(t, roots);
  for (const kind of ['rules', 'agents', 'mcp']) { await c.catalogs.handle(kind + '.refresh'); }
  const rulesMsg = c.last('rules'), agentsMsg = c.last('agents'), mcpMsg = c.last('mcp');
  assert.deepEqual(rulesMsg.items.filter((i) => i.scope !== 'managed').map((i) => [i.id, i.canToggle, i.canDelete]), [
    ['project:memory:CLAUDE.md', true, true], ['project:rule:p.md', true, true], ['global:memory:CLAUDE.md', true, true], ['global:rule:g.md', true, true],
  ]);
  assert.deepEqual(agentsMsg.items.map((i) => i.id), ['project:rev.md', 'global:glob.md']);
  assert.deepEqual(mcpMsg.items.filter((i) => i.scope !== 'managed').map((i) => [i.id, i.state, i.canToggle, i.canDelete]), [
    ['project:srv', 'pending', true, true], ['user:usr', 'active', false, false],
  ]);
  const text = JSON.stringify(c.posted);
  assert.equal(text.includes(roots.base), false, 'nenhum caminho absoluto chega à página');
  for (const kind of ['rules', 'agents', 'mcp']) {
    for (const action of ['open', 'reveal', 'toggle', 'delete']) {
      await c.catalogs.handle(`${kind}.${action}`, 'project:../../fora');
      await c.catalogs.handle(`${kind}.${action}`, undefined);
    }
  }
  assert.deepEqual(c.opened, []); assert.deepEqual(c.deleted, []); assert.deepEqual(c.warnings, []); assert.deepEqual(c.errors, []);
});

test('alternar e excluir regras e agentes renomeiam ou mandam para a lixeira só com confirmação', async (t) => {
  const roots = catalogRoots(t);
  let answer;
  const c = controllerFixture(t, { ...roots, answers: { warning: () => answer } });
  await c.catalogs.handle('rules.refresh');
  await c.catalogs.handle('rules.toggle', 'global:memory:CLAUDE.md');
  assert.equal(fs.existsSync(path.join(roots.config, 'CLAUDE.md.disabled')), true);
  assert.equal(c.last('rules').items.find((i) => i.id === 'global:memory:CLAUDE.md').state, 'disabled');
  await c.catalogs.handle('rules.open', 'global:memory:CLAUDE.md');
  assert.deepEqual(c.opened.map(([file]) => file), [path.join(roots.config, 'CLAUDE.md.disabled')]);
  await c.catalogs.handle('rules.toggle', 'global:memory:CLAUDE.md');
  assert.equal(fs.existsSync(path.join(roots.config, 'CLAUDE.md')), true);

  await c.catalogs.handle('agents.refresh');
  await c.catalogs.handle('agents.delete', 'project:rev.md');
  assert.deepEqual(c.deleted, []);
  assert.match(c.warnings.at(-1), /rev.*lixeira/);
  answer = 'Excluir';
  await c.catalogs.handle('agents.delete', 'project:rev.md');
  assert.deepEqual(JSON.parse(JSON.stringify(c.deleted)), [[path.join(roots.project, '.claude', 'agents', 'rev.md'), { useTrash: true }]]);
  assert.equal(c.last('agents').items.some((i) => i.id === 'project:rev.md'), false);
});

test('MCP pelo controlador aprova no settings.local.json, cria e remove no .mcp.json e nunca grava o ~/.claude.json', async (t) => {
  const roots = catalogRoots(t);
  const globalBefore = fs.readFileSync(path.join(roots.config, '.claude.json'), 'utf8');
  let answer;
  const inputs = [];
  const c = controllerFixture(t, { ...roots, answers: { warning: () => answer, input: inputs } });
  await c.catalogs.handle('mcp.refresh');
  await c.catalogs.handle('mcp.toggle', 'project:srv');
  const settings = path.join(roots.project, '.claude', 'settings.local.json');
  assert.deepEqual(json(settings), { enabledMcpjsonServers: ['srv'] });
  assert.equal(c.last('mcp').items.find((i) => i.id === 'project:srv').state, 'active');
  await c.catalogs.handle('mcp.toggle', 'project:srv');
  assert.deepEqual(json(settings), { disabledMcpjsonServers: ['srv'] });
  await c.catalogs.handle('mcp.toggle', 'user:usr');
  await c.catalogs.handle('mcp.delete', 'user:usr');
  assert.deepEqual(c.warnings, []);

  inputs.push((o) => { assert.equal(o.validateInput('com espaço'), 'Ex.: github'); return 'web'; },
    (o) => { assert.match(o.validateInput('node "x'), /Aspas/); return 'https://w.example/mcp'; });
  await c.catalogs.handle('mcp.create', undefined, 'project');
  assert.deepEqual(json(path.join(roots.project, '.mcp.json')).mcpServers.web, { type: 'http', url: 'https://w.example/mcp' });
  const [file, at] = c.opened.at(-1);
  assert.equal(file, path.join(roots.project, '.mcp.json'));
  assert.equal(fs.readFileSync(file, 'utf8').split('\n')[at.line].includes('"web"'), true, 'abre na linha do servidor');
  inputs.push(() => 'web', () => 'outro');
  await c.catalogs.handle('mcp.create', undefined, 'project');
  assert.match(c.errors.at(-1), /^MCP: Já existe/);
  await c.catalogs.handle('mcp.create', undefined, 'user');

  await c.catalogs.handle('mcp.delete', 'project:srv');
  assert.equal('srv' in json(path.join(roots.project, '.mcp.json')).mcpServers, true, 'sem confirmação nada muda');
  answer = 'Remover';
  await c.catalogs.handle('mcp.delete', 'project:srv');
  assert.deepEqual(Object.keys(json(path.join(roots.project, '.mcp.json')).mcpServers), ['web']);
  assert.equal(fs.readFileSync(path.join(roots.config, '.claude.json'), 'utf8'), globalBefore);
});

test('a troca de aba liga só a lista visível, ajusta o contexto e acompanha a paleta', async (t) => {
  const roots = catalogRoots(t);
  const c = controllerFixture(t, roots);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(c.executed[0], ['setContext', 'claudeCodeLauncher.panel', 'chats']);
  const fire = () => c.watchers.forEach((w) => w.fire());
  fire();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(c.posted.length, 0, 'com a aba de conversas, mudanças em disco não releem nada');
  await c.catalogs.showPanel('mcp');
  assert.deepEqual(c.executed.at(-1), ['setContext', 'claudeCodeLauncher.panel', 'mcp']);
  assert.equal(c.posted.some((m) => m.type === 'tab'), false, 'a página que pediu a troca não recebe a troca de volta');
  fire();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual([...new Set(c.posted.map((m) => m.kind))], ['mcp']);
  await c.catalogs.showPanel('../fora');
  assert.deepEqual(c.executed.at(-1), ['setContext', 'claudeCodeLauncher.panel', 'mcp']);
  await c.commands.get('claude-code-launcher.showRules')();
  assert.deepEqual(c.posted.at(-1), { type: 'tab', tab: 'rules' });
  for (const id of ['showChats', 'showSkills', 'showRules', 'showAgents', 'showMcp']) { assert.equal(c.commands.has('claude-code-launcher.' + id), true, id); }
});
