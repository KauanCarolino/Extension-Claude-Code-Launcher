'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { run } = require('./host-tooling.cjs');

// Public CLI mode documented to exit before starting a conversation:
// https://code.claude.com/docs/en/cli-reference#cli-flags
// https://code.claude.com/docs/en/hooks#setup
// Setup observations do not prove PreToolUse/PostToolUse or model execution.
exports.probeOfficialHooks = async ({ binary, env, workspace, temporary, hooksModulePath }) => {
  const directory = path.join(temporary, 'hook fixture with spaces'); await fs.mkdir(directory);
  const script = path.join(directory, 'launcher-record-change.js');
  await fs.writeFile(script, `'use strict';
const fs=require('node:fs');const path=require('node:path');let input='';
process.stdin.on('data',data=>{input+=data;if(input.length>65536)process.exit(8);});
process.stdin.on('end',()=>{
 const event=JSON.parse(input);const mode=process.env.LAUNCHER_HOOK_PROBE_MODE;
 const receipt=path.join(process.env.LAUNCHER_HOOK_PROBE_DIR,mode+'.json');
 fs.writeFileSync(receipt,JSON.stringify({event:event.hook_event_name,trigger:event.trigger,args:process.argv.slice(2),pid:process.pid,mode}));
 if(mode==='error')process.exit(7);
 if(mode==='timeout')setTimeout(()=>fs.writeFileSync(receipt+'.late','unexpected'),8000);
});
`);
  const { planHooks } = require(hooksModulePath);
  const plan = planHooks({ read: { kind: 'absent' }, scriptPath: script, enable: true, executable: process.execPath,
    capability: { status: 'confirmed', harness: 'official init-only Setup probe; distinct from capture events' } });
  assert.equal(plan.kind, 'ready');
  const handler = JSON.parse(plan.nextText).hooks.PreToolUse[0].hooks[0];
  assert.deepEqual(handler.args, [script, 'pre']);
  const checks = [];
  for (const mode of ['success', 'error', 'timeout']) {
    const settings = path.join(directory, mode + '-settings.json'); const debug = path.join(directory, mode + '-debug.log');
    await fs.writeFile(settings, JSON.stringify({ hooks: { Setup: [{ matcher: 'init', hooks: [{ ...handler, timeout: mode === 'timeout' ? 1 : handler.timeout }] }] } }));
    const start = performance.now();
    const result = await run(binary, ['--init-only', '--settings', settings, '--debug-file', debug], {
      ...env, LAUNCHER_HOOK_PROBE_MODE: mode, LAUNCHER_HOOK_PROBE_DIR: directory,
    }, { cwd: workspace, timeout: 20000 });
    const elapsedMs = performance.now() - start;
    assert.equal(result.timedOut, false, 'CLI itself must complete without a conversation');
    assert.equal(result.code, 0, 'Setup is nonblocking even when its local command fails');
    const receipt = JSON.parse(await fs.readFile(path.join(directory, mode + '.json'), 'utf8'));
    assert.equal(receipt.event, 'Setup'); assert.equal(receipt.trigger, 'init'); assert.deepEqual(receipt.args, ['pre']);
    const log = await fs.readFile(debug, 'utf8');
    let condition;
    if (mode === 'success') condition = 'separate executable/arguments reached Setup with a script path containing spaces';
    else if (mode === 'error') {
      assert(/\b(?:exit(?:ed)?(?: with)?(?: code)?|exitCode|code)[\s:=]+7\b/i.test(log), 'Official diagnostic must observe the command failure');
      condition = 'command exit 7 observed; Setup remains nonblocking';
    } else {
      assert(/\b(?:timed?\s+out|timeout after|aborted|AbortError)\b/i.test(log), 'Official diagnostic must observe timeout, not merely a fixture filename');
      const deadline = Date.now() + 3000; let alive = true;
      while (Date.now() < deadline && alive) {
        try { process.kill(receipt.pid, 0); await new Promise(resolve => setTimeout(resolve, 30)); }
        catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
      }
      assert.equal(alive, false, 'Timed-out hook process must terminate');
      await assert.rejects(fs.access(path.join(directory, mode + '.json.late')), { code: 'ENOENT' });
      condition = 'one-second hook timeout observed; child terminated before its delayed write';
    }
    checks.push({ mode, hookEvent: receipt.event, trigger: receipt.trigger, argsPreserved: true, cliExitCode: result.code, elapsedMs, condition });
  }
  return { status: 'passed', mode: '--init-only', checks,
    limits: 'Generated launcher command/args descriptor executed on synthetic Setup only. No prompt, print mode, model request, Edit/Write event or authenticated conversation.' };
};
