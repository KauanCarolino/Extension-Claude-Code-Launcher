# How the change log works

When you turn it on, the launcher adds hooks to this project's `.claude/settings.local.json`. On every edit Claude makes (Edit, Write, MultiEdit, NotebookEdit), the hook keeps the content from before and after.

- The hook only observes: it never approves or blocks a tool.
- It runs with the `node` command, which must be on your `PATH`.
- Files such as `.env` and private keys are not copied. Check the exclusions in **Settings › Launcher for Claude Code**.
- Everything stays on your disk; nothing is sent to an external service.

What terminal commands, MCP tools and generators change also goes into the review: the hook notes the project when you send a request and compares at the end of the reply. Those changes show up as **Changed by a command**. To turn this off, use the `claudeCodeLauncher.captureCommandChanges` setting.
