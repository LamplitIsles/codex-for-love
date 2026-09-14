# Keep Companion tools current and relationship state workspace-owned

Status: proposed

Codex thread metadata snapshots dynamic tool definitions, which made imported threads lose CFL tools and would make old threads retain stale schemas. CFL will instead expose its relationship and dice capabilities through a workspace-configured Companion MCP, while an append-only `.lamplit/relationship.jsonl` Relationship Journal becomes the sole relationship source of truth and the MCP server its only runtime writer. CFL reads that journal for UI and context projection; Codex conversation history records tool activity but owns neither the current tool catalogue nor relationship state. Affinity movement is bounded to ±10 per update call, avoiding private Codex turn metadata and cross-process coordination.
