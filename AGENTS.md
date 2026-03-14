# AGENTS.md - Codex instructions for BRUCE MCP Gateway

## Project overview
This is the BRUCE MCP Gateway, a Node.js/Express API server for a homelab AI orchestration platform.
Entry point: server.js (minimal orchestrator, ~163 lines). Routes in routes/ (19 files). Shared modules in shared/ (9 files).

## Architecture rules
- server.js MUST remain a minimal orchestrator. No business logic, no large schemas.
- Large schemas or config objects belong in shared/ as separate modules.
- Routes handle HTTP only. Business logic should be extracted into shared/ helpers.
- All infrastructure URLs/IPs must go through shared/config.js via process.env with defaults.

## Code conventions
- Error responses: res.status(code).json({ ok: false, error: 'description' })
- Success responses: res.json({ ok: true, data: ... })
- Auth: use validateBruceAuth(req) as a function call (NOT as Express middleware).
- Never use catch(_) {} - always log errors.
- author_system is always 'claude'.

## Testing
- Run: cd mcp-gateway && npm test
- Always run node --check on modified files

## Review guidelines
- Reject any PR that adds >50 lines to server.js
- Reject PRs with silent catch blocks
- Reject PRs with hardcoded IPs/ports outside shared/config.js
- Verify node --check passes on all modified files
- Flag PRs that change auth logic or add dependencies without justification