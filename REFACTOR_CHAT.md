# Plan de découpage de `routes/chat.js` (analyse statique uniquement)

## Constat
Le fichier `routes/chat.js` regroupe aujourd'hui plusieurs domaines fonctionnels :
- proxy LLM « bas niveau » (`/bruce/config/llm`, `/bruce/llm/models`, `/bruce/llm/chat`),
- compatibilité OpenAI (`/api/openai/v1/*`, `/v1/*`),
- endpoint de génération (`/bruce/llm/generate`) avec logique RAG,
- endpoint conversationnel `/chat` avec persistance mémoire,
- agent outillé (`/bruce/agent/chat`) avec exécution d'outils système.

---

## 1) Blocs logiques identifiés dans le fichier actuel

### A. Bootstrap + imports + utilitaires proxy
**Responsabilité**: initialisation express, imports partagés, helpers de timeout et base URL LLM.
- Helpers concernés : `bruceLlmBase`, `bruceFetchWithTimeout`.

### B. Configuration LLM
**Routes**:
- `GET /bruce/config/llm`

**Responsabilité**:
- Exposer la config LLM courante (base + model) sous authentification Bruce.

### C. Proxy modèles/chat vers backend LLM
**Routes**:
- `GET /bruce/llm/models`
- `POST /bruce/llm/chat`

**Responsabilité**:
- Relayer requêtes vers backend OpenAI-compatible (`/models`, `/chat/completions`),
- Appliquer auth Bruce et timeout,
- Bloquer le streaming via ce proxy MCP.

### D. Shim OpenAI-compatible
**Routes**:
- `GET /api/openai/v1/models`
- `GET /v1/models`
- `POST /api/openai/v1/chat/completions`
- `POST /v1/chat/completions`

**Responsabilité**:
- Offrir interface OpenAI minimale (liste modèles + chat completions),
- Gérer format erreurs OpenAI,
- Supporter pseudo-stream SSE côté réponse.

### E. Génération LLM avec injection RAG
**Routes**:
- `POST /bruce/llm/generate`

**Responsabilité**:
- Normaliser `messages[]`/`prompt`,
- Appliquer la gate RAG stricte (`rag===true`),
- Construire/injecter contexte RAG (`bruceRagContext`),
- Retourner métadonnées `rag_used` / `rag_error`.

### F. Chat applicatif avec journalisation mémoire
**Routes**:
- `POST /chat`

**Responsabilité**:
- Validation structure messages,
- Contrôle taille message,
- Persistance événements/messages (Supabase),
- Appel LLM + réponse conversationnelle.

### G. Agent BRUCE + outils
**Routes**:
- `POST /bruce/agent/chat`

**Responsabilité**:
- Charger prompt système fichier,
- Déclarer catalogues d'outils,
- Exécuter outils (`ssh_exec`, `docker_list`, `query_homelab_db`, `write_file`, `batch_process`),
- Orchestrer boucle LLM tool-calls (appel initial + follow-up),
- Gérer compat fallback `<tool_call>...</tool_call>`.

---

## 2) Proposition de découpage en plusieurs fichiers

Objectif: conserver le comportement actuel tout en séparant clairement les responsabilités.

### Fichier proposé 1 — `routes/llm-config.routes.js`
**Contiendrait**:
- `GET /bruce/config/llm`

**Dépendances partagées à extraire**:
- middleware `requireBruceAuth` (wrapping de `validateBruceAuth`),
- helper de réponse d'erreur auth standard Bruce.

---

### Fichier proposé 2 — `routes/llm-proxy.routes.js`
**Contiendrait**:
- `GET /bruce/llm/models`
- `POST /bruce/llm/chat`

**Dépendances partagées à extraire**:
- `getLlmBaseUrl()` (normalisation base URL),
- `fetchWithLlmTimeout()` (timeout + abort),
- `buildLlmAuthHeaders()` (Bearer conditionnel),
- utilitaire de relay de réponse upstream (`status`, `content-type`, body texte).

---

### Fichier proposé 3 — `routes/openai-compat.routes.js`
**Contiendrait**:
- `GET /api/openai/v1/models`
- `GET /v1/models`
- `POST /api/openai/v1/chat/completions`
- `POST /v1/chat/completions`

