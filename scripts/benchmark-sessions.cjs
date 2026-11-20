'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');

function load(filename, directory) {
  const module = { exports: {} };
  const calls = {}; let bytesRead = 0;
  const count = key => { calls[key] = (calls[key] || 0) + 1; };
  const promises = new Proxy(fs.promises, { get(target, key) {
    const value = target[key]; if (typeof value !== 'function') return value;
    return (...args) => { count('async.' + String(key)); const result = value.apply(target, args);
      return key === 'open' ? result.then(handle => new Proxy(handle, { get(item, name) {
        const method = Reflect.get(item, name, item); if (typeof method !== 'function') return method;
        return async (...values) => { count('handle.' + String(name)); const output = await method.apply(item, values); if (name === 'read') bytesRead += output.bytesRead; return output; };
      } })) : result;
    };
  } });
  const observed = new Proxy(fs, { get(target, key) {
    if (key === 'promises') return promises;
    const value = target[key]; if (typeof value !== 'function' || /^[A-Z]/.test(String(key))) return value;
    return (...args) => { count('sync.' + String(key)); const result = value.apply(target, args); if (key === 'readSync') bytesRead += result; return result; };
  } });
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: name => ['fs', 'node:fs'].includes(name) ? observed : require(name), Buffer,
    process: { env: { CLAUDE_CONFIG_DIR: directory } } }, { filename });
  return { api: module.exports, metrics: () => ({ calls: { ...calls }, bytesRead }) };
}
async function sample(work, metrics) {
  global.gc?.(); const heapBefore = process.memoryUsage().heapUsed; const before = metrics();
  const start = performance.now();
  const probe = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0));
  const result = await work();
  const elapsedMs = performance.now() - start;
  const timerProbeMs = await probe;
  await new Promise(resolve => setImmediate(resolve)); global.gc?.();
  const after = metrics();
  return { result, elapsedMs, timerProbeMs, retainedHeapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
    bytesRead: after.bytesRead - before.bytesRead,
    ioCalls: Object.fromEntries(Object.entries(after.calls).map(([key, value]) => [key, value - (before.calls[key] || 0)])) };
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--worker') {
    const [, filename, directory, workspacesJson, strategy, fileCount] = args;
    const { api, metrics } = load(filename, directory); const workspaces = JSON.parse(workspacesJson); const samples = [];
    for (let n = 0; n < 5; n++) {
      const coverage = [];
      const measured = await sample(async () => {
      const results = [];
      for (const workspace of workspaces) {
        if (strategy === 'async') {
          const listing = await api.listSessionsAsync(workspace, 15);
          assert.equal(listing.partial, false, 'These bounded fixtures must be fully enumerable');
          assert.equal(listing.total, Number(fileCount));
          assert(Number.isInteger(listing.scanned) && listing.scanned <= 256);
          coverage.push({ partial: listing.partial, scanned: listing.scanned, total: listing.total }); results.push(listing.sessions);
        } else results.push(api.listSessions(workspace, 15));
      }
      return results;
      }, metrics);
      measured.coverage = strategy === 'async' ? coverage : null;
      samples.push(measured);
    }
    console.log(JSON.stringify(samples)); return;
  }
  if (!args[0] || args.length > 2) throw new Error('Uso: node scripts/benchmark-sessions.cjs relatorio.json [baseline-sessions.js]');
  const currentPath = path.resolve(__dirname, '../out/sessions.js');
  const baselinePath = args[1] && path.resolve(args[1]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-benchmark-'));
  try {
    const report = {
      kind: 'paired synthetic session listing; no personal transcripts',
      node: process.version, platform: process.platform, arch: process.arch,
      environment: { osRelease: os.release(), cpuModel: os.cpus()[0]?.model ?? 'unknown', logicalCores: os.cpus().length,
        totalMemoryBytes: os.totalmem(), loadAverageAtStart: os.loadavg() },
      policy: { maxConcurrentStats: 8, maxSessionFiles: 10000, maxTitleCandidates: 256, cacheEntries: 1000 },
      method: 'A fresh --expose-gc Node process per size/implementation; five sequential samples (one cold application cache plus four warm). Baseline process runs first, then current; OS cache is not cleared or randomized. Same synthetic files with unique mtimes; two roots, missing titles and >768KiB transcripts. IO forwarded to real fs; counts and bytes read measured. Retained heap is process heap after explicit GC, includes result arrays and scheduler noise. No percentile or SLA claim.',
      modules: Object.fromEntries([['current', currentPath], ['baseline', baselinePath]].filter(([, file]) => file)
        .map(([name, file]) => [name, { filename: path.basename(file), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }])),
      results: [],
    };
    for (const files of [15, 1000, 5000]) {
      const current = load(currentPath, directory).api;
      const workspaces = ['/synthetic/' + files + '/a', '/synthetic/' + files + '/b'];
      for (const workspace of workspaces) {
      const dir = current.sessionsDir(workspace); fs.mkdirSync(dir, { recursive: true });
      for (let n = 0; n < files; n++) {
        const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, file = path.join(dir, id + '.jsonl');
        const content = n % 7 === 0 ? JSON.stringify({ type: 'assistant', message: { content: 'Synthetic, no title' } }) + '\n'
          : JSON.stringify({ type: 'user', message: { content: 'Synthetic conversation ' + n } }) + '\n';
        fs.writeFileSync(file, content + (n === files - 2 ? JSON.stringify({ type: 'synthetic-padding', padding: 'x'.repeat(800 * 1024) }) + '\n' : ''));
        fs.utimesSync(file, 100000 + n, 100000 + n);
      }
      }
      const row = { filesPerRoot: files, roots: workspaces.length, current: [], baseline: [], equivalent: baselinePath ? true : null };
      let expected;
      const worker = (file, strategy) => {
        const result = spawnSync(process.execPath, ['--expose-gc', __filename, '--worker', file, directory, JSON.stringify(workspaces), strategy, String(files)], { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
        if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Benchmark child failed');
        return JSON.parse(result.stdout);
      };
      if (baselinePath) {
        row.baseline = worker(baselinePath, 'sync'); expected = JSON.stringify(row.baseline[0].result);
        for (const measured of row.baseline) assert.equal(JSON.stringify(measured.result), expected, 'Baseline changed between cold/warm samples');
      }
      row.current = worker(currentPath, 'async');
      for (const measured of row.current) {
        if (expected) assert.equal(JSON.stringify(measured.result), expected, 'Result changed from baseline');
        assert.equal(measured.result.length, 2); assert(measured.result.every(items => items.length > 0 && items.length <= 15));
      }
      for (const samples of [row.current, row.baseline]) for (const measured of samples) {
        measured.resultSha256 = crypto.createHash('sha256').update(JSON.stringify(measured.result)).digest('hex'); delete measured.result;
      }
      report.results.push(row);
    }
    const output = path.resolve(args[0]); fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ report: output, results: report.results.map(row => ({ filesPerRoot: row.filesPerRoot, roots: row.roots, equivalent: row.equivalent,
      currentMs: row.current.map(x => Number(x.elapsedMs.toFixed(2))), baselineMs: row.baseline.map(x => Number(x.elapsedMs.toFixed(2))),
      currentProbeMs: row.current.map(x => Number(x.timerProbeMs.toFixed(2))), baselineProbeMs: row.baseline.map(x => Number(x.timerProbeMs.toFixed(2))) })) }, null, 2));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
