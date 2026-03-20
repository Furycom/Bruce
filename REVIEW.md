# BRUCE MCP Gateway — Codebase Review

Date: 2026-03-14
Scope: `server.js`, `routes/`, `shared/`, and supporting repository structure.

## 1) Architecture overview

### Current organization
- **`server.js` is a composition root**: it initializes Express, installs process-level handlers, configures CORS/JSON middleware, mounts every route module, wires lightweight dependency injection (`setSafePythonSpawn`), serves OpenAPI, and starts the HTTP server.
- **`routes/` is endpoint-centric**: each file groups one feature domain (`infra`, `session`, `rag`, `chat`, `data-read`, `data-write`, etc.). The API surface is broad and includes internal orchestration endpoints (`/bruce/bootstrap`, `/bruce/integrity`), OpenAI-compat shims, infrastructure controls, and direct data wrappers.
- **`shared/` contains cross-cutting utilities**:
  - auth + token cache/rate limiting (`auth.js`)
  - env/config (`config.js`)
  - helper primitives (`helpers.js`, `fetch-utils.js`)
  - LLM orchestration (`llm-queue.js`, `llm-profiles.js`, `context-engine.js`)
  - infra adapters (`docker-client.js`, `exec-security.js`, `supabase-client.js`)

### Architectural strengths
- Clear folder split between route handlers and shared logic.
- Most route files use a consistent auth-first pattern.
- Context-generation logic is separated from HTTP handlers (`shared/context-engine.js`, `shared/llm-profiles.js`).

### Architectural friction points
1. **God-route modules**: `routes/chat.js`, `routes/session.js`, `routes/rag.js`, and `routes/infra.js` are very large and contain mixed concerns (validation, business rules, transport, external IO, formatting).
2. **No service layer** between route handlers and external integrations (Supabase/LiteLLM/embedder/validation service).
3. **Hardcoded topology** (IPs, ports, fallback tokens) appears across many modules, creating environment lock-in.
4. **Multiple fetch timeout helpers** are duplicated (`shared/fetch-utils.js`, custom wrappers in route files).
5. **Error contract inconsistency** across routes (`500` vs `200 {ok:false}` patterns).

---

## 2) Code quality issues (bugs, anti-patterns, error handling gaps, security)

## A. High-priority bugs / correctness issues

1. **`routes/chat.js` uses `fs` without importing it**.
   - `fs.readFileSync(...)` is called for system prompt loading and SSH key reading, but `const fs = require('fs')` is missing.
   - This silently downgrades behavior in `try/catch` blocks and risks runtime failures in tool execution paths.
   - **Action**: add explicit `fs` import and unit tests around system prompt / SSH helper paths.

2. **Dead code in `shared/supabase-client.js` and `shared/exec-security.js`**.
   - `insertMemoryEvent`, `insertConversationMessage`, and `auditLog` immediately `return` before the actual implementation.
   - Callers think data/audit is being persisted when it is not.
   - **Action**: replace silent early-return with feature flag + explicit warning metric, or delete dead implementation until restored.

3. **Potential crash paths when env values are missing**.
   - Example: `routes/data-read.js` directly calls `SUPABASE_URL.replace(...)` and builds headers from `SUPABASE_KEY` without guarding null/empty config.
   - **Action**: central `assertConfigured('supabase')` helper reused by all routes.

## B. Security concerns

1. **Hardcoded secret fallbacks and token literals in code paths and output**.
   - Default/fallback token strings like `<BRUCE_AUTH_TOKEN>`, `bruce-litellm-key-01`, `token-abc123` are present in runtime request headers and generated command snippets.
   - **Action**: fail-closed when required secrets are missing; never embed defaults that look like real credentials.

2. **Sensitive secret leakage risk in `/bruce/chatgpt` response**.
   - Endpoint returns ready-to-run `curl` commands that include `SUPABASE_KEY` inline.
   - **Action**: return template commands with `${SUPABASE_KEY}` placeholders or one-time short-lived tokens.

3. **Global permissive CORS (`*`)** in `server.js`.
   - If service exposure broadens (reverse proxy/public misconfiguration), this increases abuse surface.
   - **Action**: make origin allowlist configurable (`ALLOWED_ORIGINS`) and default to local/trusted origins.

4. **Shell execution endpoint still risky despite whitelist**.
   - `routes/exec.js` uses `execSync(cmd)` with regex-based filtering; regex whitelists are brittle.
   - **Action**: map explicit tool IDs -> predeclared command argv arrays, use `spawnFile`-style execution with no shell parsing.

## C. Error handling & API contract issues

1. **Inconsistent status semantics**.
   - Some failures return HTTP 200 with `ok:false`; others use 4xx/5xx.
   - **Action**: adopt one API policy:
     - validation/auth errors: 4xx
     - upstream/internal failures: 5xx
     - success only: 2xx

