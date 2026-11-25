# Changelog

The project follows [Semantic Versioning](https://semver.org/) from 1.0.0 on. [Versão em português](https://github.com/KauanCarolino/Extension-Claude-Code-Launcher/blob/main/CHANGELOG.pt-BR.md).

## 1.3.0 — 2026-11-25

### Added

- Setting `claudeCodeLauncher.showStatusBarItem` (on by default) to hide the **Claude** item in the status bar.
- Changelog, reference and verification in English (`CHANGELOG.md`, `docs/REFERENCE.md` and `docs/VERIFICATION.md`). The Portuguese versions are in `CHANGELOG.pt-BR.md`, `docs/REFERENCIA.md` and `docs/VERIFICACAO.md`.

### Changed

- **Command capture:** the `.gitignore` files of every folder in the project now apply, not only the root one, with git's rules: negations (`!`), character classes (`[abc]`), folder-only patterns (`dir/`) and the last matching rule deciding. In monorepos, the build output of subprojects no longer shows up as changed by a command or uses up the 5,000-file limit. A pattern like `dist/` now applies only to folders, as in git; before, it also ignored a file named `dist`.
- The extension ships as a single file (`dist/extension.js`, built by esbuild) instead of one module per source file, which shortens activation. The VSIX no longer carries the 36 modules of `out/`.
- The list of conversations used to recognize the focused chat tab is reused across tab switches until a transcript changes (or for at most 30 s), instead of being read again on every switch.

### Internal

- `change-metadata.ts` (explanation and request read from the transcript), `review-resource.ts` (reading and writing the reviewed files) and `review-report.ts` (the notification with a decision's result) were split out of `ChangesController`. `changes-time.js` (dates) and `changes-diff.js` (diff lines) were split out of `media/changes.js`.
- `extension.ts`: one tab-change listener instead of two, and comments back on the functions they describe.
- Two timing-dependent tests sometimes failed on a loaded machine: the exit-with-error-after-the-report case (`host-runner.test.js`), whose grace period equaled the exit delay, and the tab switch (`catalogs.test.js`), which waited 300 ms for a 250 ms refresh plus disk reads. They now have headroom and wait for the condition.
- New tests for the `.gitignore` rules and for nested `.gitignore` files in `hook-turn.test.js`.
- The `lifecycle` contract instantiates the controller and the launcher view from the installed bundle (`dist/extension.js`) instead of the `out/` modules, which no longer ship.

## 1.2.9 — 2026-11-22

### Added

- **Command capture.** What terminal commands, MCP tools and generators change enters the review as **Changed by a command** (or **Created by a command**), with before and after, and can be accepted, rejected and undone like any edit. With the change log on, the launcher also installs handlers on `UserPromptSubmit`, which notes the project state and keeps copies of the text files, and on `Stop`, which compares and records what changed and was not explained by a captured edit. The request and the explanation come from the turn's last terminal call in the transcript. Left out: `.git`, `node_modules`, `.claude`, the root `.gitignore`, the privacy exclusions and binaries. Limits are 5,000 files, 4 s of walking and 200 changes per turn, and the copies use at most half of the budget and 2,000 files. New setting `claudeCodeLauncher.captureCommandChanges` (on by default); installations with the change log on get the new handlers through the automatic repair. With the capture configured, the terminal command notice no longer appears.
- **Permissions and Hooks tabs.** Permissions lists the `allow`/`ask`/`deny` rules from the local, project, user and organization `settings.json`, with the `defaultMode` and the rule overridden by a stronger type; it creates and removes rules in the first three. Hooks lists each handler with event, matcher, type and command without apparent secrets, and marks the launcher's own. Commands **Show Permissions** and **Show Hooks**.
- **Accept or reject the hunk at the cursor**, with `Alt+Shift+Y` and `Alt+Shift+N` (`Ctrl+Alt+Y` and `Ctrl+Alt+N` on macOS).
- **Accept request**, next to **Undo request**, for the files whose changes all came from that request.
- **Copy changes summary**: Markdown of the visible changes, grouped by request, with file, action, lines, state and Claude's explanation, ready for a PR description.
- Screenshots and GIF in the README, generated from the real view pages by `scripts/screenshots.cjs`.

### Changed

- **Remote windows.** The manifest declares `extensionKind: ["workspace"]`, the same place the official extension runs. In a remote window, **Reveal in file manager** reveals in the Explorer or copies the path, the capture diagnostics report the environment, and the lack of a trash (common in containers) stops the rejection of a created file with the reason `trashUnavailable`, without deleting permanently. The remote behavior is documented in `docs/REFERENCIA.md`; WSL, SSH and dev containers have no automated test.
- The tab bar of the launcher view became more compact so that seven tabs fit in the narrow sidebar.

### Fixed

- The hunk label in the diff ("linhas 3–9 (7 linhas)") stayed in Portuguese with the interface in English.
- **Cursor: the chat opened inside the Explorer.** Cursor rejects secondary sidebar containers, and the official extension's sidebar view ends up in the Explorer, next to Outline and Timeline. The **Claude** status bar item and the **Open chat in sidebar** command called that sidebar and also wrote `claudeCode.preferredLocation: "sidebar"`, so the official **✻ Claude Code** button also started opening in the Explorer. When the sidebar view exists but its container does not, the launcher shows the chat tab already open or opens a new one, and does not change the preference. In VS Code, and in versions before 1.106 (where the official extension uses the Activity Bar), nothing changes.

### Internal

- Hook: `runTurn` (phases `turn-start` and `turn-end`), `putBlob` shared with the per-edit capture, and precompiled globs. The hook writes nothing to its output, because `UserPromptSubmit` output would go to Claude.
- `hooks.ts` describes the handlers by event, phase and matcher; `inspectHookConfiguration` also reports `turn`. The full cleanup recognizes `turns/` and `turn-blobs/`, and maintenance collects turn manifests older than 7 days.
- New modules: `settings-catalog.ts` (permissions and hooks, with no editor dependency) and `remote.ts`.
- New tests: `hook-turn.test.js`, `turn-capture.test.js`, `review-conveniences.test.js`, `remote.test.js`, turn handler configuration in `hooks-config.test.js`, permissions and hooks in `catalogs.test.js` and the cursor shortcut in `inline.test.js`. The suite also passed in a `node:22-bookworm-slim` container with an unprivileged user.

## 1.2.0 — 2026-11-22

### Added

- **English interface.** The interface follows the editor's language: Portuguese when the editor is in Portuguese, English otherwise. The new setting `claudeCodeLauncher.language` (`auto`, `en`, `pt-br`) pins the language; with the editor in English, use `pt-br` to keep the interface as before. Command and setting titles come from `package.nls.json` (English) and `package.nls.pt-br.json`.
- **Getting started walkthrough**, with five steps that check themselves off: install Claude Code, open the folder, turn on the change log, start a new conversation and review. Command **Open the Walkthrough**, also in the `…` menu of the launcher view and in the invitation to turn on the change log.
- With the change log on and no hook event observed, the **Changes** panel shows **Change log on: start a new conversation**, with a **New conversation** button, instead of "No changes yet".
- **Terminal command notice.** The panel reads from the transcript the Bash and PowerShell commands Claude ran in the focused conversation (or in the conversations with pending changes) and warns when one of them may have changed files outside the capture, with the program names and a **Check in source control** shortcut. Recognized read-only commands do not count. Nothing new is installed in the hooks and the command text is not shown.
- **Multi-root workspaces** in the **Skills**, **Rules**, **Agents** and **MCP** tabs: the project sources are read from each local folder, each item shows its folder, and creating in the project asks which folder. Approving or rejecting a server from `.mcp.json` writes to its folder. With a single folder, nothing changes.
- Weekly workflow **Compatibility with latest editor and Claude Code** (`.github/workflows/compat.yml`): installs the VSIX and runs the hook journey and the `official` contract on the latest stable VS Code, with the current version of the official extension (`scripts/install-official-extension.cjs`).

### Changed

- Short README, in English, for the Marketplace page, with the Portuguese version in `README.pt-BR.md`. The full detail moved to `docs/REFERENCIA.md`.

### Internal

- `typecheck` now also checks the hook (`tsconfig.hooks.json`) and the view pages (`tsconfig.webview.json`), and `lint` covers `hooks/` and `media/`. A hook path that TypeScript did not see as a return got an explicit `return`, with no behavior change.
- `capture-setup.ts` (capture script, policy and handlers), `housekeeping.ts` (retention and collection) and `owned-file.ts` (atomic writes of the launcher's own data) were split out of `ChangesController`.
- Translation: `src/i18n.ts` and `media/l10n.js`, a dictionary in `l10n/en.json` and `scripts/l10n-check.cjs`, which lists untranslated phrases. The page receives `actionKind` so it does not depend on the translated action label.
- New tests: `test/l10n.test.js`, `test/shell-activity.test.js`, multi-root in `catalogs.test.js` and `skills.test.js`, and the panel rendered in English in `review-ui.test.js`.

## 1.1.0 — 2026-11-21

### Added

- **Rules**, **Agents** and **MCP** tabs in the launcher view, in the format of the **Skills** tab: search, source filters, creation and actions on each row.
  - **Rules:** `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/**/*.md` in the project and the global equivalents, plus the organization-managed `CLAUDE.md` (read-only). Shows the `paths` globs, enables and disables through `.md.disabled`, creates rules with optional `paths` and deletes to the trash.
  - **Agents:** `.claude/agents/` in the project and global, including subfolders. Shows `name`, description and `model`, marks a global agent overridden by a project agent with the same name, and enables, disables, creates and deletes like rules.
  - **MCP:** local, project (`.mcp.json`), user and organization servers, with transport, command or URL without apparent secrets, state (active, pending, rejected, disabled through `/mcp`, with error) and priority between scopes. For project servers, approves or rejects in `.claude/settings.local.json`, creates and removes in `.mcp.json`. `~/.claude.json` is only read, never written.
- Commands **Show Rules**, **Show Agents** and **Show MCP Servers**.

### Fixed

- The **Show Skills** and **Show Conversations and Changes** commands, from the palette, only hid or showed the **Changes** view: the launcher view stayed on the previous tab. Now it switches tabs too.
- **Skills:** the skill name was centered in the row and a long name was not truncated with an ellipsis.

### Internal

- Frontmatter moved to `src/frontmatter.ts`, shared by skills, rules and agents; `parseFrontmatter` is still exported by `skills.ts` with the same behavior.
- Tab switching (context `claudeCodeLauncher.panel`) moved from `skills-view.ts` to `catalog-view.ts`. The **Changes** view is visible when the context is absent or equal to `chats`.
- `multi-window` contract on macOS: the report passed, but the runner sent SIGTERM 500 ms later, while VS Code was still quitting by itself (the driver runs `workbench.action.quit`), and Electron aborted with SIGABRT. The runner now waits up to 10 s for the editor's own exit before terminating it. SIGABRT exits still fail. A test in `host-runner.test.js` reproduces the failure with the old wait.
- 18 new tests in `test/catalogs.test.js`, covering reading, conditional writing, the `paths` formats, secret hiding and the view controller with a simulated editor.

## 1.0.0 — 2026-11-20

First stable version. There is no new functionality compared with 0.13.1: this version closes what already existed, fixes the problems found in review and defines what is compatible within the 1.x series.

### Compatibility commitment (1.x)

Within the 1.x series, a new version does not remove or change the meaning of:

- the `claude-code-launcher.*` command IDs and the documented shortcuts;
- the `claudeCodeLauncher.*` settings, their accepted values and defaults;
- the versioned formats in `.claude/launcher-changes/` (`review-state.v1.json`, `review-blobs/v1/`, `purge-state.v1.json`, `capture-diagnostics/v2/`, `log.jsonl`, `meta.json` and `status.json`). A 1.x version reads the data written by any earlier 1.x version. When a format has to change, the new version migrates the data and keeps a backup in `review-migration-backups/`, and the changelog says whether downgrading is still possible;
- the `SKILL.md.disabled` convention used to disable skills.

Incompatible changes to these points only come in a 2.0.0 version. The look of the panels, the message texts and the unversioned internal files (`active/`, `pending/`, `completed/`, locks) are not part of the commitment.

### Identifier change: read before updating

The extension is now called **Launcher for Claude Code**, with the identifier `KauanDeveloper.launcher-for-claude-code`. The name `claude-code-launcher` (and the display name "Claude Code Launcher") already belongs to another, unrelated extension on the Visual Studio Marketplace. The publisher also changed, from `kauan` to `KauanDeveloper`. The editor treats 1.0.0 as a **different** extension from 0.x:

- Uninstall the previous version before installing 1.0.0: `kauan.claude-code-launcher` (up to 0.13.0) or `KauanDeveloper.claude-code-launcher` (local 0.13.1 package). Two versions writing to the same project are not supported.
- Commands, settings, the container and the view keep the IDs `claude-code-launcher.*` and `claudeCodeLauncher.*`; only the displayed name changes to **Launcher for Claude Code**, including the command category in the palette.
- The data in `.claude/launcher-changes/`, the hooks and the `claudeCodeLauncher.*` settings still apply, because they do not depend on the identifier. A legacy hook written to the old identifier's `globalStorage` is still recognized as the launcher's.
- Not carried over to 1.0.0, because the editor stores them per identifier: the **Undo last rejection** stack and the record of opening preferences set by editor group management. Before updating, finish pending undos and, if `claudeCodeLauncher.manageEditorGroups` is on, turn it off in the old version so it restores your original preferences.

### Fixed

- The host tests looked for the extension by the old identifier and failed on every system after the publisher change. They now read the identifier from `package.json`.
- **Skills:** a description with a backslash produced a `SKILL.md` with invalid YAML (for example, `C:\temp` became the escape sequence `\t`). Backslashes, quotes and control characters are now escaped or replaced.
- **Skills:** a `SKILL.md` saved with a BOM had its name and description ignored.
- **Skills:** the global folder ignored `CLAUDE_CONFIG_DIR`, which the conversation list already honored. With the variable set, global skills come from `$CLAUDE_CONFIG_DIR/skills`.
- **Skills:** enabling or disabling a skill changed outside the launcher showed a generic system error. It now explains the reason. claude.ai skills are also refused at the disk layer, not only in the interface.
- **Changes per conversation:** the panel could hide the changes of the conversation in use. Three cases were reproduced with the real code:
  - The official tab shows the generated title before the transcript records it. When that short title matched an old conversation's, the panel filtered by the old one and hid the current one.
  - In the sidebar chat, which is not a tab, the focus stayed stuck on the last tab used and the sidebar's changes disappeared.
  - Titles longer than 25 characters, which the tab truncates to 24 + "…", were never recognized, and the filter turned off without notice.

  Now the conversation is compared with every title it has had, including the first message, taking the tab's truncation into account, and is identified again when the transcript changes. With the filter on, only changes from conversations that another open tab identified stay hidden. Pending changes without an owner stay visible, with a notice, and with no chat tab the panel shows everything.
- **Changes per conversation:** with two or more conversations with the same title, the panel picked the most recent and hid the others' changes. It now shows all of them and says at the top how many conversations have that title.
- **Conversations:** the open-conversation mark used the same exact title comparison and failed for titles truncated by the tab.
- The README link to `docs/VERIFICACAO.md` pointed to a file ignored by Git, which never reached the repository. The file is now versioned; the rest of `docs/` stays local.

### Added

- Linux verification recorded in `docs/VERIFICACAO.md`: host test on VS Code 1.147.0 and Cursor 3.30.14, and the `multi-window`, `lifecycle` and `official` contracts (Claude Code 2.1.329).
- Release workflow (`.github/workflows/release.yml`): when a `vX.Y.Z` tag is pushed, checks that the tag matches `package.json` and the changelog, repeats the validations and the host test, builds and verifies the VSIX, and publishes it to the Visual Studio Marketplace and Open VSX (when the `VSCE_PAT` and `OVSX_PAT` secrets exist) and to a GitHub release.
- Manifest with `homepage`, `bugs` and `galleryBanner` for the Marketplace page.

### Internal

- Skills tests expanded from 1 to 15, covering the view controller with a simulated editor: ids that did not come from the listing are ignored, claude.ai skills are not toggled or deleted, deleting requires confirmation and uses the trash, creating respects the scope and never overwrites.
- The host tests on Windows failed after passing: the runner terminates only the editor's main process, and Electron's helper processes kept the temporary directory locked (`EBUSY`). Removal now retries with increasing waits and, if the directory stays locked, says which folder was left without changing the test result.
- Test of the real controller for the legacy hook in the old identifier's `globalStorage`; without the fix, **Turn On Change Log** stayed blocked with `ambiguousHookOwnership`.
- End-to-end test of the per-conversation filter (`test/chat-scope.test.js`): real `extension.js` and `ChangesController`, with tabs and transcripts simulated according to the behavior of the official extension 2.1.329.
- Matching between tab and conversation moved from `extension.ts` to `matchChatSessions` in `logic.ts`, with its own tests, and the panel notice got an interface test.

## 0.13.1 — 2026-11-20

### Changed

- New icon: a terracotta chat bubble with the `>_` prompt and a spark, in a color version (marketplace) and a monochrome one (sidebar).
- The extension's categories now include **AI**.
- The README got a summary and a step-by-step guide at the top. The verification details moved to `docs/VERIFICACAO.md`.
- Constants and utilities independent of the changes controller moved to `changes-support.ts`, with no behavior change.

## 0.13.0 — 2026-11-20

### Added

- The **Changes** panel now shows only the files of the focused conversation. When you switch conversations, the list follows. A notice at the top says which conversation is shown, and **See all** also shows the other conversations'. With no identified conversation (for example, a new conversation still without messages), the panel shows everything.

## 0.12.5 — 2026-11-20

The intermediate 0.12.x versions, such as 0.12.1 from the skills view commit, were not distributed; the result is consolidated in this entry.

### Added

- Skills list in the launcher panel, alternating with Conversations and Changes through a tab bar at the top of the panel, with search and **Project**, **Global** and **claude.ai** filters. Lets you open `SKILL.md`, enable or disable, create and delete (to the trash) project and global skills. Skills synced from claude.ai are read-only.

### Changed

- The launcher view is now called **Claude Code Launcher** and the separate skills view no longer exists. The **Show Skills** and **Show Conversations and Changes** commands switch tabs; **Changes** is hidden on the Skills tab. The **Open Skills List** command was removed.

## 0.11.0 — 2026-11-19

### Fixed

- Capture stopped after about ten thousand edits: each edit left a marker in `completed/` that nothing removed, until the folder exceeded the hook's inventory budget. The window that owns the review now collects markers and preparations older than 24 hours and unreferenced copies in `review-blobs/v1/`, on opening, every six hours and in **Clear Reviewed History**.
- A hook interrupted mid-run left a record in `active/` that blocked retention, **Clear Reviewed History** and **Delete All Local Review Data** forever. Maintenance now removes records proven to be orphaned.
- When closing or reloading the window, the extension waits for the review ownership to be released. Before, the next window could open the review read-only.
- Undoing the rejection of a file created by Claude recreated it with permission `0600`. The file now gets the system's default permission.
- Messages to the user showed internal codes, such as `execArgumentsNotConfirmed`. They now explain the reason.
- **Delete All Local Review Data** and **Recover Blocked Review** treated folders from virtual providers as disk paths.

### Changed

- Accepting and rejecting block the editor less: the review state no longer re-reads every content copy on each write or rewrites the state when nothing changed.
- The hook script copied to the project is checked on each panel refresh and restored when it differs from the one the extension ships.
- The panel warns when the change log is configured and the `node` command is not found on the `PATH`.
- `claudeCodeLauncher.hookExecutionMode` became a machine setting; a project's `settings.json` no longer changes it.
- On macOS, the hunk navigation shortcuts became `Ctrl+Alt+]` and `Ctrl+Alt+[`, because `Option+]` and `Option+[` type characters.
- The manifest declares limited support for virtual workspaces: review and change log require folders on the local disk.
- The panel is republished once per burst of typing in a file under review.
- A window that finds the review ownership left by a process that no longer exists offers **Recover review**, instead of relying on the user to find the command. Ownership is still never taken automatically.
- `claudeCodeLauncher.historyExcludedPatterns` patterns set in a project's `settings.json` now add to the user's; they no longer replace them.
- The activity bar container is called **Claude Code Launcher** and the conversations view **Conversations**, so they are not confused with the official extension. The extension got a listing icon, and the description says it is independent from Anthropic.

### Internal

- The code now uses the Node types (`@types/node`) instead of untyped `require`, which revealed three possibly undefined paths, now handled.
- ESLint with correctness rules (floating promises, strict equality, exhaustive `switch`) joined the project and CI.
- `noUnusedLocals`, `noImplicitReturns` and `noFallthroughCasesInSwitch` turned on; dead code removed.
- The presentation of changes moved from `changes.ts` to `changes-view.ts`, with no editor dependency.

## 0.10.0

- Per-file review results, privacy and recovery contracts.

## 0.9.0

- Capture diagnostics and an integration test of the installed VSIX.

## 0.8.0

- Fix for change capture on Windows and a new panel interface.

## 0.7.0

- History in blobs, review shared between editors and multi-folder support.

## 0.6.0

- Change review with pending changes, undo, navigation and tests.
