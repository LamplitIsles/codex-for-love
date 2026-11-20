# Codex for Love

This standalone runtime supports Linux x64, requires Node 24 and `curl`, and
selects Codex 0.170.0 from an exact Forgejo release. The first start downloads
and verifies the archive; verified cached files support offline startup. Protect
`$XDG_CACHE_HOME/lamplitisles/codex-for-love/codex` (or the equivalent under
`~/.cache`) as private service-account state. A corrupt cache is replaced only
after a successful verified download. Public npm releases are paused; obtain a
reviewed CFL snapshot from the Forgejo registry. `codex.version` is unsupported.

The installed `vendor/ecosystem-mcp.example.toml` is an optional, static
example for adding FlickNote and Guion Web after CFL has created its minimal
workspace configuration. The bundled Companion MCP is the only required
integration.

The main package does not include browser resources. `/` and `/chat` serve
identical HTML from the selected App with root-relative assets; no sibling App
checkout or asset directory override is needed. Platform independently owns hosted authentication,
manifest, service worker and management. The obsolete `/slice` entry is removed.

An omitted root TOML `frontend` defaults to `"latest"`, resolving canonical App
main at each startup. Set `frontend` to a full lowercase commit SHA for a
reproducible version or rollback. Initial preparation needs `curl` and network
access to the matching prebuilt Forgejo App package. A newly merged revision may
need time for its release to be published.
CFL logs the resolved revision and stops on download, integrity, or
compiled-contract mismatch; it never falls back to another App. An exact
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