2. **Suppressed exceptions without telemetry**.
   - Many `catch {}` / `catch(_) {}` blocks swallow failures silently.
   - **Action**: at minimum debug-level structured logs with endpoint + dependency + duration.

3. **No centralized error middleware**.
   - Error formatting is duplicated route-by-route.
   - **Action**: add Express error middleware + standard response schema.

## D. Maintainability anti-patterns

1. **Large amounts of embedded infrastructure constants** (IPs, ports, URLs).
2. **Copy-pasted Supabase REST/RPC calling patterns** across many route files.
3. **Mixed language/comments and historical patch markers** (`[773]`, `[902]`, etc.) reduce readability for new contributors.

---

## 3) Refactoring suggestions (actionable)

## Phase 1 (safe, high ROI)

1. **Create a shared `http-clients/` abstraction**:
   - `supabaseClient.request(path, opts)`
   - `litellmClient.chat(payload)`
   - `embedderClient.embed(text)`
   - standard timeout + retries + error mapping.

2. **Extract auth/config guards**:
   - `requireConfigured(['SUPABASE_URL', 'SUPABASE_KEY'])`
   - `requireConfigured(['BRUCE_LLM_API_BASE', 'BRUCE_LLM_MODEL'])`

3. **Normalize API responses** via utility:
   - `ok(res, data, status=200)`
   - `fail(res, code, message, details?)`

4. **Break large routes into service modules**:
   - `routes/chat.js` → `services/chat/openaiCompat.js`, `services/chat/agent.js`, `services/chat/generate.js`
   - `routes/session.js` → `services/session/bootstrap.js`, `services/session/close.js`
   - `routes/infra.js` → health/integrity/topology/maintenance services.

## Phase 2 (behavioral hardening)

5. **Replace regex command filtering** with command registry.
6. **Remove implicit secrets defaults** and fail fast on boot for required secrets.
7. **Consolidate environment topology** into config maps (single source of truth).
8. **Introduce structured logging (`pino`/`winston`) with correlation IDs**.

## Phase 3 (scalability/quality)

9. **Introduce schema validation** for request bodies (Zod/Joi) across all write endpoints.
10. **Add circuit breakers and retry/backoff policy** for unstable upstreams.
11. **Add linting and formatting pipeline** (`eslint`, `prettier`) with CI gates.

---

## 4) Missing tests (what should be added first)

## A. Unit tests
- `shared/auth.js`
  - token extraction from `Authorization` and `x-bruce-token`
  - scope enforcement (`requiredScope`) and rate limit behavior
  - fallback legacy token behavior when cache is empty
- `shared/helpers.js`
  - `safeJoinManual` traversal protection
  - `bruceClampInt` edge cases
- `shared/exec-security.js`
  - whitelist/blacklist precedence matrix

## B. Integration tests (supertest + mocked upstreams)
- **Auth smoke for every critical route** (`/bruce/write`, `/bruce/exec`, `/bruce/session/init`, `/bruce/llm/chat`).
- **Error contract tests**: verify non-2xx for failures after response policy is standardized.
- **Supabase unavailable tests**: routes should degrade predictably and return actionable errors.
- **RAG pipeline tests**: embedder timeout, empty embedding, invalid RPC response.

## C. Security tests
- command injection attempts against `/bruce/exec`
- path traversal attempts against manual/file endpoints
- secret redaction tests in responses/logs

## D. Regression tests for known risks
- `routes/chat.js` system prompt + SSH codepath test (ensures `fs` import remains present)
- endpoints currently returning 200 on failures should be pinned until contract migration is complete

---

## 5) Documentation gaps

1. **No repository-level architecture document**.
   - Add `docs/architecture.md` with module boundaries, request flow, and dependency map.

2. **No API reference/source-of-truth docs**.
   - OpenAPI is partially in `server.js` and not complete for many BRUCE routes.
   - Move to dedicated `openapi/` files and validate in CI.

3. **No environment variable contract**.
   - Add `docs/configuration.md` + `.env.example` describing required vs optional variables and defaults.

4. **No operational runbook**.
   - Add `docs/operations.md` for health checks, recovery, dependency expectations, and bootstrap sequence.

5. **No testing guide**.
   - Add `docs/testing.md` with test stack, local execution, and mock strategies for Supabase/embedder/LiteLLM.

---

## Suggested implementation order (pragmatic)
1. Fix correctness/security quick wins (`fs` import, secret defaults removal, explicit dead-code behavior).
2. Add baseline tests around auth/config/exec-security + one integration suite.
3. Introduce shared client abstraction and response normalization.
4. Split large route files and document architecture/API/config.

