# Launcher for Claude Code

[Leia em português](https://github.com/KauanCarolino/Extension-Claude-Code-Launcher/blob/main/README.pt-BR.md)

Opens the official Claude Code chat in VS Code and Cursor and shows, file by file, what Claude changed, so you can accept or reject each change.

Independent extension: it is not made or maintained by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## What it does

- **Opens the chat** in the sidebar or in editor tabs, from the icon in the editor title or the **Claude** item in the status bar. The launcher view lists the project's conversations so you can resume any of them.
- **Reviews Claude's changes.** Every file Claude edits shows up in **Changes**, with the diff and what Claude said before editing. Accept or reject a whole file or a single hunk, in the panel or right in the editor, and undo a reject.
- **Tells you what the review can't see.** When Claude runs a terminal command that may have written files, the panel says so and points you to Source Control.
- **Manages skills, rules, agents and MCP servers** in tabs of their own, including in multi-root workspaces.

Chat, sign-in, models and permissions stay with the official **Claude Code** extension (`anthropic.claude-code`).

## Getting started

The walkthrough (**Launcher for Claude Code: Open the Walkthrough**) opens on install and takes you through these steps:

1. Install the official Claude Code extension. The launcher offers an **Install** button.
2. Open the project folder.
3. Run **Turn On Change Log**. The hook runs with `node`, so Node.js must be on your `PATH`.
4. Start a **new** conversation and ask for an edit. Claude loads hooks when a conversation starts, so conversations that were already open record nothing.
5. Review the change in **Changes** or in the editor. `Alt+]` and `Alt+[` move between hunks (`Ctrl+Alt+]` and `Ctrl+Alt+[` on macOS).

## Privacy and local data

- Everything stays on your disk. Nothing is sent to an external service.
- The change log adds two hooks to the project's `.claude/settings.local.json` and keeps copies in `.claude/launcher-changes/`, which gets its own `.gitignore`. The hook only observes: it never approves or blocks a tool.
- `.env` files, private keys, certificates and credential files are not copied by default (`claudeCodeLauncher.historyExcludedPatterns`). Reviewed history is cleaned up after 30 days.
- Capture covers Edit, Write, MultiEdit and NotebookEdit. Terminal commands, MCP tools and changes from outside Claude are not captured.

## Requirements

- VS Code 1.94 or later, or a compatible Cursor.
- The official Claude Code extension.
- Node.js 22 or later on the `PATH`, for the change log.
- A trusted workspace on local folders. The launcher stays off in Restricted Mode.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `claudeCodeLauncher.language` | `auto` | Interface language: `auto` follows the editor (Portuguese or English), or pick `en` or `pt-br` |
| `claudeCodeLauncher.inlineChanges` | `true` | Shows review markers in the editor |
| `claudeCodeLauncher.historyExcludedPatterns` | sensitive files | Paths that are never copied into the history |
| `claudeCodeLauncher.historyRetentionDays` | `30` | Days to keep reviewed history; `0` keeps it |
| `claudeCodeLauncher.historyMaxStorageMB` | `128` | Storage budget; new captures pause when it is reached |
| `claudeCodeLauncher.manageEditorGroups` | `false` | Lets the launcher keep file tabs out of the chat's editor group |
| `claudeCodeLauncher.hookExecutionMode` | `auto` | How the hook is registered; `disabled` turns it off |

## Learn more

- [Full reference](https://github.com/KauanCarolino/Extension-Claude-Code-Launcher/blob/main/docs/REFERENCIA.md) (Portuguese): review semantics, capture diagnostics, local data, recovery and development.
- [What the tests prove](https://github.com/KauanCarolino/Extension-Claude-Code-Launcher/blob/main/docs/VERIFICACAO.md) (Portuguese).
- [Changelog](https://github.com/KauanCarolino/Extension-Claude-Code-Launcher/blob/main/CHANGELOG.md).

Licensed under MIT.
