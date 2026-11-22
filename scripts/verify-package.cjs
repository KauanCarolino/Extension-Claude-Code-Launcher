'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const yauzl = require('yauzl');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES = 64 * 1024 * 1024;

// Inspect the actual artifact without extracting or executing its contents.
function readArchive(filename) {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      const files = new Map();
      let total = 0;
      let count = 0;
      let finished = false;
      const fail = error => {
        if (finished) return;
        finished = true;
        zip.close();
        reject(error);
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (!finished) {
          finished = true;
          resolve(files);
        }
      });
      zip.on('entry', entry => {
        const name = entry.fileName;
        if (++count > 5000 || entry.uncompressedSize > MAX_BYTES ||
            name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') ||
            ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) {
          return fail(new Error('Entrada inválida ou acima do limite no VSIX.'));
        }
        if (name.endsWith('/')) return zip.readEntry();
        if (files.has(name)) return fail(new Error('Entrada duplicada no VSIX: ' + name));
        total += entry.uncompressedSize;
        if (total > MAX_BYTES) return fail(new Error('VSIX excede o limite de inspeção de 64 MiB.'));
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          const chunks = [];
          let size = 0;
          stream.on('error', fail);
          stream.on('data', chunk => {
            size += chunk.length;
            if (size > entry.uncompressedSize || size > MAX_BYTES) {
              stream.destroy(new Error('Tamanho descompactado inconsistente.'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('end', () => {
            if (finished) return;
            files.set(name, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function sourceFiles(root, directory) {
  const result = [];
  const visit = async relative => {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = relative + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Runtime não pode depender de symlink: ' + next);
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile() && !entry.name.startsWith('.')) result.push(next);
    }
  };
  await visit(directory);
  return result;
}

async function verifyPackage(filename, root = path.resolve(__dirname, '..')) {
  const files = await readArchive(filename);
  for (const required of ['[Content_Types].xml', 'extension.vsixmanifest', 'extension/package.json']) {
    assert(files.has(required), 'Arquivo obrigatório ausente: ' + required);
  }
  const sourceManifest = await fs.readFile(path.join(root, 'package.json'));
  const expectedManifest = JSON.parse(sourceManifest.toString('utf8'));
  const packagedManifest = JSON.parse(files.get('extension/package.json').toString('utf8'));
  assert.deepEqual(packagedManifest, expectedManifest, 'Manifesto do pacote difere da fonte.');
  assert.equal(packagedManifest.publisher + '.' + packagedManifest.name, 'KauanDeveloper.launcher-for-claude-code');

  const expected = new Map([
    ['extension/package.json', 'package.json'],
    ['extension/readme.md', 'README.md'],
    ['extension/LICENSE.txt', 'LICENSE'],
  ]);
  // Traduções do manifesto (package.nls*.json) vão na raiz do pacote, como o package.json.
  for (const name of await fs.readdir(root)) {
    if (/^package\.nls(\.[a-z-]+)?\.json$/.test(name)) expected.set('extension/' + name, name);
  }
  // vsce ships the changelog when the project has one; it must then match the source too.
  try { await fs.access(path.join(root, 'CHANGELOG.md')); expected.set('extension/changelog.md', 'CHANGELOG.md'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const directory of ['out', 'media', 'hooks', 'l10n']) {
    for (const relative of await sourceFiles(root, directory)) {
      if (directory === 'out' && !relative.endsWith('.js')) continue;
      expected.set('extension/' + relative, relative);
    }
  }
  const main = 'extension/' + packagedManifest.main.replace(/^\.\//, '');
  assert(expected.has(main), 'Entrypoint declarado não está na saída atual.');
  for (const [entry, relative] of expected) {
    assert(files.has(entry), 'Arquivo do runtime ausente: ' + entry);
    const current = await fs.readFile(path.join(root, relative));
    assert(current.equals(files.get(entry)), 'Conteúdo obsoleto ou diferente: ' + entry);
  }
  const containers = new Set(['[Content_Types].xml', 'extension.vsixmanifest']);
  for (const entry of files.keys()) {
    assert(containers.has(entry) || expected.has(entry), 'Conteúdo inesperado no VSIX: ' + entry);
  }
  return {
    artifact: path.basename(filename),
    sha256: sha256(await fs.readFile(filename)),
    version: packagedManifest.version,
    vscode: packagedManifest.engines.vscode,
    sourceManifestSha256: sha256(sourceManifest),
    entries: [...files].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha256(bytes) })),
    runtimeMatchesSource: true,
  };
}

module.exports = { readArchive, verifyPackage };

if (require.main === module) {
  const filename = process.argv[2];
  if (!filename || process.argv.length !== 3) {
    console.error('Uso: npm run verify:package -- /caminho/extensao.vsix');
    process.exitCode = 1;
  } else {
    verifyPackage(path.resolve(filename))
      .then(report => console.log(JSON.stringify(report, null, 2)))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
