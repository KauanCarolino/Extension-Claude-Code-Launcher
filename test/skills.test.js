// Testes das skills: leitura do disco, criação, ativação e o controlador da view com o editor simulado.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const OUT = process.env.LAUNCHER_TEST_OUT || path.resolve(__dirname, '../out');
const { scanSkills, scanSynced, createSkill, setSkillEnabled, parseFrontmatter, validSkillName, globalSkillsRoot, SKILL_FILE, DISABLED_FILE } = require(path.join(OUT, 'skills.js'));

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSkill(root, name, body, file = SKILL_FILE) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, file), body);
}

test('frontmatter, criação, desativação e skill quebrada', async (t) => {
  const root = tempRoot(t);
  assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: "b c"\n---\n'), { name: 'a', description: 'b c' });
  await createSkill(root, 'minha-skill', 'Usar quando "x"');
  await assert.rejects(createSkill(root, 'minha-skill', ''));
  await assert.rejects(createSkill(root, '../fora', ''));
  if (process.platform !== 'win32') { fs.symlinkSync(path.join(root, 'nao-existe'), path.join(root, 'quebrada')); }
  let list = await scanSkills(root, 'global');
  assert.deepEqual(list.map((s) => [s.name, s.state]), process.platform === 'win32'
    ? [['minha-skill', 'active']] : [['minha-skill', 'active'], ['quebrada', 'broken']]);
  assert.equal(list[0].description, 'Usar quando "x"');
  await setSkillEnabled(list[0], false);
  list = await scanSkills(root, 'global');
  assert.equal(list[0].state, 'disabled');
  await setSkillEnabled(list[0], true);
  assert.equal((await scanSkills(root, 'global'))[0].state, 'active');
  assert.deepEqual(await scanSkills(path.join(root, 'x'), 'project'), []);
});

test('frontmatter aceita BOM, CRLF, aspas simples, escapes e valores em várias linhas', () => {
  assert.deepEqual(parseFrontmatter('\uFEFF---\r\nname: com-bom\r\ndescription: texto\r\n---\r\n'), { name: 'com-bom', description: 'texto' });
  assert.deepEqual(parseFrontmatter("---\nname: 'aspas'\ndescription: 'a \"b\"'\n---"), { name: 'aspas', description: 'a "b"' });
  assert.deepEqual(parseFrontmatter('---\nname: x\ndescription: "c:\\\\dir \\"y\\""\n---'), { name: 'x', description: 'c:\\dir "y"' });
  assert.deepEqual(parseFrontmatter('---\nname: x\ndescription: >\n  primeira\n  segunda\n---'), { name: 'x', description: 'primeira segunda' });
  assert.deepEqual(parseFrontmatter('sem frontmatter'), {});
  assert.deepEqual(parseFrontmatter('---\nname: sem fim'), {});
});

test('a descrição criada é YAML válido mesmo com barra invertida, aspas, quebras e controles', async (t) => {
  const root = tempRoot(t);
  const description = 'Caminho C:\\temp\\ "citado"\nsegunda linha\ttab\\';
  const file = await createSkill(root, 'yaml-seguro', description);
  const text = fs.readFileSync(file, 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('description:'));
  // Escalar entre aspas duplas: toda aspa interna escapada e nenhuma barra solta antes do fechamento.
  assert.match(line, /^description: "(?:[^"\\]|\\["\\])*"$/);
  assert.equal(parseFrontmatter(text).description, 'Caminho C:\\temp\\ "citado" segunda linha tab\\');
  assert.equal(path.basename(file), SKILL_FILE);
});

