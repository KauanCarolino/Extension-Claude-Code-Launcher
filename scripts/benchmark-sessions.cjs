'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

function load(filename, directory) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require, Buffer,
    process: { env: { CLAUDE_CONFIG_DIR: directory } } }, { filename });
  return module.exports;
}
async function sample(work) {
  const start = performance.now();
  const probe = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0));
  const result = await work();
  const elapsedMs = performance.now() - start;
  return { result, elapsedMs, timerProbeMs: await probe };
}
async function main() {
  const args = process.argv.slice(2);
  if (!args[0] || args.length > 2) throw new Error('Uso: node scripts/benchmark-sessions.cjs relatorio.json [baseline-sessions.js]');
  const currentPath = path.resolve(__dirname, '../out/sessions.js');
  const baselinePath = args[1] && path.resolve(args[1]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-benchmark-'));
  try {
    const report = {
      kind: 'paired synthetic session listing; no personal transcripts',
      node: process.version, platform: process.platform, arch: process.arch,
      policy: { maxConcurrentStats: 8, maxSessionFiles: 10000, maxTitleCandidates: 256, cacheEntries: 1000 },
      method: 'Five sequential samples per size/implementation; first module cache cold, subsequent warm. OS cache not cleared. Timer probe includes scheduler overhead, not an SLA. Paired runs share files with unique mtimes.',
      modules: Object.fromEntries([['current', currentPath], ['baseline', baselinePath]].filter(([, file]) => file)
        .map(([name, file]) => [name, { filename: path.basename(file), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }])),
      results: [],
    };
    for (const files of [15, 1000, 5000]) {
      const current = load(currentPath, directory), baseline = baselinePath && load(baselinePath, directory);
      const workspace = '/synthetic/' + files, dir = current.sessionsDir(workspace);
      fs.mkdirSync(dir, { recursive: true });
      for (let n = 0; n < files; n++) {
        const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, file = path.join(dir, id + '.jsonl');
        fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'Synthetic conversation ' + n } }) + '\n');
        fs.utimesSync(file, 100000 + n, 100000 + n);
      }
      const row = { files, current: [], baseline: [], equivalent: baseline ? true : null };
      let expected;
      if (baseline) {
        for (let n = 0; n < 5; n++) {
          const measured = await sample(() => baseline.listSessions(workspace, 15));
          expected = JSON.stringify(measured.result);
          row.baseline.push({ elapsedMs: measured.elapsedMs, timerProbeMs: measured.timerProbeMs });
        }
      }
      for (let n = 0; n < 5; n++) {
        const measured = await sample(() => current.listSessionsAsync(workspace, 15));
        assert.equal(measured.result.sessions.length, 15); assert.equal(measured.result.partial, false);
        if (expected) assert.equal(JSON.stringify(measured.result.sessions), expected, 'Result changed from baseline');
        row.current.push({ elapsedMs: measured.elapsedMs, timerProbeMs: measured.timerProbeMs, scanned: measured.result.scanned });
      }
      report.results.push(row);
    }
    const output = path.resolve(args[0]); fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ report: output, results: report.results.map(row => ({ files: row.files, equivalent: row.equivalent,
      currentMs: row.current.map(x => Number(x.elapsedMs.toFixed(2))), baselineMs: row.baseline.map(x => Number(x.elapsedMs.toFixed(2))),
      currentProbeMs: row.current.map(x => Number(x.timerProbeMs.toFixed(2))), baselineProbeMs: row.baseline.map(x => Number(x.timerProbeMs.toFixed(2))) })) }, null, 2));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
