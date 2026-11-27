# orquestra

A local CLI that takes a request and drives Claude Code and Codex, each through the subscription login of the person running it, to a branch with a passing project test. The orchestrator owns the flow: it plans, routes each step, commits, runs the test and (from phase 4) opens the PR. The models only execute the step they are handed.

It lives outside the extension's `src/`, so the launcher release does not depend on it. It is excluded from the `.vsix` and from the extension's lint.

## Status: phases 0 to 4 (Claude and Codex, up to the PR)

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
- `orquestra providers` reports whether each CLI and `gh` is ready, without calling a model.
- Phase 3, the Codex adapter (`src/providers/codex.ts`) and the quota texts:
  - **How it runs:** `codex exec --json --ephemeral --color never --sandbox <mode> -c approval_policy=never -`. The `-` makes Codex read the prompt from stdin.
  - **Planner:** `--sandbox read-only`. **Worker:** `--sandbox workspace-write`, which allows writes only inside the repository and has no network.
  - **Differences from Claude:** `codex exec` has no turn limit, so `modelTimeoutSec` is the only cap on a call. Codex also cannot filter shell commands by pattern, so `allowBash` does not apply to it: its shell is limited by the sandbox instead. Commits made by the worker and files outside the step are still caught and stop the job, just as with Claude.
  - **Startup check:** it reads `codex --version`, then probes the flags with a fake one, as the Claude adapter does. It then runs `codex login status`. It refuses to run when Codex is not logged in, or when it is logged in with an API key instead of a ChatGPT plan.
  - **Binary lookup:** `ORQUESTRA_CODEX_BIN`, then `PATH`, then the binary bundled with the Codex extension (`openai.chatgpt-*`) in VS Code or Cursor.
  - **Subscription only:** `OPENAI_API_KEY` and `CODEX_API_KEY` are removed from the worker's environment, unless `ORQUESTRA_ALLOW_API_KEY=1`.
  - **Usage:** the tokens from the `turn.completed` events are added to `status`.
  - **Quota:** `fixtures/quota/claude/` and `fixtures/quota/codex/` hold the start of each CLI's own limit message, such as `You've hit your 5-hour limit` and `You’ve hit your usage limit.`. They come from the Claude Code 2.1.331 binary and from the Codex source code, not from a captured run (see `fixtures/quota/README.md`). Capacity errors and generic words such as `429` are still task failures.
- Phase 4, the PR (`src/pr.ts`):
  - With `--pr`, after the test passes, the orchestrator runs `git push --set-upstream <remote> <branch>` without `--force`, then `gh pr create --base <baseBranch> --head <branch> --body-file -`. The worker never runs `git` or `gh`.
  - The PR title is the goal of the plan. The body lists the request, each step with its commit and model, the repairs, and the test result.
  - It refuses before planning when `gh` is missing or not logged in, so no quota is spent on a PR that cannot open.
  - If the push or `gh` fails, the job stays `passed` with the reason in `status`. `orquestra resume <id> --pr` tries the PR again without calling a model or rerunning the test. A PR already open for the branch is reused, never duplicated.

- Phase 5, the **Orchestrator** tab in the launcher sidebar (`src/orchestra.ts`, `src/orchestra-view.ts`, `media/orchestra.js`):
  - You type the request in the tab and pick the planner model. **Plan** runs `orquestra plan --stdin`, so the text reaches the CLI through stdin, never through argv or a shell.
  - The plan shows up as a card. **Confirm and run** runs `resume <id> --yes`, with `--pr` when "Open a PR at the end" is checked. **Discard plan** runs `drop <id>`, which only works before any edit.
  - While a command runs, the tab shows the live log and a **Stop** button. Stop sends SIGTERM (`taskkill /T` on Windows). The CLI then kills the model and the test it started and exits with code 130. Afterwards, **Resume** or **Resume, discarding leftovers** continues the job.
  - The job cards read `.orquestra/jobs/*.json` directly and redraw when those files change. Every log goes to the **Orquestra** output channel.
  - The tab looks for the CLI in this order: the `claudeCodeLauncher.orchestrator.cliPath` setting (machine scope only, so a project cannot point it at another program), then `orchestrator/out/src/cli.js` next to the extension (development), then `orquestra` on `PATH` (`npm link`). The `.vsix` does not carry the orchestrator, so an installed extension needs one of the other two.
  - The extension never runs `git` or `gh` itself. Only the CLI does.

Not yet:

- Quota texts captured from real runs, to confirm the ones taken from the CLIs.

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
orquestra resume [id] [--yes] [--discard] [--pr]
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
  "deny": ["**/.env", "**/*.pem", "**/*credential*"],
  "remote": "origin",
  "prDraft": false
}
```

- A string command runs through the system shell. A list runs directly, without re-quoting.
- `deny` adds to the built-in secret list and cannot remove entries from it.
- `maxRepairCycles` is capped at 2.
- `allowBash` lists the commands the Claude worker may run to look at one error. It cannot include `git` or `gh`. Leave it empty and the Claude worker has no shell. It does not apply to Codex (see above).
- `remote` is where `--pr` pushes the branch. `prDraft: true` opens the PR as a draft.

Calibration lives in `~/.orquestra/calibration.json`, or `$ORQUESTRA_HOME`.
