# Operit Honcho

Operit ToolPkg integration for [Honcho v3](https://honcho.dev), modeled after the official Hermes Honcho memory provider.

## Features

- Persists completed user and assistant messages from Operit's `message_persisted` hook.
- Maintains a separate Honcho session per Operit chat, or one global session when configured.
- Injects session summary, user representation, peer card, AI representation, AI card, and dialectic context into the latest user input without modifying stored chat content.
- Adds only a small static mode marker to the system prompt, preserving prompt-cache stability.
- Supports `hybrid`, `context`, and `tools` recall modes.
- Retries failed writes once, retains unsent messages in memory, deduplicates hook replays, and flushes on application termination.
- Fails open: Honcho outages never block the original Operit conversation.
- Supports Honcho Cloud and unauthenticated self-hosted deployments.
- Adds a compact read-only `Honcho Explore` main-sidebar panel for Workspace, Peer, Session, Message, Conclusion, queue, and local write status.
- Uses a fixed, validated IPC operation allowlist so the UI never receives the API key or constructs Honcho HTTP requests.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): current modules, data model, hooks, persistence, recall, tools, configuration, and failure behavior.
- [Explore UI plan](docs/EXPLORE_UI_PLAN.md): Operit sidebar information architecture, Honcho Dashboard feature mapping, IPC/API design, delivery phases, and acceptance criteria.
- [Explore remediation plan](docs/EXPLORER_REMEDIATION_PLAN.md): duplicate prevention, message upload boundaries, prompt-cache sidecars, Peer identity management, filtering, timezone, performance, migration, and acceptance criteria for the verified device issues.
- [Agent guide](AGENTS.md): repository-specific implementation, testing, security, and release rules.

## Tools

The `honcho` subpackage exposes five Hermes-compatible tools:

| Tool | Behavior |
| --- | --- |
| `honcho_profile` | Read or replace a peer card. No LLM call. |
| `honcho_search` | Hybrid search over raw messages across sessions. No LLM call. |
| `honcho_context` | Read the current session summary, representation, card, and recent messages. |
| `honcho_reasoning` | Ask Honcho's dialectic agent to synthesize an answer about a peer. |
| `honcho_conclude` | Create, list/search, or delete persistent conclusions. |

Every tool accepts `peer` as `user`, `ai`, or a custom peer ID. Session-scoped tools default to the current Operit chat and optionally accept `chat_id`.

## Install

Build and package the project:

```bash
cd /root/workspace/operit-honcho
npm run pack
```

The artifact is written to:

```text
/root/workspace/operit-honcho/build/operit-honcho-0.1.0.toolpkg
```

Import that file as an Operit Sandbox Package, enable the `com.operit.honcho` ToolPkg, and keep its `honcho` subpackage enabled.

## Configuration

For Honcho Cloud, set at least:

```text
HONCHO_API_KEY=<your key>
```

For self-hosted Honcho, set:

```text
HONCHO_BASE_URL=http://127.0.0.1:8000
```

A configured API key or explicit base URL enables the integration automatically unless `HONCHO_ENABLED=false` is set.

| Variable | Default | Description |
| --- | --- | --- |
| `HONCHO_ENABLED` | auto | Master switch. |
| `HONCHO_API_KEY` | empty | Bearer token for Honcho Cloud. |
| `HONCHO_BASE_URL` | `https://api.honcho.dev` | Explicit value also enables self-hosted mode. |
| `HONCHO_WORKSPACE` | `operit` | Workspace ID. |
| `HONCHO_USER_PEER` | `user` | Stable user peer ID. |
| `HONCHO_AI_PEER` | `operit` | Stable Operit AI peer ID. |
| `HONCHO_RECALL_MODE` | `hybrid` | `hybrid`, `context`, or `tools`. |
| `HONCHO_OBSERVATION_MODE` | `directional` | `directional` or `unified`. |
| `HONCHO_SAVE_MESSAGES` | `true` | Persist completed chat messages. |
| `HONCHO_SESSION_STRATEGY` | `per-chat` | `per-chat` or `global`. |
| `HONCHO_CONTEXT_TOKENS` | `2000` | Context API and injection budget. |
| `HONCHO_CONTEXT_CADENCE` | `1` | Turns between base-context refreshes. |
| `HONCHO_DIALECTIC_CADENCE` | `2` | Turns between automatic dialectic calls. |
| `HONCHO_DIALECTIC_REASONING_LEVEL` | `low` | `minimal`, `low`, `medium`, `high`, or `max`. |
| `HONCHO_DIALECTIC_MAX_CHARS` | `600` | Automatic dialectic injection cap. |
| `HONCHO_MESSAGE_MAX_CHARS` | `25000` | Maximum message chunk size. |
| `HONCHO_INJECTION_FREQUENCY` | `every-turn` | `every-turn` or `first-turn`. |

`context` mode disables automatic tool guidance and uses context injection only, while the installed ToolPkg subpackage remains visible in Operit's package registry. `tools` mode skips all automatic context calls. `hybrid` enables both behaviors.

## Architecture

- `src/main.ts`: ToolPkg hook, Explorer IPC, Compose UI route, and sidebar registration.
- `src/explorer/`: validated read-only Explorer operations, DTOs, error mapping, and API dispatch.
- `src/ui/honcho_explore/`: compact Compose DSL views for status and paged entity browsing.
- `src/controller.ts`: per-chat state, context cadence, deduplication, write queue, retry, and tool dispatch.
- `src/api.ts`: dependency-free Honcho v3 REST client.
- `src/packages/honcho.ts`: ToolPkg `METADATA` and five tool exports.
- `src/format.ts`: memory block sanitization, formatting, and bounded injection.

State is intentionally process-local. Successfully persisted memory lives in Honcho; unsent retries are not written to local disk and therefore cannot survive a forced process kill.

## Development

```bash
npm test
npm run pack
```

Tests use a mocked Honcho transport and cover configuration, formatting, ID limits, REST request mapping, chunking, prompt injection, deduplication, retry retention, custom peer creation, and hook registration.