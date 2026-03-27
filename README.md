Pocket Server
=============

An OS for your agents, built for your pocket.

Pocket Server is the local runtime of Pocket — the mobile operating system for AI agents. It runs on your machine and exposes HTTP + WebSocket APIs so your phone can host, control, and collaborate with agents against your codebase in real time.

Your coding agents, file system, and terminal — all in your pocket.

Core OS capabilities
--------------------

- Agent runtime and tools: approve or auto‑run coding agents with bash, editor, and web‑search tools
- Native mobile terminal: fast, touch‑optimized, multi‑tab sessions with smooth streaming
- File system + editor: browse, view, edit, and diff files from your phone
- Repo search: quick search and telescopic fuzzy search across code
- Background/cloud agents: launch autonomous coding jobs on VMs from GitHub repos; monitor, review diffs, and approve PRs
- Notifications: opt‑in device notifications for task updates
- Security model: PIN pairing (local by default), optional remote pairing with one‑time token; short‑lived tokens for HTTP/WS
- Remote access: optional Cloudflare tunnel (`pocket-server start --remote`); remote pairing via `pocket-server pair --remote`
- Versioned releases: macOS (arm64, x64) and Linux (x64), with bundled Node v22.18.0

Mission
-------

Make agents native to your phone — fast, local‑first, and secure. Pocket provides OS‑like primitives for agents (sessions, processes, filesystem, networking, notifications) with a server‑authoritative model and an event‑driven UI.

Architecture at a glance
------------------------

- Server‑authoritative conversations and sessions (no state in the app)
- Event‑driven protocol over WebSocket (`/ws`) and REST endpoints (Hono)
- Bundled Node.js runtime (v22.18.0) in releases — no system Node required
- Multi‑architecture releases: macOS (arm64, x64) and Linux (x64)

Install (recommended)
---------------------

Use the one‑liner installer (adds a `pocket-server` CLI to `~/.pocket-server/bin`):

```bash
curl -fsSL https://www.pocket-agent.xyz/install | bash
```

Quick start from your terminal
------------------------------

```bash
# 1) Pair your phone to this machine (PIN shows in the terminal)
pocket-server pair

# or enable remote pairing (PIN + token; prints public URL if available)
pocket-server pair --remote

# 2) Start locally (default port 3000)
pocket-server start

# 3) Optional: expose a temporary remote URL via Cloudflare
pocket-server start --remote

> Remote access notes
> - macOS and Linux: `--remote` works out‑of‑the‑box. The CLI auto‑downloads `cloudflared` on first run (no account/config needed) and prints a public HTTPS URL.
>
> Auto‑update notes
> - On `start`, the CLI checks for a newer release and will auto‑install it if found (preserving your flags). Skip with `--no-auto-update`.
```

Use it with the Pocket mobile app
---------------------------------

1. Install Pocket Server (above)
2. Download the mobile app and open it:
   - iOS (TestFlight): https://testflight.apple.com/join/ZHNpHgwd
   - Website: https://www.pocket-agent.xyz
3. Pair this device → Enter the 6‑digit PIN from `pocket-server pair`
4. Start the server (`pocket-server start`), then connect from the app
5. For remote access, run `pocket-server start --remote` and paste the public URL in the app. To pair over the internet, run `pocket-server pair --remote` and enter URL + PIN + Token in the app.


Mobile working directory selection
----------------------------------

- From the Servers screen
  - Connect to your server. If no working directory is set, the app opens a full‑screen file browser.
  - Select your project folder. You land in Chat by default; if you launched Terminal, you land in Terminal.
- From within Chat or Terminal
  - Tap the header to open a compact working directory picker. Choose a folder to switch immediately.
- The server uses the selected directory for agent tools and terminal sessions.


AI providers
------------

- OpenAI (GPT‑5) and Anthropic (Claude) are supported. By default, agent traffic uses OpenAI unless a client explicitly selects `provider: "anthropic"`.
- Provide API keys via environment variables or per‑message from the client:
  - `OPENAI_API_KEY` for OpenAI (Responses API; function calling, parallel tools)
  - `ANTHROPIC_API_KEY` for Anthropic
- The server emits a unified `agent:*` event stream to clients regardless of provider.


CLI reference
-------------

```
pocket-server <command> [flags]

Commands
  start        Start the server
  pair         Start the server and open pairing window (supports --remote)
  stop         Stop a running server
  update       Update to the latest release via installer
  terminal     Terminal utilities (sessions, attach, select)
  help         Show help

Flags
  --port, -p <n>        Port to listen on (default: 3000 or $PORT)
  --remote, -r          Start Cloudflare tunnel for remote access (start) or enable remote pairing (pair)
  --no-auto-update      Skip pre-start update check
  --duration <ms>       Pairing window duration (pair only; default: 60000)
  --pin <code>          Override generated PIN (pair only)
```

Terminal commands (resume sessions on desktop)
----------------------------------------------

