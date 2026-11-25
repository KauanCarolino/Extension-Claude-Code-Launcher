# Verification and compatibility

Verification details for Launcher for Claude Code, kept out of the README so it stays short. The full behavior is in the [reference](REFERENCE.md). [Versão em português](VERIFICACAO.md).

## Verification scope

The test journeys cover activation, commands, preservation of preferences with group management off, CRLF, UTF-8 with BOM, rejecting a creation, undo, partial review and a human edit between captures. BOM, Unicode and line endings are checked in the document and in the saved bytes. A change in the presence of the BOM, mixed line endings and invalid UTF-8 must block the reversal.

In VSIX mode, an extra journey runs the installed hook on a synthetic file and checks its ingestion and review in the editor. The adapter tests cover write failures, recovery and concurrency. Notebooks with unsaved changes and virtual providers get real negative tests, which prove that buffers are preserved and mutations are blocked; this does not enable review of those resources, and reviewing resources that are not admitted blocks content changes.

These scenarios do not prove the authenticated opening of conversations or operation on remote hosts. The reports identify the editor, the system and the artifact of each run. A configured matrix is not the same as a passed result.

The regular validation pins VS Code 1.94.0, the minimum declared version. Every week, the compatibility workflow (`.github/workflows/compat.yml`) repeats the VSIX installation, the hook journey and the `official` contract on the latest stable VS Code and the current version of the official extension, to warn early when an internal Claude Code command (`claude-vscode.*`) or the hook format changes. A passing run holds for the versions of that date; the job summary records which ones.

The Node tests also load the view pages in Portuguese and with the English dictionary, and `test/l10n.test.js` fails when a phrase marked in the code has no translation or when the manifest uses a key missing from `package.nls.json` or `package.nls.pt-br.json`.

## Remote environments

The launcher and the official extension are workspace extensions: in a remote window, both run on the workspace host, and the hook uses that host's `node` and `~/.claude`. This follows from the manifest (`extensionKind: ["workspace"]` in the launcher; the official extension does not declare `extensionKind` and, since it runs code, stays on the workspace) and has not been exercised in a real remote window: WSL, Remote-SSH, Dev Containers and Codespaces **have no automated test**.

What was verified on 2026-11-22, in 1.2.9:

- the entire Node test suite (407 tests, including the per-edit hook, the turn capture run as a process and the controller with a simulated editor) passed in a `node:22-bookworm-slim` container (Debian 12, Node 22.23.5), with an unprivileged user, a temporary `HOME` and no trash on the system;
- the tests cover, with a simulated editor, the two differences of a remote window: revealing in the Explorer or copying the path instead of opening the local file manager, and rejecting a created file stopping with the reason when there is no trash, without deleting permanently.

To check in a real remote environment, follow the list in [REFERENCE.md](REFERENCE.md#remote-windows-wsl-and-containers).

## Command capture

`test/hook-turn.test.js` exercises the turn hook with real files: creation, change and deletion by a command with reviewable before and after, a second `Stop` in the same turn, Edit/Write edits that are not repeated and a formatter after them, the exclusions (`.git`, `node_modules`, root and subfolder `.gitignore` files with negations, privacy, binaries), the `.gitignore` rules (anchors, folder-only, negation, classes, `**` and escapes), paused capture, maintenance, a tampered manifest, the copy budget, collection of old copies and the process's empty output. `test/turn-capture.test.js` connects the result to the panel: the label, the request and the explanation taken from the transcript, and the terminal notice dismissed. The `official` contract with the real Claude Code still covers only the hook format on the Setup event; a real conversation with `UserPromptSubmit` and `Stop` is not automated.

## Hook compatibility

Hook compatibility is verified separately. Automatic mode requires the schema of the selected official extension to declare `command` with separate `args`. No minimum Claude version is assumed from that capability. See the [official hook contract](https://code.claude.com/docs/en/hooks#command-hook-fields).

## 1.0.0 record

Local runs with the 1.0.0 VSIX (SHA-256 `2801856e2ab1cec8565d8ebe7beb7d788a1b2dba2cbf7b70961be4cd8ae4bbc8`), on 2026-11-20, Linux x64, runner Node 23.6.0:

| Scenario | Editor | Result |
| --- | --- | --- |
| `test:host` (14 journeys, including installed hook → external Node → rejection) | VS Code 1.147.0, host Node 24.22.1 | passed |
| `test:host` (14 journeys) | Cursor 3.30.14, API 1.128.0, host Node 24.22.1 | passed |
| `test:host:contracts multi-window` | VS Code 1.147.0 | passed |
| `test:host:contracts lifecycle` | VS Code 1.147.0 | passed |
| `test:host:contracts official`, official Claude Code extension 2.1.329 (linux-x64) | VS Code 1.147.0 | passed |

The SHA-256 refers to the package tested on that date, still named `claude-code-launcher`. After it, the extension was renamed `launcher-for-claude-code` (the previous name belongs to another publisher on the Marketplace), and the changelog and manifest changed. The packaged runtime code is the same, but the distributed package has a different hash; the evidence that holds for distribution is the CI run on the published commit. The limits in [Verification scope](#verification-scope) still apply: none of these scenarios proves an authenticated conversation.
