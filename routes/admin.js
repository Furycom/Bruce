'use strict';
const { Router } = require('express');
const { validateBruceAuth } = require('../shared/auth');
const { GATEWAY_PUBLIC_URL } = require('../shared/config');
const router = Router();

router.get('/admin', (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || 'Unauthorized' });
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>MCP Gateway Admin</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 0; background-color: #0f172a; color: #e5e7eb; }
    header { padding: 1rem 2rem; background: #020617; border-bottom: 1px solid #1e293b; }
    h1 { margin: 0; font-size: 1.5rem; }
    main { padding: 1.5rem 2rem; display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.5rem; }
    .card { background: #020617; border-radius: 0.75rem; border: 1px solid #1e293b; padding: 1rem 1.25rem; box-shadow: 0 10px 25px rgba(15,23,42,0.8); }
    .card h2 { margin-top: 0; font-size: 1.1rem; margin-bottom: 0.5rem; }
    .small { font-size: 0.85rem; color: #9ca3af; }
    a { color: #38bdf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: #020617; padding: 0.15rem 0.25rem; border-radius: 0.25rem; font-size: 0.85rem; }
    ul { padding-left: 1.25rem; }
    li { margin-bottom: 0.25rem; }
  </style>
</head>
<body>
  <header>
    <h1>MCP Gateway Admin</h1>
    <div class="small">Central tools & connectors hub for Yann's homelab</div>
  </header>
  <main>
    <section class="card">
      <h2>Health & status</h2>
      <p class="small">Quick JSON endpoints to check if core components are alive.</p>
      <ul>
        <li><code>GET /health</code> – MCP gateway health (Supabase + manual mount)</li>
        <li><code>GET /connectors</code> – Status of configured connectors</li>
      </ul>
      <p>Example:</p>
      <pre><code>curl ${GATEWAY_PUBLIC_URL}/health
curl ${GATEWAY_PUBLIC_URL}/connectors</code></pre>
    </section>

    <section class="card">
      <h2>Tools</h2>
      <p class="small">HTTP endpoints exposed as tools to LLM agents.</p>
      <ul>
        <li><code>GET /tools</code> – List available tools</li>
        <li><code>POST /tools/echo</code> – Echo back JSON payload</li>
        <li><code>POST /tools/supabase/exec-sql</code> – Execute SQL via Supabase RPC</li>
      </ul>
      <p>Example:</p>
      <pre><code>curl -X POST ${GATEWAY_PUBLIC_URL}/tools/echo \\
  -H "Content-Type: application/json" \\
  -d '{"message": "hello from MCP"}'</code></pre>
    </section>

    <section class="card">
      <h2>Homelab manual integration</h2>
      <p class="small">Expose the MkDocs manual to LLM agents via simple HTTP endpoints.</p>
      <ul>
        <li><code>GET /manual/pages</code> – List all markdown pages</li>
        <li><code>GET /manual/page?path=vms/mcp-gateway-vm.md</code> – Get raw markdown content</li>
        <li><code>GET /manual/search?query=furyai</code> – Search the manual</li>
      </ul>
      <p>Examples:</p>
      <pre><code>curl "${GATEWAY_PUBLIC_URL}/manual/pages"
curl "${GATEWAY_PUBLIC_URL}/manual/page?path=vms/mcp-gateway-vm.md"
curl "${GATEWAY_PUBLIC_URL}/manual/search?query=furyai"</code></pre>
      <p class="small">These endpoints are designed to be used by local LLMs via the MCP ecosystem, not exposed to the public internet.</p>
    </section>
  </main>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

module.exports = router;
