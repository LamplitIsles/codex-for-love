// Test entrypoint installs the no-network audio fixture before the real MCP.
import './fake-voice-fetch.mjs';
await import('../runtime/companion-mcp.ts');