**Dépendances partagées à extraire**:
- helpers de format OpenAI (`makeOpenAiId`, `unixNow`, `sendOpenAiError`),
- mappeurs message request/response OpenAI,
- helper SSE OpenAI (`writeOpenAiSseChunks`).

---

### Fichier proposé 4 — `routes/llm-generate.routes.js`
**Contiendrait**:
- `POST /bruce/llm/generate`

**Dépendances partagées à extraire**:
- `normalizeMessagesFromBody(body)` (prompt/messages),
- `applyRagInjection(body)` (gate + query extraction + enrichissement),
- utilitaire de nettoyage citations factices,
- helper de réponse standard `{ ok, model, message, timestamp }`.

---

### Fichier proposé 5 — `routes/chat-memory.routes.js`
**Contiendrait**:
- `POST /chat`

**Dépendances partagées à extraire**:
- validateurs de messages (`validateChatMessages`, `validateLastMessage`),
- service mémoire (`logIncomingMessage`, `logOutgoingMessage`) encapsulant Supabase,
- générateur de `conversation_id` par défaut.

---

### Fichier proposé 6 — `routes/agent-chat.routes.js`
**Contiendrait**:
- `POST /bruce/agent/chat`

**Dépendances partagées à extraire**:
- service `systemPrompt.service.js` (lecture + parse creds),
- service `agent-tools.registry.js` (catalogue `AVAILABLE_TOOLS`),
- service `agent-tools.executor.js` (`executeTool` + sous-exécutants),
- client LLM agent (`agentLlmClient.js`: base URL, timeout, appels chat completions),
- helper parsing legacy tool call (`parseLegacyToolCallFromContent`),
- helper `clampStr`.

---

## 3) Dépendances transverses à extraire (mutualisation)

### a) Middleware Auth Bruce
Fichier suggéré: `middleware/bruce-auth.js`
- `requireBruceAuth(req, res, next)`
- Option `mode: 'openai' | 'bruce'` pour formatter l'erreur selon endpoint.

### b) Client LLM partagé
Fichier suggéré: `services/llm-client.js`
- `getBaseUrl`, `getTimeoutMs`, `buildHeaders`, `fetchJson`, `fetchText`.

### c) Normalisation et validation des messages
Fichier suggéré: `services/chat-message-normalizer.js`
- Normalisation rôle/contenu,
- Validation de structure,
- Règles limites longueur.

### d) Utilitaires de réponse
Fichier suggéré: `services/http-response-helpers.js`
- Relay upstream,
- Erreurs standardisées,
- Réponses timestampées.

### e) Services RAG
Fichier suggéré: `services/rag-injection.js`
- Extraction de query,
- Appel `bruceRagContext`,
- Insertion bloc système RAG,
- Métadonnées `rag_used` / `rag_error`.

---

## 4) Ordre de migration recommandé (sans rupture)
1. **Étape 1**: Extraire utilitaires purs (auth wrapper, llm client, normalizer) sans changer les routes.
2. **Étape 2**: Déplacer `/bruce/config/llm` et `/bruce/llm/*` vers fichiers dédiés.
3. **Étape 3**: Déplacer shim OpenAI dans son routeur dédié.
4. **Étape 4**: Déplacer `/bruce/llm/generate` + service RAG.
5. **Étape 5**: Déplacer `/chat` + service mémoire.
6. **Étape 6**: Déplacer agent `/bruce/agent/chat` en dernier (partie la plus couplée et risquée).
7. **Étape 7**: Conserver `routes/chat.js` comme agrégateur temporaire puis supprimer quand stable.

---

## 5) Cibles de structure finale (exemple)

```text
routes/
  llm-config.routes.js
  llm-proxy.routes.js
  openai-compat.routes.js
  llm-generate.routes.js
  chat-memory.routes.js
  agent-chat.routes.js
services/
  llm-client.js
  rag-injection.js
  chat-message-normalizer.js
  systemPrompt.service.js
  agent-tools.registry.js
  agent-tools.executor.js
middleware/
  bruce-auth.js
```

Cette proposition reste **strictement un plan de découpage** (analyse statique), sans refactoring appliqué au code existant.
