# Launcher for Claude Code reference

Full description of the behavior, the local data and the validation. For a quick overview, see the [README](../README.md). [Versão em português](REFERENCIA.md).

## Contents

1. [Requirements and compatibility](#requirements-and-compatibility)
2. [Installation](#installation)
3. [Getting started and language](#getting-started-and-language)
4. [Conversations](#conversations)
5. [Skills management](#skills-management)
6. [Rules, agents and MCP](#rules-agents-and-mcp)
7. [Permissions and hooks](#permissions-and-hooks)
8. [Change review](#change-review)
9. [Command capture](#command-capture)
10. [Hooks and local data](#hooks-and-local-data)
11. [Remote windows, WSL and containers](#remote-windows-wsl-and-containers)
12. [Operational commands](#operational-commands)
13. [Development and validation](#development-and-validation)

## Requirements and compatibility

- Visual Studio Code **1.94.0 or later**. In Cursor, the editor API must be compatible; the verified targets are in the table below.
- The official Claude Code extension, needed to open conversations. It is installed only through the explicit **Install** action.
- A trusted workspace and local files, needed for review and capture. The launcher stays disabled in Restricted Mode.
- Node.js **22 or later** on the `PATH` of the machine where the workspace is (in a remote window, the remote one), both for development and for running the hook. The Node embedded in the Extension Host is independent from the terminal's Node. When the change log is configured and the `node` command is not found on the window's `PATH`, the **Changes** panel shows a warning, which goes away as soon as a capture event is observed.
- In virtual workspaces, review and the change log are unavailable, because they require folders on the local disk. Opening the chat depends on the official extension's support for that kind of workspace, which has not been verified.

| Editor | Host test targets |
| --- | --- |
| VS Code 1.94.0, host Node 20.16.0 | local macOS arm64; Linux, Windows and macOS in CI |
| VS Code 1.146.0, host Node 24.22.1 | macOS arm64 |
| Cursor 3.19.13, VS Code API 1.128.0, host Node 24.18.1 | macOS arm64 |
| VS Code 1.147.0, host Node 24.22.1 | Linux x64 (1.0.0: host, `multi-window`, `lifecycle` and `official` with Claude Code 2.1.329) |
| Cursor 3.30.14, VS Code API 1.128.0, host Node 24.22.1 | Linux x64 (1.0.0: host) |

The scope of the tests, what they do not prove and the hook verification are in [VERIFICATION.md](VERIFICATION.md). Every Monday, the **Compatibility with latest editor and Claude Code** workflow (`.github/workflows/compat.yml`) repeats the VSIX installation and the contract with the official extension on the latest stable VS Code and the current version of Claude Code; it can also be triggered by hand.

## Installation

1. In **Extensions**, open the `…` menu and select **Install from VSIX**.
2. Select the `launcher-for-claude-code-<version>.vsix` file.
3. Open the project folder and run a command from the **Launcher for Claude Code** category.
4. To record new changes, run **Turn On Change Log** and start a new Claude conversation.

Updating the package does not publish the extension or send the history to an external service. The local data may contain code and parts of conversations; the storage policy is described in [Hooks and local data](#hooks-and-local-data).

## Getting started and language

The **Get started with Launcher for Claude Code** walkthrough (command **Open the Walkthrough**, or the `…` menu of the launcher view) goes through five steps: install Claude Code, open the project folder, turn on the change log, start a new conversation and review. Each step is checked off when the action happens. The editor opens the walkthrough by itself on the first installation, unless `workbench.welcomePage.walkthroughs.openOnInstall` is off.

When the change log is on but no hook event has been observed, the **Changes** panel replaces the empty state with **Change log on: start a new conversation**, with a **New conversation** button: conversations opened before turning it on do not load the hook.

The interface follows the editor's language: Portuguese when the editor is in Portuguese, English otherwise. The `claudeCodeLauncher.language` setting (`auto`, `en` or `pt-br`) pins a language; the change fully applies after reloading the window. Command and setting titles and the walkthrough come from the manifest and always follow the editor's language.

## Conversations

The chat bubble icon in the editor title and the **Claude** item in the status bar open the official sidebar. The **New Conversation in Tab** and **Open Chat in New Tab** commands use Claude's conversation editor. `claudeCodeLauncher.showStatusBarItem` hides the status bar item.

The **Launcher for Claude Code** container, in the activity bar, holds the view of the same name, which has a tab bar at the top: **Conversations**, **Skills** (see [Skills management](#skills-management)), **Rules**, **Agents**, **MCP** (see [Rules, agents and MCP](#rules-agents-and-mcp)), **Permissions** and **Hooks** (see [Permissions and hooks](#permissions-and-hooks)). The active tab shows its name; the others, only the icon. The **Conversations** tab shows:

- **New conversation**, which opens a new conversation in a tab;
- a list of conversations, one row per item, with the time on the right:
  - **Open**: conversations open in a tab, with a filled dot on the active tab and a hollow one on the others. Clicking moves the focus to the tab; the **×** button, shown on hover, closes it;
  - **Today**, **Yesterday**, **This week**, **This month** and **Older**: up to 15 recent conversations from the workspace's local folders, excluding those already open. Clicking resumes the conversation in a tab;
- **Search conversations**, available when the list has more than 6 conversations. The search ignores accents and case, and `Esc` clears the field.

The view title offers the **New conversation** and **Refresh conversations** actions. The view keeps the selected tab, and the **Show Conversations and Changes**, **Show Skills**, **Show Rules**, **Show Agents** and **Show MCP Servers** commands also switch between them. The list can be used with the keyboard: `Tab` moves the focus to it and the up and down arrows go through the rows.

Titles come from `~/.claude/projects/` or from `CLAUDE_CONFIG_DIR`, when set. Reading is asynchronous, uses a bounded cache and says when the list is partial. Results for a view that has already closed are discarded.

The launcher says when the official extension is missing, when activation takes longer than expected, when the command is not available and when the opening of the tab is not confirmed. Authentication errors reported by Claude point the user to sign in. The launcher has no public API to query the sign-in state, and an open tab does not prove that a new conversation started. When needed, the opening address uses the protocol of the editor in use, including `cursor://`.

### Editor group organization

Automatic group organization is **off** by default. The `claudeCodeLauncher.manageEditorGroups` setting keeps files out of the chat's group and manages the opening preferences. When it is turned off, only the values that still belong to the extension are restored. A later manual change ends management of that value until the setting is turned off and on again. A different workspace with the setting off does not restore the preferences managed by the current workspace.

## Skills management

The **Skills** tab lists Claude Code skills, with search and these filters:

| Filter | Source |
| --- | --- |
| **Project** | `.claude/skills/` of each local workspace folder |
| **Global** | `~/.claude/skills/`, or `$CLAUDE_CONFIG_DIR/skills/` when the variable is set |
| **claude.ai** | Synced skills; read-only |

While any tab other than **Conversations** is active, the **Changes** view stays hidden, and it shows again when **Conversations** is selected.

For project and global skills, these operations are available:

- **Open** the `SKILL.md` or **reveal** the folder in the system;
- **Enable or disable**: the `SKILL.md` file is renamed to `SKILL.md.disabled`, and Claude stops loading the skill. This is a launcher convention, not a Claude Code feature: Claude Code simply no longer finds the `SKILL.md`. To re-enable without the launcher, rename the file back;
- **Create**, giving a name (lowercase letters, numbers and hyphens) and a description; the created `SKILL.md` opens in the editor;
- **Delete**, after confirmation; the folder goes to the system trash.

The list refreshes when the disk changes. With no folder open, only global and claude.ai skills are shown. In a workspace with several folders, each project skill shows its source folder, and **+ New** asks which folder to create in.

## Rules, agents and MCP

The **Rules**, **Agents** and **MCP** tabs follow the format of the **Skills** tab: search, source filters, groups with **+ New** and actions on each row. Clicking the name opens the file in the editor. The filters shown are **All** and the sources that have items or allow creation. Each list is read only while its tab is active and refreshes when the disk changes. With no folder open, only the global sources are shown.

In a workspace with several folders, the project sources (and the MCP **Local** scope) are read from each local folder, and each item shows its source folder. Creating in the project asks for the folder; approving or rejecting a server from `.mcp.json` writes to the `.claude/settings.local.json` of its folder. User and organization servers appear only once.

### Rules

The tab lists the instructions Claude Code loads in conversations:

| Filter | Source |
| --- | --- |
| **Project** | `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` of each local workspace folder, and `.claude/rules/**/*.md` |
| **Global** | `~/.claude/CLAUDE.md` and `~/.claude/rules/**/*.md`, or the same paths in `$CLAUDE_CONFIG_DIR` |
| **Organization** | Managed `CLAUDE.md` (`/etc/claude-code/`, `/Library/Application Support/ClaudeCode/` or `C:\Program Files\ClaudeCode\`); read-only, shown only when it exists |

Each row shows the file's first heading or first line. A rule with `paths` in the frontmatter shows the globs under **Applies to**; without `paths`, the rule always applies. `CLAUDE.md` files in subfolders, which Claude Code loads on demand, are not listed.

- **Enable or disable**: `x.md` is renamed to `x.md.disabled` (including `CLAUDE.md`), the same launcher convention used for skills. To re-enable without the launcher, rename the file back;
- **Create**: give a name (lowercase letters, numbers and hyphens) and, optionally, comma-separated globs, written to `paths`. The file is created in `.claude/rules/` or in the global folder and opened in the editor;
- **Delete**, after confirmation; the file goes to the system trash.

### Agents

The tab lists the subagents in `.claude/agents/` (**Project**) and in `~/.claude/agents/` or `$CLAUDE_CONFIG_DIR/agents/` (**Global**), including subfolders. The name shown is the frontmatter `name`, by which Claude Code identifies the agent, and the `model`, when set, appears next to it. A global agent with the same name as an active project agent is marked **overridden**, because the project one has priority.

Enabling and disabling (`.md` ↔ `.md.disabled`), creating (name and description) and deleting to the trash work as for rules. The created agent does not declare `tools`, so it inherits the conversation's tools.

### MCP

The tab lists MCP servers by scope, in Claude Code's priority order:

| Filter | Source | What the launcher changes |
| --- | --- | --- |
| **Local** | `~/.claude.json`, in `projects["<folder>"].mcpServers` | Nothing |
| **Project** | the folder's `.mcp.json` | Approval, creation and removal |
| **User** | `~/.claude.json`, in `mcpServers` | Nothing |
| **Organization** | `managed-mcp.json` in the managed folder | Nothing |

With `CLAUDE_CONFIG_DIR` set, the file read is `$CLAUDE_CONFIG_DIR/.claude.json`. Each row shows the transport (`stdio`, `http` or `sse`) and the command or URL. Arguments that look like secrets, credentials and URL query strings are hidden, and environment variables and headers are not shown. A server with the same name in a higher-priority scope makes the other one **overridden**, and entries that cannot work, such as a `url` without `"type": "http"`, appear **with an error** and the reason.

The state comes from Claude Code's configuration:

- servers disabled through `/mcp` in the project (`disabledMcpServers` in `~/.claude.json`) appear as **disabled** and are re-enabled through `/mcp` itself;
- `.mcp.json` servers appear as **pending** until approved, and as **disabled** when rejected in `disabledMcpjsonServers` of any `settings.json`.

The launcher **never writes `~/.claude.json`**, which Claude Code rewrites all the time. Local and user servers can be opened at the matching entry of the file and must be changed through `/mcp` in the chat or the `claude mcp` command. For project servers:

- **Approve** or **reject in this project**: the name moves between `enabledMcpjsonServers` and `disabledMcpjsonServers` in `.claude/settings.local.json`, keeping the other keys. A rejection coming from another file (`.claude/settings.json` or the user's) cannot be undone by the launcher, and the button does not appear in that case;
- **Create**: give a name (letters, numbers, hyphens and underscores) and a command, written as a `stdio` server, or an `http(s)://` URL, written as an `http` server. The server enters `.mcp.json` pending approval;
- **Remove from `.mcp.json`**, after confirmation. The file is usually shared through the repository.

Both writes reformat the JSON with 2-space indentation, refuse files with invalid JSON and only write if the file has not changed since it was read.

## Permissions and hooks

The **Permissions** and **Hooks** tabs read Claude Code's four settings files, from the most specific to the organization's:

| Filter | File |
| --- | --- |
| **Local** | `.claude/settings.local.json` of each local folder (only you) |
| **Project** | `.claude/settings.json` of each local folder (shared through the repository) |
| **User** | `settings.json` in Claude's configuration folder (`~/.claude` or `$CLAUDE_CONFIG_DIR`) |
| **Organization** | `managed-settings.json` in the managed folder; read-only |

**Permissions** shows one row per rule in `permissions.allow`, `ask` and `deny`, with the type (**allow**, **ask**, **deny**) and the `defaultMode` of each scope. A rule that also appears with a stronger type (deny beats ask, which beats allow) is marked **overridden**. **+ New** asks for the type and the rule in Claude Code's format (`Bash(npm test:*)`, `Read(./src/**)`, `WebFetch(domain:example.com)`) and writes it to the file of the chosen scope; **Remove rule** asks for confirmation. As with MCP, writes reformat the JSON with 2 spaces, refuse invalid JSON and only write if the file has not changed since it was read.

**Hooks** shows one row per handler, with event, matcher, type and the command without arguments that look like secrets. The change log's own handlers carry the **launcher** tag. The tab is read-only: the name opens the file at the event's entry. A file with `disableAllHooks: true` shows as a warning.

## Change review

The **Changes** view gathers the edits captured from the Edit, Write, MultiEdit and NotebookEdit tools and, with [command capture](#command-capture), what commands and other tools changed. Capturing a notebook event does not mean the matching reversal is enabled.

### Scope per conversation

The panel shows only the files of the focused conversation and follows when you switch conversations. A notice at the top says which conversation is shown, and the **See all** action also includes changes from other conversations (the **Only this conversation** action restores the filter). When no conversation is identified, as with a new conversation still without messages, the panel shows all changes.

The official chat tab only exposes the title, so the conversation is identified by comparing the tab label with every title each recorded conversation has had: the custom one, those generated by Claude and the first message. The official tab truncates long titles to 24 characters followed by "…", and that truncation is taken into account. Identification is redone when the tab changes and when the conversation's transcript is updated, because the generated title appears in the tab before it is recorded.

Since this identification can fail, the filter only hides changes that **another open chat tab** identified as its own:

- **Pending** changes from conversations without an open tab, such as the sidebar chat or a conversation not yet identified, stay visible. The notice says how many there are (**+ N pending from conversations without a tab**). The already reviewed history of those conversations stays out of the filtered view.
- With no chat tab open, the panel shows everything. With the focus on a file, the last focused conversation applies.
- Conversations with the **same title** are not told apart. The panel shows the changes of all of them together and the notice says how many conversations have that title.
- The filter only changes **what appears** in the panel. Accepting and rejecting still apply to the whole file, including hunks from other conversations in the same file.

### Sidebar panel

The **To review** block lists the pending files, with the `+`/`−` counts and the **new** or **deleted** mark. The **✓** and **✕** buttons at the end of each row accept or reject the file; clicking the row opens the review in the code. The panel shows partial decisions, the review phase and per-file blocks. A blocked file has its actions disabled, with the reason and guidance to resume the review.

The history is a compact list, without diffs, grouped by day and by the request that led to the edits. Each row shows the status, the file, the `+`/`−` counts and when the edit happened:

| Indicator | Meaning |
| --- | --- |
| Orange dot | Pending review |
| ✓ | Accepted |
| ↶ | Rejected |
| Orange ✓ | **Mixed** review |

Clicking a row shows the change in the code, and the diff icon, shown on hover, opens the before/after comparison of that edit. The tooltip shows the summary and the explanation recorded by Claude. The **Undo request** action shows when hovering over the request. The **See the diffs in a larger view** link, at the end of the list, opens the full panel.

The state shows next to the view title (**Change log configured**, **Change log off** or **Read-only**), and the number of files to review shows on the Claude Code icon in the activity bar. **Change log configured** means the handlers are present; observation and completion of captures are shown separately in the diagnostics.

The actions in the view title are:

- **Recover Locked Review**, when the window is read-only, and **Undo rejection**, when there is a rejection to undo;
- **Refresh** and **Larger view**;
- in the `...` menu: accept or reject all pending changes, turn the marks in the code on or off, turn the change log on or off, **Clear Reviewed History**, **Delete All Local Review Data** and **Release Review to Another Window**.

Each request in the history offers, on hover, **Accept request** and **Undo request**. Both only reach the files whose pending changes all came from that request; a file with changes from other requests is left for the per-file decision.

**Copy changes summary** (in the view's `...` menu, in the larger view's bar or from the palette) puts on the clipboard a Markdown summary of the visible changes, grouped by request: file, action, line counts, state and the first part of Claude's explanation. It is a starting point for a PR description.

### Larger view

The **larger view** opens the same panel in a tab, with the actions in the top bar. Each edit is a card with the summary, the request and the explanation found in the transcript, plus the diff hunks, with a **Unified / Side by side** toggle. Hunks with more than 60 lines start collapsed. Open cards, the collapsed block and the legend are kept when the panel reopens, and scrolling does not jump when a new change arrives. When the review is read-only, the buttons that change it stay disabled, and a notice explains why.

### Decision semantics

- **Accept** keeps the content and records the decision. Accepting a hunk adds only that hunk to the review base.
- **Reject** restores only the part still pending. A part accepted in the editor stays accepted when using the panel or reloading the window.
- A review with accepted and rejected parts gets the **mixed** state. Contiguous edits covered by the decision have all their identifiers represented.
- Human edits, external changes, ambiguous identity and insufficient snapshots set up barriers. The action may be blocked or reach only the proven contiguous segment; the launcher does not go back through a human edit to complete the batch.
- Rejecting a created file restores its **absence**. An empty file and a missing file are different situations. Deletions use the trash, and a failure does not lead to an attempt at permanent deletion.
- A decision that changes content only completes after applying, saving and verifying the result. A save failure is not shown as a completed rejection. The result distinguishes the content change, the save and the persistence of the decision; cancellations, conflicts and pending recovery get specific per-file guidance.
- **Undo Last Reject** uses recovery persisted per item. Conflicting items stay recoverable and are not consumed as if they had been restored. An interrupted intention may require reconciliation before a new action.

### Review in the editor

Code lenses offer **Accept** and **Reject** per hunk and, when there are several hunks, options to accept or reject all of them. The **Hide marks** command accepts the file's pending changes; to hide only the presentation, turn off `claudeCodeLauncher.inlineChanges`.

The lenses' **Side by side** mode compares the base of the current review, including partial decisions, with the observed file. A card's comparison shows the historical before/after of the matching edit. The two comparisons answer different questions.

Pending files get the letter **C** in the Explorer, and the status bar shows their count. `Alt+]` and `Alt+[` go through the hunks; on macOS, where those keys type characters, the shortcuts are `Ctrl+Alt+]` and `Ctrl+Alt+[`. `Alt+Shift+Y` and `Alt+Shift+N` (on macOS, `Ctrl+Alt+Y` and `Ctrl+Alt+N`) accept and reject the hunk under the cursor, with the same review check as the lens; outside a hunk, nothing is decided. Colors can be adjusted by the theme, including `claudeCodeLauncher.pendingChangeForeground`.

## Command capture

The Edit, Write, MultiEdit and NotebookEdit tools are captured on each call. A formatter, `npm install`, `sed -i`, a code generator or an MCP tool change files without going through them. With `claudeCodeLauncher.captureCommandChanges` on (the default) and the change log on, the launcher installs two more handlers, without a matcher:

- **`UserPromptSubmit`** (you send a request): the hook walks the project, notes the size, date and hash of each file in `turns/<conversation>.json` and keeps a copy of each text file in `turn-blobs/`. Files that have not changed since the previous request reuse the hash and the copy;
- **`Stop`** (Claude finishes the reply): the hook walks again and records in the log, with the tool `Command`, each file created, changed or deleted that an edit captured in the same turn does not explain. The "before" is the copy from the start of the turn, or the "after" of the file's last captured edit; the "after" is the current file.

These changes enter the review like the others, labeled **Changed by a command** (or **Created by a command**): accepting, rejecting, undoing and the barriers work the same way. The request and the explanation come from the transcript: the turn's last terminal call (or, if there is none, the last call of any tool) after the message that opened the turn. With turn capture configured in every folder, the terminal command notice no longer appears, because what the commands change is already in the list.

Limits and what is left out:

- `.git`, `.hg`, `.svn`, `node_modules`, `.claude`, what the project's `.gitignore` files ignore, the privacy exclusions and symbolic links never enter. Each folder walked reads its own `.gitignore` (up to 200 files per walk, 400 rules and 64 KiB each), with git's rules: the last matching rule decides, `!` re-includes, a `/` at the start or in the middle anchors the pattern to the file's folder, a trailing `/` applies only to folders, and `*`, `**`, `?`, `[...]` and `\` work. As in git, an ignored folder is not walked, so `!` re-includes nothing inside it. `.git/info/exclude` and the global `core.excludesFile` are not read;
- up to 5,000 files and 24 folder levels per walk, 4 seconds of walking and 200 changes per turn; beyond that, the turn is marked as limited and files that were not walked are not taken as deleted;
- the copies from the start of the turn use at most half of `historyMaxStorageMB` and 2,000 files of up to 512 KiB. A file without a copy shows as changed, but without the content from before, and cannot be rejected;
- binaries do not enter: only UTF-8 text is reviewed;
- two conversations working at the same time in the same project may attribute to one of them what a command from the other changed.

The hook runs nothing from the project (not even `git`): it only reads files. It writes nothing to its output, because a `UserPromptSubmit`'s output would be handed to Claude as context. Copies in `turn-blobs/` not referenced by any manifest are collected at the start of the next turn, after 10 minutes; manifests of conversations that never reached `Stop` go away after 7 days.

## Hooks and local data

Turning on the change log configures the launcher's own handlers in `.claude/settings.local.json` (`PreToolUse` and `PostToolUse` for edits and, with command capture, `UserPromptSubmit` and `Stop`) and copies the script to `.claude/launcher-changes/`. The hook command uses a separate executable and arguments. Mixed groups keep third-party handlers; invalid JSON or a concurrent change block the configuration update.

`auto` mode requires a capability proven in the schema. `exec` mode is an explicit choice, meant for a harness whose compatibility with that format has been verified. `disabled` mode turns off the managed hooks. There is no automatic fallback through a shell. The hook only observes the edit: a capture failure neither authorizes nor prevents Claude's original operation.

When the extension updates, the script of already configured hooks is repaired automatically, when the capability, the policy and write ownership allow it. A paused capture stays paused. Blocks are reported; to turn the change log back on, use **Turn On Change Log** and start a new conversation, so Claude loads the configuration.

The hook script lives in the project folder and runs on each Claude edit. On each panel refresh, the copy is compared with the one the extension ships. The window that owns the review restores a missing or different copy and, when the content differed, shows a warning; a read-only window only reports the difference. This check shortens the time a replaced script stays in effect, but does not prevent it from running before the check.

### Capture diagnostics

The **Changes** view shows the diagnostics per workspace folder, distinguishing four pieces of information:

| Information | What it proves |
| --- | --- |
| Configuration | The launcher's handlers were found in the local configuration |
| Execution capability | The schema accepts a separate executable and arguments, `exec` was chosen explicitly, or the capability remains unknown |
| Observation | The hook recorded, with a date, an attempt and its stage |
| Known completion | There is evidence of an event recorded in the history; content availability is shown separately |

The hook configuration does not prove that Claude ran it, and an event before the edit does not prove its completion. The panel gives guidance for situations such as pause, quota, permission, space, preparation or unavailable writing. If an attempt fails after a completed capture, the earlier evidence stays dated and does not represent current successful activity.

Diagnostics use immutable records, with admitted stages and reasons, without code, prompts, transcripts, absolute paths or raw exceptions. Reading is bounded. Legacy, incompatible or unreadable data, as well as incomplete reads, show as unknown or partial diagnostics, keeping the information found. Changes to the diagnostics can refresh the panel even without a new history entry.

**Coverage is not universal.** The hooks cover Edit, Write, MultiEdit and NotebookEdit. Bash, PowerShell, MCP and external changes are not covered by that matcher.

So that an empty list does not look like "Claude touched nothing", the panel reads the terminal commands (Bash and PowerShell) Claude asked for in the focused conversation, or in the conversations with pending changes when nothing is focused, straight from the transcript. Recognized read-only commands (`ls`, `cat`, `grep`, `git status`, `git diff` and the like, without redirection to a file) are ignored; the others count as a possible write, and the panel says how many there were, with the program names and a shortcut to source control. Nothing is captured and no new hook is installed: the notice does not show the command text and does not prove that anything changed. The transcript is read incrementally, up to 8 MiB from the end on the first read; beyond that, the count is marked as partial. Excluded, large or insufficient content is not presented as a full copy. Snapshot availability does not skip the conflict and admitted-resource checks that precede a reversal either.

### Content policy

The history holds local copies in plain text, without encryption of its own. The default exclusions avoid new copies of `.env`, private keys, certificates and certain credential files. The policy also prevents new copies of requests and explanations about excluded files, including in old events. Changing an exclusion does not delete earlier copies or guarantee that every possible secret is recognized. Files over **512 KiB** do not have their full content captured.

| Setting | Default | Effect |
| --- | --- | --- |
| `claudeCodeLauncher.inlineChanges` | `true` | Shows the review marks |
| `claudeCodeLauncher.manageEditorGroups` | `false` | Turns on group and preference management |
| `claudeCodeLauncher.showStatusBarItem` | `true` | Shows the **Claude** status bar item, which opens the chat |
| `claudeCodeLauncher.hookExecutionMode` | `auto` | `auto`, `exec` or `disabled`. Machine setting: a project's `settings.json` does not change it |
| `claudeCodeLauncher.historyExcludedPatterns` | Sensitive file patterns | Exclusions for new copies; accepts `*`, `**` and `?`. Patterns from a project's `settings.json` add to the user's and do not replace them |
| `claudeCodeLauncher.historyRetentionDays` | `30` | Retention of the reviewed history; `0` turns off cleanup by age |
| `claudeCodeLauncher.historyMaxStorageMB` | `128` | Local budget, in MiB; when the limit is reached, new captures are paused |

Pending items, partial decisions and references needed for recovery are not discarded to meet the budget. A partial read or an invalid record prevents claiming that the whole history was processed. The diagnostics of invalid entries avoid copying their content into reports again.

### Data cleanup

**Clear Reviewed History** removes the eligible history entries, keeping reviews and recovery. For that reason, it does not free all the storage.

The window that owns the review also collects, on opening and every six hours, the items that no flow uses: markers in `completed/` and preparations in `pending/` older than 24 hours, and copies in `review-blobs/v1/` not referenced by the canonical state, the previous generation or the backups. **Clear Reviewed History** runs the same collection right away. Files with unknown names, captures in progress and recent copies are kept.

**Delete All Local Review Data** asks for confirmation, pauses the capture and requires cooperating producers to be stopped. The command removes the launcher's own review and recovery data, keeping the project's current files and third-party configuration. The capture stays paused until the user turns it on again. Failures and conflicts are reported as a partial or blocked cleanup, with an inventory of what was left by category and guidance for the next attempt. An incomplete inventory is not presented as the absence of data. The command does not delete Claude's original transcripts, external backups or copies in Git.

An interrupted cleanup keeps a minimal intention in `purge-state.v1.json`, without file or conversation content. While this marker exists, version 0.10 and later block the review and the automatic repair, so the remaining data is not ingested again. Resolve the condition shown and repeat **Delete All Local Review Data**; do not remove the marker by hand, as it is only deleted after the disk and memory steps finish.

### Files and recovery

The `.claude/launcher-changes/` folder is local and gets a Git exclusion rule. Do not force it into Git, as it may contain code and private metadata.

| Path | Responsibility |
| --- | --- |
| `log.jsonl`, `blobs/` | Captured events and content versions |
| `review-state.v1.json`, `.prev`, `review-blobs/v1/` | Canonical state, previous generation, decisions and recovery |
| `status.json` | Projection of complete decisions, for compatibility; the mixed state is not turned into a uniform decision |
| `review-writer.lock` | Cooperative ownership of review writing |
| `review-migration-backups/` | Migration and recovery backups |
| `purge-state.v1.json` | Prepared or partial cleanup intention; blocks automatic recreation until an explicit new attempt completes |
| `meta.json` | Request and explanation linked to the events |
| `capture-policy.json`, `capture-status.json` | Capture policy, pause and legacy diagnostics; on their own, they do not prove completion |
| `capture-diagnostics/v2/observations/`, `capture-diagnostics/v2/completions/` | Separate evidence of attempts and completions; conservative retention of 32 valid records per category, keeping unknown data |
| `active/`, `pending/`, `completed/` | Hook coordination and idempotency; old markers are collected automatically |
| `turns/<conversation>.json`, `turns/index.json` | Project state at the start of each conversation's turn and the hash index of command capture |
| `turn-blobs/` | Copies of the text files from the start of the turn; those cited by the log are copied to `blobs/` |

#### Write ownership

Only one window writes the review of each project at a time; the others stay read-only. The owning window uses **Release Review to Another Window**, and the window taking over uses **Recover Locked Review**. An active or ambiguous owner is not removed because of the lock's age.

After a crash, the next window opens read-only and, when the process recorded as owner no longer exists, offers **Recover review** once. Ownership is never taken without that confirmation, because the folder may be open on another machine or container. The recovery command checks the owner.

If there is an orphaned `review-recovery.lock`, the procedure is offline:

1. Close every window and conversation that uses the project.
2. Make a copy of `.claude/launcher-changes/`.
3. Check the recorded PID.
4. Remove **only that guard**, after confirming the process has ended.

Do not remove the lock of an active window or edit the canonical state to force a decision. A capture maintenance guard also requires quiescence and inspection before any intervention.

#### Interrupted hooks

A hook interrupted while running (timeout, process or machine crash) leaves its record in `active/` and, sometimes, a `.post` marker in `pending/`. Maintenance removes these records when they have the format the hook creates, are older than 30 seconds and belong to a process that no longer exists; the `.post` marker is removed when no record is left in `active/`. Records from active or recent processes, or with unknown names, keep blocking maintenance.

#### Earlier versions and downgrade

From 1.0.0 on, the versioned formats in this folder are compatible within the 1.x series: a 1.x version reads what any earlier 1.x wrote. The full commitment is in the [CHANGELOG](../CHANGELOG.md).

Version 0.7.0 does not take part in this protocol. Do not keep old and new versions writing to the same project. To downgrade, stop the writers and keep the review folder, because the old format does not represent partial decisions, the mixed state or all of the current recovery. Reinstalling the earlier executable does not undo the content of the files.

Versions 0.8 and 0.9 also do not recognize the cleanup intention introduced in 0.10. An interrupted cleanup must be finished with version 0.10 or later before considering a downgrade. Using those versions at the same time during cleanup is not supported.

## Remote windows, WSL and containers

The launcher declares `extensionKind: ["workspace"]`: in a remote window (WSL, SSH, dev container, Codespaces), it runs on the workspace host, like the official Claude Code extension, which is also a workspace extension. So:

- the hook runs with the remote host's `node`; Node.js 22+ must be installed there, on the `PATH` of the Claude Code process;
- the conversations, global skills and the user's `settings.json` are those in the remote host's `~/.claude`;
- the review data lives in `.claude/launcher-changes/` inside the remote workspace;
- the capture diagnostics report the environment (for example, "remote window (wsl)").

Two actions depend on the local machine and change in a remote window:

- **Reveal in file manager** reveals the file in the Explorer when it belongs to the workspace; outside it (for example, in `~/.claude`), it copies the path and says so;
- the **trash** does not exist in every environment (it is often missing in containers). Without it, rejecting a file created by Claude and deleting skills, rules or agents stop with the reason "the trash is not available": the launcher never deletes permanently.

What was verified and what was not is in [VERIFICATION.md](VERIFICATION.md#remote-environments). To check in a remote environment: open the remote window, install the extension there, turn on the change log, start a new conversation, ask for an edit and a command (`npm run format`, for example) and check the **Changes** panel and the capture diagnostics.

## Operational commands

All commands are in the **Launcher for Claude Code** category of the palette, in addition to the actions in the views.

| Command | Purpose |
| --- | --- |
| Open Chat in Sidebar / Open Chat in New Tab | Open the official integration |
| New Conversation in Tab | Request a new conversation |
| Install Claude Code | Install the official extension, through an explicit action |
| Show Conversations and Changes / Skills / Rules / Agents / MCP Servers / Permissions / Hooks | Switch the tabs of the launcher view |
| Show Claude's Changes | Open the larger panel |
| Refresh Changes | Read the history and review state again |
| Turn On / Turn Off Change Log | Manage the launcher's own hooks |
| Clear Reviewed History | Clear the eligible history, keeping recovery |
| Delete All Local Review Data | Coordinated full cleanup, with confirmation |
| Release Review to Another Window | End the local ownership of the review |
| Recover Locked Review | Take over a released review or recover from an owner proven to have ended |
| Accept / Reject All Pending Changes by Claude | Review the admitted batch |
| Undo Last Reject | Recover the last batch, keeping the items that cannot be restored |
| Toggle Change Markers in Code | Change the inline presentation |
| Next / Previous Change by Claude | Navigate through the hunks |
| Accept / Reject Claude's Hunk at Cursor | Decide the hunk under the cursor, with the lens's signature |
| Copy Changes Summary (Markdown) | Copy the visible changes, by request, for a PR description |
| Open the Walkthrough | Open the getting started guide |

## Development and validation

Node.js 22 or later and the project's lockfile are required:

```sh
npm ci --ignore-scripts --no-audit --fund=false
npm run typecheck
npm run lint
npm test
npm run test:package
npm audit --audit-level=moderate
npm run package -- --out launcher-for-claude-code.vsix
npm run verify:package -- launcher-for-claude-code.vsix
```

`typecheck` checks the TypeScript in `src/` and also the JavaScript that ships without compilation: the hook (`tsconfig.hooks.json`, Node types) and the view pages (`tsconfig.webview.json`, DOM types and `types/webview.d.ts`). `lint` covers `src/`, `hooks/` and `media/`.

### README images

The images in `docs/images/` come from the real view pages (`media/*.js` and `*.css`), rendered in a headless Chromium with a demo state, the Dark Modern theme colors and the diffs and labels from `out/` itself:

```sh
npm run compile && node scripts/screenshots.cjs
```

The script finds Chromium in the Playwright cache (`--chrome` points to another one) and uses `ffmpeg` for the GIF. The editor's code lenses do not appear in these images, because they belong to the editor, not to the pages.

### Translation

The Portuguese text stays in the code and is the key; `l10n/en.json` has the English. In the extension, `t('…')` translates at display time and `m('…')` marks phrases in tables built when the module loads (the value goes through `t` when it is used). In the pages, `window.launcherL10n.t` does the same with the dictionary the extension injects. Plurals use `plural(n, '{0} arquivo', '{0} arquivos')`. To check what is left to translate:

```sh
npm run compile && node scripts/l10n-check.cjs
```

The command lists untranslated phrases, unused translations and different `{n}` placeholders; `test/l10n.test.js` fails in the same cases, so a Portuguese phrase changed without updating `l10n/en.json` fails the suite. The manifest uses `package.nls.json` (English, the default) and `package.nls.pt-br.json`.

The `vscode:prepublish` script runs the build, which removes the previous output, compiles with `noEmitOnError` to `out/` (the modules the tests use) and only then bundles the extension into one file, `dist/extension.js`, with esbuild. The package carries only `dist/`: one file loads faster at activation than dozens of modules. `npm run watch` keeps both up to date for debugging (F5). The package tests use temporary trees, including one without output and another with stale output in `out/` and `dist/`. The verifier inspects the real VSIX, compares its bytes with the current runtime, computes the SHA-256 and rejects unexpected content. `docs/`, tests, scripts, local settings and development dependencies are excluded from the VSIX.

### Host tests

The tests in `test/*.test.js` use real rules and explicit adapters where the editor is not present. To test the Extension Host, build the project and run:

```sh
npm run test:host -- --editor code
npm run test:host -- --editor cursor
npm run test:host -- --editor code --vsix launcher-for-claude-code.vsix --keep
npm run test:host -- --editor cursor --vsix launcher-for-claude-code.vsix --report-dir docs/validacao/host-cursor
```

The runner creates a temporary workspace, profile, extensions folder and Claude configuration. `--vsix` mode installs and exercises the package in that isolated profile, without changing the normal profile and without sending messages to Claude. `--keep` keeps the temporary profile, and failures also keep the folder. `--report-dir` creates a unique `run-*` subfolder for each run, with its reports and logs, keeping earlier runs. The scenario is a trusted synthetic workspace and is not a Restricted Mode test.

The package's capture journey checks the hash of the installed hook against its entry in the VSIX, runs the before and after events with an external Node 22 or later, waits for ingestion through the editor's public lenses and checks a rejection in the document, on disk and in the persisted state. This synthetic file does not get events seeded directly into the log. The reports separate the external Node from the Extension Host's Node and tie the result to the VSIX hash. This procedure exercises the hook directly and is not equivalent to an authenticated conversation or to the hooks being run by Claude's official harness.

The create-rejection journey requires a trash on the workspace's file system, because the launcher never deletes permanently. On Linux, when the temporary folder has no trash (`gio` reports "system internal mounts"), point `TMPDIR` to a folder inside the home, for example `TMPDIR=$HOME/.cache/launcher-host npm run test:host -- ...`, and remove it at the end.

On macOS, the default paths are the applications in `/Applications`; on Linux, pass `--executable` (for example, `/usr/share/code/code` or `/usr/share/cursor/cursor`). For another installation, use `--executable /path/to/editor`. The CLI path is derived from that installation, and `--cli /path/Resources/app/out/cli.js` overrides it, as long as it belongs to the **same installation**. To download and exercise an exact VS Code version:

```sh
npm run test:host -- --download-version 1.94.0 --vsix launcher-for-claude-code.vsix --report-dir docs/validacao/host-minimum
```

`--download-version` accepts only an exact version, only for VS Code, and cannot be combined with `--executable` or `--cli`. The download uses a temporary cache outside the project. On Linux without a display, run the command with `xvfb-run -a`. The CI matrix includes the VSIX installation and the hook journey on VS Code 1.94.0 on Linux, Windows and macOS, plus typing, Node tests, package tests and audit. Check the checks and evidence of the run for the commit to be distributed.

### Performance evaluation

To measure the conversation listing with synthetic files, run `node scripts/benchmark-sessions.cjs docs/validacao/sessoes.json`. A second argument accepts a known baseline module, for a paired comparison.

The report records five samples with 15, 1,000 and 5,000 files per folder, in two synthetic folders, including missing titles and files beyond the read window. Each combination uses a new process, with one cold and four warm samples. It measures completion, event loop availability, IO calls, bytes read and heap change after explicit GC, and records the module hashes. Process memory and the timer probe include runtime noise and are not an SLA. The operating system cache is not cleared. The listing uses up to eight concurrent stat operations, 10,000 candidates and 256 title reads per call; these limits are not a latency promise.

### Additional contracts

The additional contracts also use the installed VSIX in isolated profiles:

```sh
npm run test:host:contracts -- multi-window --vsix launcher-for-claude-code.vsix --report-dir docs/validacao/janelas
npm run test:host:contracts -- lifecycle --vsix launcher-for-claude-code.vsix --report-dir docs/validacao/lifecycle
npm run test:host:contracts -- official --official-extension /path/to/extension/anthropic.claude-code --vsix launcher-for-claude-code.vsix --report-dir docs/validacao/oficial
```

- **`multi-window`** exercises two real windows, reload, a partial decision and an explicit transfer of writing.
- **`lifecycle`** measures public activation and instantiates the packaged review and conversation list components, with a real context and an observer that forwards calls to the real APIs. It repeats panels, folder switches and disposal during refresh. The list's private provider is exposed only in the test loader, without changing the distributed code, and the real view receives a thousand synthetic sessions. The counters belong to the observed instance and do not represent all the editor's resources.
- **`official`** copies only the program files of the already installed official extension to the temporary folder, queries the isolated CLI's state and checks an open official tab, without sending a message. It also uses the public [`--init-only`](https://code.claude.com/docs/en/hooks#setup) mode to test the executable-and-arguments descriptor on a synthetic Setup event, including error and timeout cases. The Setup event is not equivalent to the PreToolUse/PostToolUse capture events, which are still identified separately.

None of these scenarios proves an authenticated conversation or the hook being run by the model. The CI matrix includes the window and lifecycle contracts. The `official` contract runs every week in the compatibility workflow, which installs the current version of the official extension with `node scripts/install-official-extension.cjs --download-version <version> --extensions-dir <folder>`; locally, it depends on an installation compatible with the system.

### Internal documentation and publishing

The PRDs, specs and implementation records in `docs/` are local and ignored by Git; do not use `git add -f docs/`. The exceptions are `docs/REFERENCE.md` (this reference) and `docs/VERIFICATION.md`, with the Portuguese versions `docs/REFERENCIA.md` and `docs/VERIFICACAO.md`, versioned because the READMEs point to them. When you change one, update the other language. Building a VSIX does not commit, push or publish to the Marketplace or Open VSX.

Publishing is done by the `.github/workflows/release.yml` workflow, triggered by a `vX.Y.Z` tag:

1. Update `version` in `package.json` and `package-lock.json` and replace `## Unreleased` / `## Não publicado` with a `## X.Y.Z — date` section in `CHANGELOG.md` (English) and `CHANGELOG.pt-BR.md`.
2. Check the **Validate extension** checks of the commit on the three systems.
3. Create and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The workflow refuses a tag that does not match `package.json` or has no section in either changelog. It repeats the validations and the host test, builds and verifies the VSIX, and publishes it to the Visual Studio Marketplace (secret `VSCE_PAT`) and Open VSX (secret `OVSX_PAT`, where Cursor installs from). A registry without a secret is skipped with a warning. The verified VSIX is attached to a GitHub release, with the notes taken from `CHANGELOG.md`. The publish job uses the `release` environment, which may require manual approval in the repository settings.
