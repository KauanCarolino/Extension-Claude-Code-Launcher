'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { verifyPackage } = require('../../scripts/verify-package.cjs');

const root = path.resolve(__dirname, '../..');
const cli = path.join(root, 'node_modules/@vscode/vsce/vsce');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-package-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ['package.json', 'package.nls.json', 'package.nls.pt-br.json', '.vscodeignore', 'tsconfig.json', 'LICENSE', 'README.md', 'CHANGELOG.md']) {
    await fs.copyFile(path.join(root, name), path.join(directory, name));
  }
  for (const name of ['media', 'hooks', 'scripts', 'l10n']) {
    await fs.cp(path.join(root, name), path.join(directory, name), { recursive: true });
  }
  // A minimal source fixture keeps this gate independent of concurrent runtime work.
  await fs.mkdir(path.join(directory, 'src'));
  await fs.writeFile(path.join(directory, 'src/extension.ts'),
    'export function activate() { return "fresh-package-sentinel"; }\n');
  await fs.mkdir(path.join(directory, 'docs/prds'), { recursive: true });
  await fs.writeFile(path.join(directory, 'docs/prds/local.md'), 'Local planning must not ship.');
  await fs.mkdir(path.join(directory, 'test'), { recursive: true });
  await fs.writeFile(path.join(directory, 'test/private.txt'), 'Test fixture must not ship.');
  await fs.symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  return directory;
}

function pack(directory, artifact) {
  return spawnSync(process.execPath, [cli, 'package', '--out', artifact, '--no-dependencies'], {
    cwd: directory, encoding: 'utf8', timeout: 120000, shell: false,
    env: { ...process.env, npm_config_ignore_scripts: 'false' },
  });
}

test('package compila uma árvore limpa e exclui documentos locais e testes', async t => {
  const directory = await fixture(t);
  const artifact = path.join(directory, 'candidate.vsix');
  const result = pack(directory, artifact);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = await verifyPackage(artifact, directory);
  assert.equal(report.runtimeMatchesSource, true);
  assert(report.entries.every(entry => !/\/(docs|scripts|test|node_modules)\//.test(entry.name)));
  assert(report.entries.some(entry => entry.name === 'extension/changelog.md'));
  assert.match(await fs.readFile(path.join(directory, 'dist/extension.js'), 'utf8'), /fresh-package-sentinel/);
  assert(!report.entries.some(entry => entry.name.startsWith('extension/out/')), 'o pacote leva só o bundle, não os módulos do tsc');
});

test('package substitui saída antiga e não aprova artefato após erro de compilação', async t => {
  const directory = await fixture(t);
  const artifact = path.join(directory, 'candidate.vsix');
  for (const output of ['out', 'dist']) {
    await fs.mkdir(path.join(directory, output));
    await fs.writeFile(path.join(directory, output, 'extension.js'), 'module.exports = "obsolete";');
    await fs.writeFile(path.join(directory, output, 'removed-module.js'), 'module.exports = "stale";');
  }
  let result = pack(directory, artifact);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = await verifyPackage(artifact, directory);
  assert(!report.entries.some(entry => entry.name.endsWith('removed-module.js')));
  await fs.rm(artifact);
  await fs.writeFile(path.join(directory, 'src/extension.ts'), 'const invalid: number = "not a number";\n');
  result = pack(directory, artifact);
  assert.notEqual(result.status, 0);
  await assert.rejects(fs.access(artifact));
});