Pocket Server can attach your mobile terminal sessions on your desktop terminal. No pairing or token is required on your own machine — the CLI and server exchange a local secret under `~/.pocket-server/data/runtime/local-ws.key`.

```
# List active terminal sessions with indices
pocket-server terminal sessions

# Attach by index (from the list)
pocket-server terminal attach 2

# Attach by title (case-insensitive, supports spaces)
pocket-server terminal attach --name "Opencode"
# or positional query
pocket-server terminal attach "Opencode"

# Attach by id
pocket-server terminal attach --id term:/path#3

# JSON output for tooling
pocket-server terminal sessions --json

# Optional: specify a port if not 3000
pocket-server terminal attach 1 --port 3010

# Select (helpers & interactive)
pocket-server terminal select --name "Opencode"
pocket-server terminal select --index 2
pocket-server terminal select --pick    # interactive picker
```


Notes
- Attach streams the session interactively into your current terminal. Press Ctrl+C to detach without closing the remote PTY.
- The desktop attach replays terminal output to reconstruct the TUI exactly as you left it on mobile. It does not clear your local terminal.
- Session titles come from the mobile tabs; you can long‑press to rename on mobile and they’ll appear here.
- Voice dictation on mobile: the Terminal screen supports speech‑to‑text and streams text as normal input to the PTY.

Auth & connection model
-----------------------

- Pairing:
  - Local (default): your phone pairs over LAN using a time‑boxed PIN to obtain a device secret
  - Remote (optional): enable with `pocket-server pair --remote`; pair using URL + PIN + one‑time token (short TTL, limited attempts)
- Auth tokens: short‑lived access tokens are derived from the device secret; HTTP uses `Authorization: Pocket <token>`, WS connects with `?token=...` (invalid tokens close with 4401)
- Server‑authoritative: sessions and messages live on the server under `~/.pocket-server/data/`
- Event stream: UI subscribes to events; no client‑side shared state

Troubleshooting
---------------

- Can’t connect from phone on local network
  - Ensure both phone and server machine are on the same Wi‑Fi/LAN
  - Check firewall allows inbound connections to your chosen port (default 3000)
  - Try `pocket-server start --port 3010` and connect to that port

- Pairing fails
  - Ensure pairing window is active (`pocket-server pair` or `pocket-server pair --remote`)
  - For remote pairing, you must enter URL + PIN + Token exactly as shown
  - Keep the terminal with `pocket-server pair` open until you finish pairing

- Remote URL stops working
  - Cloudflare quick tunnel URLs change after restart; run `pocket-server start --remote` again and update the URL in the app

- Update to the latest version
  - Run `pocket-server update` (re‑runs the installer and switches `latest.json` version)

Advanced: run from source (development)
---------------------------------------

```bash
cd pocket-server
npm install
npm run dev     # watch mode (tsx)

# build & run from the compiled bundle (for development/testing)
npm run build
npm start
```

Environment
-----------

- `PORT` (default `3000`)
- `ANTHROPIC_API_KEY` (optional; enables Anthropic‑powered agents)
- `OPENAI_API_KEY` (optional; enables OpenAI‑powered agents)
- `POCKET_INSTALL_URL` (optional; override installer URL used by pre‑start auto‑update)
- Cloudflare tunnel (optional): `CF_TUNNEL_TOKEN`, `CF_TUNNEL_CONFIG`, `CF_TUNNEL_LOGLEVEL`

Key endpoints (reference)
-------------------------

- `GET /health` – basic health
- `GET /stats` – server stats (auth required)
- `GET /ws` – WebSocket endpoint
- `/auth/*` – pairing, token
- `/agent/*` – session lifecycle
- `/fs/*` – file system operations
- `/notifications/*` – device notifications
- `/cloud/*` – background agents (Cursor)

Project context (CLAUDE.md / AGENTS.md)
---------------------------------------

- The server injects lightweight project context into agent prompts by searching upward from the working directory for the nearest `CLAUDE.md` or `AGENTS.md`.
- Preference:
  - Anthropic sessions prefer `CLAUDE.md` (with support for in‑file `@imports` up to a safe depth, ignoring code blocks/spans).
  - OpenAI sessions prefer `AGENTS.md`.
- Size limit: context is normalized and capped at ~100KB to keep prompts responsive.
- Monorepos: nested `AGENTS.md`/`CLAUDE.md` files are supported; the closest file wins.
- See `docs/context-injection-patterns/agents-specification.md` for the AGENTS.md format and guidance.

Security notes
--------------

- Pairing defaults to local‑only; remote pairing is available via `pair --remote` and requires PIN + one‑time token
- The mobile app never stores server conversations; the server is authoritative
- Releases bundle Node v22.18.0 for consistency across platforms

Uninstall
---------

Remove the install directory (this also removes your local sessions):

```bash
rm -rf ~/.pocket-server
```

License
-------

Apache‑2.0. See `LICENSE`.
