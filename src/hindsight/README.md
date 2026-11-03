# hindsight

[Hindsight](https://github.com/vectorize-io/hindsight) gives AI agents long-term memory. An agent
**retains** what it learns, **recalls** it later by meaning, and can **reflect** across everything in
a memory bank. Agents use it over a REST API or MCP; a web UI browses and manages the banks.
MIT-licensed, by Vectorize. Hola is not affiliated with them.

## What you need

An LLM for Hindsight's own work: extracting facts from what agents retain, consolidating them, and
reflecting. Pick it at install:

| Provider | What to enter |
| --- | --- |
| **Anthropic** (default) | An Anthropic API key. The default model is `claude-haiku-4-5`; set *LLM Model* to change it. |
| OpenAI, Gemini, Groq | That provider's API key. |
| Ollama, LM Studio | *LLM Base URL* pointing at your server (e.g. `http://ollama.lan:11434/v1`); no key. |
| None | Nothing. Retain stores the raw text and recall searches it; no fact extraction or reflect. |

Embeddings (`BAAI/bge-small-en-v1.5`) and reranking (`cross-encoder/ms-marco-MiniLM-L-6-v2`) run
locally inside the container, so the LLM key is the only external dependency. With a hosted provider,
the text agents retain is sent to that provider for extraction.

Plan on 3–4 GB of RAM. The API image is about 2.8 GB because it carries the local models.

## Connecting an agent

Two settings, both shown in the app's configuration in Hola:

- **URL:** `https://<app-host>/mcp/<bank>/`, where `<bank>` is any name; a bank is created on first
  use, and banks are isolated from one another.
- **Agent API Key:** generated at install. Send it as `Authorization: Bearer <key>`.

Claude Code:

```sh
claude mcp add --transport http hindsight https://<app-host>/mcp/my-project/ \
  --header "Authorization: Bearer <agent-api-key>"
```

The REST API is under `https://<app-host>/v1/` with the same key (e.g.
`GET /v1/default/banks`). Upstream's SDKs and integrations take the base URL `https://<app-host>`.

## How it is packaged

| Service | Image | Role |
| --- | --- | --- |
| `hindsight` | `nginxinc/nginx-unprivileged` | The ingress. Sends `/v1/` and `/mcp` to the API and everything else to the UI. Upstream serves them on two ports; Hola routes one. |
| `hindsight-api` | `vectorize-io/hindsight-api` (full tag) | Memory server, REST and MCP. |
| `hindsight-ui` | `vectorize-io/hindsight-control-plane` | Web UI. Calls the API server-side with the key, so the browser never holds it. |
| `hindsight-db` | `pgvector/pgvector` (Postgres 18) | All state: `${HOLA_APP_DATA}/postgres`. |

## Auth

`forward-auth`, split by path:

- **The UI** is behind Authentik, like any Hola app. Upstream's own UI access key is left unset so
  there is no second login.
- **`/v1/` and `/mcp`** bypass Authentik, because agents can't complete a browser login. They are not
  open: Hindsight's `ApiKeyTenantExtension` rejects any REST or MCP call without the Agent API Key
  (`401`). The one unauthenticated answer is MCP's session-less `GET` probe, which returns `{}`.

Anyone holding the key can read and write every bank. Treat it like a password; to rotate it, change
*Agent API Key* in the app's configuration and redeploy.

## Backup and restore

`backup@1`: the pre-hook writes a `pg_dump` to `${HOLA_APP_DATA}/backups/hindsight.sql` and the
post-hook removes it. `restore@1`: the live database directory is discarded and the dump is replayed
into a fresh one.

## Upgrades

Hindsight migrates its schema on start, so take a snapshot before upgrading
(`preUpgradeBackup: recommended`).
