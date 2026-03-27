Pocket Server — Release Notes
=============================

Highlights
----------
- **Claude Sonnet 4.5 migration** with updated SDK (v0.67.0) and latest text editor tool
- Enhanced title generation with timeout protection and graceful fallback
- Extended stop reason types for better error handling (refusal, context window exceeded)
- Remote pairing mode protected by one-time tokens and capped retry attempts
- Session asset storage for user image uploads (disk-backed with token-gated retrieval)
- Turn lifecycle telemetry (`agent:turn`) unified across Anthropic and OpenAI providers
- Rich-content OpenAI input builder that reloads persisted images before streaming
- CLI `pair --remote` output prints pairing token and, when available, the public tunnel URL

New
---
- **Claude Sonnet 4.5 migration**
  - Upgraded `@anthropic-ai/sdk` from v0.59.0 to v0.67.0
  - Migrated model from `claude-sonnet-4-20250514` to `claude-sonnet-4-5` across all chat endpoints
  - Updated text editor tool from `text_editor_20250429` to `text_editor_20250728`
  - Extended `StopReason` type to include `refusal` and `model_context_window_exceeded`
  - Enhanced title generation with 1.5s timeout and automatic fallback to heuristic on errors
- Remote pairing flow
  - `pocket-server pair --remote` opens a remote pairing window with PIN + one-time token
  - `/auth/pair` accepts `{ deviceId, pin, pairToken }` during remote windows and rejects other origins
  - Remote attempts are capped; success or too many failures close the window automatically
  - `/auth/pair/status` now reports `mode: "local" | "remote"` for clients
- Session asset pipeline
  - Base64 image uploads persist under `~/.pocket-server/data/sessions/<id>/images`
  - `/agent/session/asset?id=...&file=...` serves images via query-token auth (for `<img>` elements)
  - Session snapshots retain structured blocks so mobile galleries rebuild after reconnect
- Turn lifecycle events
  - Providers emit `agent:turn` events (`created`, `phase`, `done`) mirroring planning / awaiting-tool states
  - Snapshots expose `activeTurn` for quick UI recovery and state handoff after reconnects

Improvements
------------
- OpenAI provider
  - Converts mixed content blocks into Responses API parts, rehydrating persisted images as data URLs
  - Records per-turn metadata and defers tool execution until the assistant turn is committed
  - Saves user messages with structured blocks for accurate history playback
- Anthropic provider
  - Persists user image blocks, emits turn lifecycle events, and logs auto-tool execution metadata
  - Reconstructs base64 images from persisted assets before streaming to Anthropic
- CLI & terminal UI
  - `pair --remote` output prints the pairing token and, if present, the Cloudflare tunnel URL
  - Terminal help clarifies the dual use of `--remote` (start tunnel vs enable remote pairing)
- Auth & pairing
  - `startPairingWindow` tracks mode, tokens, and remote attempt counts
  - `/auth/pair` enforces locality or pair-token validation depending on mode

Compatibility
-------------
- Mobile client must handle `agent:turn` events and session asset URLs
- Remote pairing expects mobile support for PIN + token submission

Upgrade
-------
- Run `pocket-server start` (auto-update default) or `pocket-server update`
- Use `pocket-server pair --remote` only when a public tunnel is active and URL + PIN + token can be shared securely

Environment
-----------
- `OPENAI_API_KEY` — OpenAI provider key
- `ANTHROPIC_API_KEY` — Anthropic provider key
- `CF_TUNNEL_TOKEN`, `CF_TUNNEL_CONFIG`, `CF_TUNNEL_LOGLEVEL` — Cloudflare tunnel (optional)
- `PORT` — HTTP server port (default 3000)


