# Keep ecosystem MCPs optional and Companion-owned

Status: accepted

CFL starts with its bundled Companion MCP as the only CFL-provided required integration. When no project Codex configuration exists, CFL creates the minimal configuration; when one already exists, it updates only its Companion entry and owned SessionStart hook, because their paths are installation- and workspace-specific. `flicknote` and `web` are instead declared in a static, operator-copyable ecosystem TOML template, and are never required by startup readiness. `project` is excluded because its public npm package is a Pi extension rather than a supported Codex MCP installation surface; `guion-email` remains excluded until its integration is mature. This makes the standalone product runnable without the Lamplit host ecosystem while preserving an intentional, inspectable way to opt into it.
