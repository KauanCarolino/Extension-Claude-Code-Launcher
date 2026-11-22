# How the change log works

When you turn it on, the launcher adds two hooks to this project's `.claude/settings.local.json`. On every edit Claude makes (Edit, Write, MultiEdit, NotebookEdit), the hook keeps the content from before and after.

- The hook only observes: it never approves or blocks a tool.
- It runs with the `node` command, which must be on your `PATH`.
- Files such as `.env` and private keys are not copied. Check the exclusions in **Settings › Launcher for Claude Code**.
- Everything stays on your disk; nothing is sent to an external service.

Terminal commands (Bash, PowerShell) don't go through the hook. When Claude runs a command that may have written files, the **Changes** panel tells you.
