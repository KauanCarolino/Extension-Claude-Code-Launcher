# A project folder

Claude Code indexes conversations by the folder they were started in, and the review keeps its data inside that folder, in `.claude/launcher-changes/`.

That folder gets its own `.gitignore`: nothing in it goes into the repository.

Multi-root workspaces work: each folder has its own change log, skills, rules and MCP servers.
