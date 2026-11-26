# orquestra

A local CLI that takes a request and drives Claude Code and Codex, each through the subscription login of the person running it, to a branch with a passing project test. The orchestrator owns the flow: it plans, routes each step, commits, runs the test and (from phase 4) opens the PR. The models only execute the step they are handed.

It lives outside the extension's `src/`, so the launcher release does not depend on it. It is excluded from the `.vsix` and from the extension's lint.

## Status: phase 1 (Claude end to end)

Done:

- Phase 0, the contract:
  - Job schema (`.orquestra/jobs/<id>.json`, kept out of git via `.git/info/exclude`) and the `orquestra/<id>-<slug>` branch.
  - One step equals one commit, tagged with `Orquestra-Job` / `Orquestra-Step` trailers. Resume reads the branch: if the commit is there, the step is done.
  - The `Provider` interface, and a fake provider that stays in the tests.
  - Quota switch or pause, with quota wait counted apart from model time.
  - At most two repairs, then `needs_human`.
  - Safety checks: dirty tree, deny list, files outside the step, commits the worker made itself, and a lock against two concurrent runs.
- Phase 1, the Claude adapter (`src/providers/claude.ts`):
  - **How it runs:** `claude -p --output-format json --max-turns N --no-session-persistence --permission-prompts none`. The prompt goes through stdin, never argv, so neither PowerShell nor `cmd.exe` re-quotes it.
  - **Planner:** `--permission-mode dontAsk --tools Read,Glob,Grep`. It has no write tool at all.
  - **Worker:** `--permission-mode acceptEdits --tools Read,Edit,Write,Glob,Grep`. It gets Bash only for the patterns in `allowBash`, and `Bash(git *)` and `Bash(gh *)` are always denied.
  - **Startup check:** it reads `claude --version` and refuses majors other than 2.x. It then probes every flag it uses together with a fake one. The parser fails on the fake flag before any model call, so a renamed flag gets a clear refusal and costs no quota.
  - **Binary lookup:** `ORQUESTRA_CLAUDE_BIN`, then `PATH`, then `~/.local/bin`, then the binary bundled with the Claude Code extension in VS Code or Cursor (the newest version wins).
  - **Subscription only:** `ANTHROPIC_API_KEY` is removed from the worker's environment, unless `ORQUESTRA_ALLOW_API_KEY=1`. The markers of an outer Claude Code session (`CLAUDECODE` etc.) are removed too.
  - **Usage:** the tokens the CLI reports are shown in `status`, next to the local estimate. Neither one is your bill.
  - **Failed calls:** the raw output of every failed call is kept in `.orquestra/jobs/<id>.runs/`. That is where a real quota message is copied from to become a fixture (see `fixtures/quota/README.md`).
- `orquestra providers` reports each CLI's readiness without calling a model.

Not yet:

- The `codex` adapter and the real quota fixtures (phase 3). Until then nothing Claude prints counts as quota: every failure is a task failure.
- `--pr` / `gh pr create` (phase 4) and the editor command (phase 5).

## Use

```
npm run test:orchestrator          # from the repository root
cd orchestrator && npm run build   # builds out/src/cli.js
node orchestrator/out/src/cli.js plan "<request>"
```

```
orquestra providers
orquestra plan "<request>" [--provider claude|codex]
orquestra run "<request>" [--yes] [--pr] [--provider claude|codex]
orquestra status [id]
orquestra resume [id] [--yes] [--discard]
orquestra list
```

`resume --discard` drops uncommitted leftovers from an interrupted step. It only works while you are on the job's own branch.

## `.orquestra/project.json` (committed)

```json
{
  "test": "npm test",
  "check": "npm run typecheck",
  "baseBranch": "main",
  "maxRepairCycles": 2,
  "testTimeoutSec": 900,
  "modelTimeoutSec": 1800,
  "allowBash": ["npm test -- *"],
  "defaultProvider": "claude",
  "deny": ["**/.env", "**/*.pem", "**/*credential*"]
}
```

- A string command runs through the system shell. A list runs directly, without re-quoting.
- `deny` adds to the built-in secret list and cannot remove entries from it.
- `maxRepairCycles` is capped at 2.
- `allowBash` lists the commands the worker may run to look at one error. It cannot include `git` or `gh`. Leave it empty and the worker has no shell.

Calibration lives in `~/.orquestra/calibration.json`, or `$ORQUESTRA_HOME`.
