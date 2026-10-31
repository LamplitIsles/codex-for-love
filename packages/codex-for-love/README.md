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

Optional root TOML `frontend = "latest"` resolves canonical App main at each
startup. Set `frontend` to a full lowercase commit SHA for a reproducible version
or rollback. Without the field, the bundled App is used without network or Bun.
Configured selection needs network access to GitHub and dependency registries,
`curl`, `tar`, and Bun 1.3.14 on PATH; initial preparation can take minutes.
CFL logs the resolved revision and stops on download, build, integrity, or
compiled-contract mismatch; it never falls back to the bundled App. An exact
verified cached revision can start offline. Reload browser pages after restarting.

Browser access requires a Passkey. Start CFL, then run
`codex-for-love pair /path/to/partner.toml` on the host and enter the one-use code at
`http://localhost:3082` (or your configured origin). For remote use set the
exact HTTPS `origin` in the TOML and terminate TLS at a trusted reverse proxy.
Keep the private `state` directory, including `auth.db`, across restarts.
Generate another code to recover access; existing Passkeys and sessions are
revoked only after the replacement enrollment succeeds. Current native clients
need a later authentication update. Post and Keet use their own separate
receiver credentials and do not have browser access.

The complete operator instructions are in the CFL repository's operator guide.
