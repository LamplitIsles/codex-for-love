# Codex for Love

This is the Linux x64 and macOS ARM64 standalone app-server runtime. npm
installs the matching pinned platform package automatically; the launcher
selects and verifies its app-server and code-mode host before startup.

The installed main package determines the native package and supported Codex
app-server version. Upgrade the main package to use its selected runtime;
native packages may remain unchanged between application releases. TOML
configures the model and runtime options. `codex.version` is not supported;
remove that field from an existing configuration before upgrading.

The installed `vendor/ecosystem-mcp.example.toml` is an optional, static
example for adding FlickNote and Guion Web after CFL has created its minimal
workspace configuration. The bundled Companion MCP is the only required
integration.

The main package includes the approved shared Framework7 App. `/` and `/chat`
serve identical HTML with root-relative assets; no sibling App checkout or asset
directory override is needed. Platform independently owns hosted authentication,
manifest, service worker and management. The obsolete `/slice` entry is removed.
