'use strict';

// Instala a versão atual da extensão oficial Claude Code numa pasta isolada, com o CLI de um
// VS Code baixado na versão exata pedida, e imprime `directory=<pasta da extensão>` para o
// GitHub Actions. Usado só pela verificação semanal de compatibilidade (compat.yml).

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { cliScript, provisionEditor, run } = require('./host-tooling.cjs');

const OFFICIAL_ID = 'anthropic.claude-code';

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index], value = argv[index + 1];
    if (!['--download-version', '--extensions-dir'].includes(name) || !value || value.startsWith('--')) throw new Error('Argumento inválido: ' + name);
    options[name.slice(2)] = value; index += 1;
  }
  if (!/^\d+\.\d+\.\d+$/.test(options['download-version'] || '')) throw new Error('--download-version exige uma versão exata do VS Code.');
  if (!options['extensions-dir']) throw new Error('Informe --extensions-dir.');
  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const extensions = path.resolve(options['extensions-dir']);
  await fs.mkdir(extensions, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-official-'));
  try {
    const executable = await provisionEditor(options, temporary);
    const profile = path.join(temporary, 'profile');
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const result = await run(executable, [cliScript(executable), '--user-data-dir', profile, '--extensions-dir', extensions,
      '--install-extension', OFFICIAL_ID, '--force'], env, { timeout: 180000 });
    if (result.code !== 0 || result.timedOut) throw new Error('A instalação da extensão oficial falhou:\n' + result.output.slice(-4000));
    const installed = [];
    for (const name of await fs.readdir(extensions)) {
      if (!name.toLowerCase().startsWith(OFFICIAL_ID + '-')) continue;
      const manifest = JSON.parse(await fs.readFile(path.join(extensions, name, 'package.json'), 'utf8'));
      if ((manifest.publisher + '.' + manifest.name).toLowerCase() === OFFICIAL_ID) installed.push({ directory: path.join(extensions, name), version: manifest.version });
    }
    if (installed.length !== 1) throw new Error('Esperava exatamente uma instalação da extensão oficial; encontrei ' + installed.length + '.');
    console.log('directory=' + installed[0].directory);
    console.log('version=' + installed[0].version);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
