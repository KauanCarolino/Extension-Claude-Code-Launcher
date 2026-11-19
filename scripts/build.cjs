'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
// out/ contains only generated files. A fresh build must not package stale modules.
fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
const result = spawnSync(process.execPath, [
  path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', root, '--noEmitOnError',
], { cwd: root, stdio: 'inherit', shell: false });
if (result.error) {
  console.error(`Não foi possível executar o compilador: ${result.error.message}`);
}
process.exitCode = result.status ?? 1;