test('nomes de skill seguem o formato do Claude Code e nunca escapam da pasta', async (t) => {
  const root = tempRoot(t);
  for (const ok of ['a', 'minha-skill', 'v2', 'a'.repeat(64)]) { assert.equal(validSkillName(ok), true, ok); }
  for (const bad of ['', 'A', 'com espaço', '-a', 'a-', 'a--b', '../x', 'a/b', 'a\\b', '.oculta', 'a'.repeat(65), 'ção']) {
    assert.equal(validSkillName(bad), false, bad);
    await assert.rejects(createSkill(root, bad, ''), /minúsculas/);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('criar nunca sobrescreve uma pasta ou arquivo existente', async (t) => {
  const root = tempRoot(t);
  writeSkill(root, 'existente', '---\nname: original\n---\n');
  await assert.rejects(createSkill(root, 'existente', 'nova'));
  assert.equal(fs.readFileSync(path.join(root, 'existente', SKILL_FILE), 'utf8'), '---\nname: original\n---\n');
  const nested = path.join(root, 'ainda', 'nao', 'existe');
  await createSkill(nested, 'nova', '');
  assert.equal(fs.existsSync(path.join(nested, 'nova', SKILL_FILE)), true);
});

test('ativar e desativar recusam estados inconsistentes sem apagar nada', async (t) => {
  const root = tempRoot(t);
  writeSkill(root, 'dupla', 'ativa');
  fs.writeFileSync(path.join(root, 'dupla', DISABLED_FILE), 'desativada');
  const [dupla] = await scanSkills(root, 'project');
  assert.equal(dupla.state, 'active');
  await assert.rejects(setSkillEnabled(dupla, false), /Já existe SKILL\.md\.disabled/);
  assert.equal(fs.readFileSync(path.join(root, 'dupla', SKILL_FILE), 'utf8'), 'ativa');
  assert.equal(fs.readFileSync(path.join(root, 'dupla', DISABLED_FILE), 'utf8'), 'desativada');

  writeSkill(root, 'mudou', 'x');
  const [, mudou] = await scanSkills(root, 'project');
  fs.renameSync(path.join(root, 'mudou', SKILL_FILE), path.join(root, 'mudou', DISABLED_FILE));
  await assert.rejects(setSkillEnabled(mudou, false), /alterada fora do launcher/);
  assert.equal(fs.existsSync(path.join(root, 'mudou', DISABLED_FILE)), true);

  fs.mkdirSync(path.join(root, 'vazia'));
  const vazia = (await scanSkills(root, 'project')).find((s) => s.dir.endsWith('vazia'));
  assert.equal(vazia.state, 'broken');
  await assert.rejects(setSkillEnabled(vazia, true), /sem SKILL\.md/);
  await assert.rejects(setSkillEnabled({ ...dupla, scope: 'claudeai' }, false), /somente leitura/);
});

test('a varredura ignora ocultos e arquivos soltos, ordena e separa as skills sincronizadas', async (t) => {
  const root = tempRoot(t);
  writeSkill(root, 'zeta', '---\nname: Zeta\ndescription: última\n---');
  writeSkill(root, 'alfa', '---\ndescription: sem nome\n---');
  writeSkill(root, '.oculta', 'x');
  fs.writeFileSync(path.join(root, 'solto.md'), 'x');
  writeSkill(path.join(root, 'synced', 'conta-1'), 'remota', '---\nname: remota\n---');
  writeSkill(path.join(root, 'synced', '.tmp'), 'ignorada', 'x');
  const global = await scanSkills(root, 'global');
  assert.deepEqual(global.map((s) => [s.id, s.name, s.description]), [['global:alfa', 'alfa', 'sem nome'], ['global:zeta', 'Zeta', 'última']]);
  const project = await scanSkills(root, 'project');
  assert.deepEqual(project.map((s) => s.id), ['project:alfa', 'project:synced', 'project:zeta'], 'synced só é especial na pasta global');
  const synced = await scanSynced(root);
  assert.deepEqual(synced.map((s) => [s.id, s.scope, s.state]), [['claudeai:remota', 'claudeai', 'active']]);
  assert.deepEqual(await scanSynced(path.join(root, 'nada')), []);
});

test('a pasta global respeita CLAUDE_CONFIG_DIR, como a lista de conversas', () => {
  assert.equal(globalSkillsRoot({}, '/home/u'), path.join('/home/u', '.claude', 'skills'));
  assert.equal(globalSkillsRoot({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/u'), path.join('/cfg', 'skills'));
  assert.equal(globalSkillsRoot({ CLAUDE_CONFIG_DIR: '' }, '/home/u'), path.join('/home/u', '.claude', 'skills'));
});

/** Carrega o controlador compilado com o editor simulado; o disco é real. */
function controller(t, { project, projects, config, answers = {} } = {}) {
  const posted = [], errors = [], warnings = [], opened = [], deleted = [], revealed = [];
  const Uri = { file: (fsPath) => ({ fsPath, scheme: 'file' }) };
  const vscode = {
    Uri,
    window: {
      showTextDocument: async (uri) => { opened.push(uri.fsPath); },
      showWarningMessage: async (message, ...rest) => { warnings.push(message); return answers.warning?.(message, ...rest); },
      showErrorMessage: async (message) => { errors.push(message); },
      showInputBox: async (options) => answers.input?.shift()?.(options),
      showWorkspaceFolderPick: async () => answers.folder?.(),
    },
    workspace: {
      workspaceFolders: projects ? projects.map((root, index) => ({ uri: Uri.file(root), name: path.basename(root), index }))
        : project ? [{ uri: Uri.file(project) }] : undefined,
      fs: { delete: async (uri, options) => { deleted.push([uri.fsPath, options]); fs.rmSync(uri.fsPath, { recursive: true }); } },
    },
    commands: { executeCommand: async (...args) => { revealed.push(args); } },
  };
  const filename = path.join(OUT, 'skills-view.js'), module = { exports: {} };
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, setTimeout, clearTimeout,
    process: { ...process, env },
    require: (name) => name === 'vscode' ? vscode : name === './remote' ? withVscode('remote.js', vscode) : name === './skills'
      ? loadSkillsWithEnv(env) : name.startsWith('./') ? require(path.join(OUT, name)) : require(name),
  }, { filename });
  const instance = new module.exports.SkillsController((message) => posted.push(message));
  t.after(() => instance.dispose());
  // Objetos criados no contexto do vm têm outros protótipos; JSON os traz para este contexto.
  return { instance, posted, errors, warnings, opened, deleted, revealed, last: () => JSON.parse(JSON.stringify(posted.at(-1))) };
}

/** Módulo de out/ carregado com o editor simulado, como o próprio controlador o vê. */
function withVscode(name, vscode) {
  const file = path.join(OUT, name), loaded = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module: loaded, exports: loaded.exports, require: (id) => id === 'vscode' ? vscode : id.startsWith('.') ? require(path.join(OUT, id)) : require(id) }, { filename: file });
  return loaded.exports;
}

function loadSkillsWithEnv(env) {
  const filename = path.join(OUT, 'skills.js'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process: { ...process, env },
    require: (id) => id.startsWith('.') ? require(path.join(OUT, id)) : require(id),
  }, { filename });
  return module.exports;
}

function setupRoots(t) {
  const base = tempRoot(t), config = path.join(base, 'config'), project = path.join(base, 'projeto');
  const globalDir = path.join(config, 'skills'), projectDir = path.join(project, '.claude', 'skills');
  writeSkill(globalDir, 'global-a', '---\nname: global-a\ndescription: g\n---');
  writeSkill(projectDir, 'proj-a', '---\nname: proj-a\ndescription: p\n---');
  writeSkill(path.join(globalDir, 'synced', 'conta'), 'remota', '---\nname: remota\n---');
  return { config, project, globalDir, projectDir };
}

test('o controlador lista projeto, global e claude.ai e só publica campos sem caminho', async (t) => {
  const roots = setupRoots(t);
  const c = controller(t, roots);
  await c.instance.post();
  const message = c.last();
  assert.equal(message.type, 'skills');
  assert.equal(message.hasProject, true);
  assert.deepEqual(message.skills.map((s) => [s.id, s.scope, s.state]),
    [['project:proj-a', 'project', 'active'], ['global:global-a', 'global', 'active'], ['claudeai:remota', 'claudeai', 'active']]);
  for (const skill of message.skills) { assert.deepEqual(Object.keys(skill).sort(), ['description', 'id', 'name', 'scope', 'state']); }
});

test('o controlador ignora ids que não vieram da última listagem', async (t) => {
  const roots = setupRoots(t);
  const c = controller(t, roots);
  await c.instance.post();
  for (const command of ['skills.open', 'skills.reveal', 'skills.toggle', 'skills.delete']) {
    await c.instance.handle(command, 'global:../../fora');
    await c.instance.handle(command, 'project:inexistente');
    await c.instance.handle(command, undefined);
  }
  assert.deepEqual(c.opened, []); assert.deepEqual(c.revealed, []); assert.deepEqual(c.deleted, []); assert.deepEqual(c.warnings, []);
  assert.equal(fs.existsSync(path.join(roots.globalDir, 'global-a', SKILL_FILE)), true);
});

test('skills do claude.ai não são alternadas nem excluídas, mas podem ser abertas', async (t) => {
  const roots = setupRoots(t);
  const c = controller(t, { ...roots, answers: { warning: () => 'Excluir' } });
  await c.instance.post();
  await c.instance.handle('skills.toggle', 'claudeai:remota');
  await c.instance.handle('skills.delete', 'claudeai:remota');
  assert.deepEqual(c.deleted, []); assert.deepEqual(c.warnings, []);
  assert.equal(fs.existsSync(path.join(roots.globalDir, 'synced', 'conta', 'remota', SKILL_FILE)), true);
  await c.instance.handle('skills.open', 'claudeai:remota');
  assert.deepEqual(c.opened, [path.join(roots.globalDir, 'synced', 'conta', 'remota', SKILL_FILE)]);
});

test('alternar pelo controlador renomeia o arquivo e republica o estado', async (t) => {
  const roots = setupRoots(t);
  const c = controller(t, roots);
  await c.instance.post();
  await c.instance.handle('skills.toggle', 'project:proj-a');
  assert.equal(c.last().skills.find((s) => s.id === 'project:proj-a').state, 'disabled');
  assert.equal(fs.existsSync(path.join(roots.projectDir, 'proj-a', DISABLED_FILE)), true);
  await c.instance.handle('skills.open', 'project:proj-a');
  assert.deepEqual(c.opened, [path.join(roots.projectDir, 'proj-a', DISABLED_FILE)]);
  await c.instance.handle('skills.toggle', 'project:proj-a');
  assert.equal(c.last().skills.find((s) => s.id === 'project:proj-a').state, 'active');
});

test('excluir só acontece com confirmação explícita e usa a lixeira', async (t) => {
  const roots = setupRoots(t);
  let answer;
  const c = controller(t, { ...roots, answers: { warning: () => answer } });
  await c.instance.post();
  await c.instance.handle('skills.delete', 'global:global-a');
  assert.deepEqual(c.deleted, []);
  assert.match(c.warnings[0], /global-a.*lixeira/);
  answer = 'Excluir';
  await c.instance.handle('skills.delete', 'global:global-a');
  assert.deepEqual(JSON.parse(JSON.stringify(c.deleted)), [[path.join(roots.globalDir, 'global-a'), { recursive: true, useTrash: true }]]);
  assert.equal(c.last().skills.some((s) => s.id === 'global:global-a'), false);
});

test('criar pelo controlador respeita o escopo, valida o nome e mostra erros sem lançar', async (t) => {
  const roots = setupRoots(t);
  const inputs = [];
  const c = controller(t, { ...roots, answers: { input: inputs } });
  await c.instance.post();
  inputs.push((options) => { assert.equal(options.validateInput('Nome Ruim'), 'Ex.: minha-skill'); assert.equal(options.validateInput('ok'), undefined); return 'nova-proj'; }, () => 'Quando testar');
  await c.instance.handle('skills.create', undefined, 'project');
  assert.equal(fs.existsSync(path.join(roots.projectDir, 'nova-proj', SKILL_FILE)), true);
  inputs.push(() => 'nova-global', () => '');
  await c.instance.handle('skills.create', undefined, 'qualquer-coisa-vira-global');
  assert.equal(fs.existsSync(path.join(roots.globalDir, 'nova-global', SKILL_FILE)), true);
  inputs.push(() => 'nova-global', () => 'de novo');
  await c.instance.handle('skills.create', undefined, 'global');
  assert.equal(c.errors.length, 1);
  assert.match(c.errors[0], /^Skills: /);
  inputs.push(() => undefined);
  await c.instance.handle('skills.create', undefined, 'global');
  inputs.push(() => 'cancelada', () => undefined);
  await c.instance.handle('skills.create', undefined, 'global');
  assert.equal(fs.existsSync(path.join(roots.globalDir, 'cancelada')), false);
});

test('sem pasta aberta não há skills do projeto nem criação no projeto', async (t) => {
  const roots = setupRoots(t);
  const c = controller(t, { config: roots.config });
  await c.instance.post();
  assert.equal(c.last().hasProject, false);
  assert.equal(c.last().skills.some((s) => s.scope === 'project'), false);
  await c.instance.handle('skills.create', undefined, 'project');
  assert.match(c.warnings[0], /Abra uma pasta/);
});

test('com várias pastas, as skills de cada uma aparecem com a pasta e a criação vai para a escolhida', async (t) => {
  const roots = setupRoots(t);
  const second = path.join(path.dirname(roots.project), 'segunda');
  writeSkill(path.join(second, '.claude', 'skills'), 'proj-a', '---\nname: proj-a\n---');
  const answers = { folder: () => ({ uri: { fsPath: second } }), input: [() => 'nova', () => 'quando usar'] };
  const c = controller(t, { config: roots.config, projects: [roots.project, second], answers });
  await c.instance.post();
  assert.deepEqual(c.last().skills.filter((s) => s.scope === 'project').map((s) => [s.id, s.folder]),
    [['project:proj-a', 'projeto'], ['project:proj-a@1', 'segunda']]);
  await c.instance.handle('skills.create', undefined, 'project');
  assert.equal(fs.existsSync(path.join(second, '.claude', 'skills', 'nova', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(roots.projectDir, 'nova')), false);
  assert.deepEqual(c.errors, []);
});
