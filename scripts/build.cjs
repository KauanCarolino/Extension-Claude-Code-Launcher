'use strict';

// Compilação: `tsc` gera out/ (módulos usados pelos testes e checagem de tipos) e o esbuild junta
// a extensão num arquivo só, dist/extension.js, que é o que o pacote leva. Um arquivo só carrega
// mais rápido na ativação do que dezenas de módulos.
// Uso: `node scripts/build.cjs` (compilação limpa) ou `node scripts/build.cjs --watch` (desenvolvimento).

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const bundle = {
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  outfile: path.join(root, 'dist', 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // O Extension Host do VS Code 1.94 roda Node 20.
  target: 'node20',
  external: ['vscode'],
  sourcemap: watch ? 'linked' : false,
  logLevel: 'warning',
  absWorkingDir: root,
};

async function main() {
  // out/ e dist/ contêm só arquivos gerados. Uma compilação limpa não pode empacotar módulos antigos.
  for (const directory of ['out', 'dist']) { fs.rmSync(path.join(root, directory), { recursive: true, force: true }); }
  const esbuild = require('esbuild');
  if (watch) {
    // A saída do tsc vai direto para o terminal: a tarefa do editor reconhece os erros por ela.
    spawn(process.execPath, [tsc, '-watch', '-p', root], { cwd: root, stdio: 'inherit', shell: false });
    const context = await esbuild.context(bundle);
    await context.watch();
    return;
  }
  const result = spawnSync(process.execPath, [tsc, '-p', root, '--noEmitOnError'], { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) {
    console.error(`Não foi possível executar o compilador: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }
  await esbuild.build(bundle);
}

main().catch((error) => {
  console.error(`Não foi possível gerar o pacote da extensão: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
