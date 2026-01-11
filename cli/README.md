# hapi CLI

Run Claude Code, Codex, or Gemini sessions from your terminal and control them remotely through the hapi server.

## What it does

- Starts Claude Code sessions and registers them with hapi-server.
- Starts Codex mode for OpenAI-based sessions.
- Starts Gemini mode via ACP (Anthropic Code Plugins).
- Provides an MCP stdio bridge for external tools.
- Manages a background daemon for long-running sessions.
- Includes diagnostics and auth helpers.

## Typical flow

1. Start the server and set env vars (see ../server/README.md).
2. Set the same CLI_API_TOKEN on this machine or run `hapi auth login`.
3. Run `hapi` to start a session.
4. Use the web app or Telegram Mini App to monitor and control.

## Commands

### Session commands

- `hapi` - Start a Claude Code session (passes through Claude CLI flags). See `src/index.ts`.
- `hapi codex` - Start Codex mode. See `src/codex/runCodex.ts`.
- `hapi gemini` - Start Gemini mode via ACP. See `src/agent/runners/runAgentSession.ts`.
  Note: Gemini runs in remote mode only; it waits for messages from the server UI/Telegram.
- `hapi --new-session` - Start a fresh server session instead of reusing the default tag.
- `hapi --session-tag <tag>` - Force a specific server session tag.
- `hapi codex --new-session` - Same as above for Codex mode.
- `hapi codex --session-tag <tag>` - Same as above for Codex mode.

### Authentication

- `hapi auth status` - Show authentication configuration and token source.
- `hapi auth login` - Interactively enter and save CLI_API_TOKEN.
- `hapi auth logout` - Clear saved credentials.

See `src/commands/auth.ts`.

### Daemon management

- `hapi daemon start` - Start daemon as detached process.
- `hapi daemon stop` - Stop daemon gracefully.
- `hapi daemon status` - Show daemon diagnostics.
- `hapi daemon list` - List active sessions managed by daemon.
- `hapi daemon stop-session <sessionId>` - Terminate specific session.
- `hapi daemon logs` - Print path to latest daemon log file.
- `hapi daemon install` - Install daemon as system service.
- `hapi daemon uninstall` - Remove daemon system service.

See `src/daemon/run.ts`.

### Diagnostics

- `hapi doctor` - Show full diagnostics (version, daemon status, logs, processes).
- `hapi doctor clean` - Kill runaway HAPI processes.

See `src/ui/doctor.ts`.

### Other

- `hapi mcp` - Start MCP stdio bridge. See `src/codex/happyMcpStdioBridge.ts`.
- `hapi server` - Start the bundled server (single binary workflow).

## Configuration

See `src/configuration.ts` for all options.

### Required

- `CLI_API_TOKEN` - Shared secret; must match the server. Can be set via env or `~/.hapi/settings.json` (env wins).
- `HAPI_SERVER_URL` - Server base URL (default: http://localhost:3006).

### Optional

- `HAPI_HOME` - Config/data directory (default: ~/.hapi).
- `HAPI_EXPERIMENTAL` - Enable experimental features (true/1/yes).
- `HAPI_CLAUDE_PATH` - Path to a specific `claude` executable.
- `HAPI_SESSION_TAG` - Override the default session tag (ignored if `--new-session` or `--session-tag` is used).
- `HAPI_HTTP_MCP_URL` - Default MCP target for `hapi mcp`.
- `HAPI_CODEX_CONNECT_TIMEOUT_MS` - MCP connect timeout in ms (default: 60000).
- `HAPI_CODEX_STALL_MIN_MS` - Minimum stall timeout in ms (default: 120000).
- `HAPI_CODEX_STALL_THINKING_MS` - Stall timeout during thinking in ms (default: 240000).
- `HAPI_CODEX_STALL_TOOL_MS` - Stall timeout during tools in ms (default: 300000).
- `HAPI_CODEX_STALL_TOOL_ACTIVE_MS` - Stall timeout during active tools in ms (default: 600000).
- `HAPI_CODEX_STALL_PATCH_MS` - Stall timeout during patch application in ms (default: 300000).
- `HAPI_CODEX_STALL_PATCH_ACTIVE_MS` - Stall timeout during active patch application in ms (default: 600000).
- `HAPI_CODEX_STALL_COMPLETE_MS` - Stall timeout after completion in ms (default: 180000).
- `HAPI_CODEX_STALL_CHECK_MS` - Stall watchdog interval in ms (default: 5000).
- `HAPI_CODEX_STALL_RESTART_LIMIT` - Stall restart limit before cooldown (default: 3).
- `HAPI_CODEX_STALL_RESTART_COOLDOWN_MS` - Stall restart cooldown in ms (default: 900000).

### Daemon

- `HAPI_DAEMON_HEARTBEAT_INTERVAL` - Heartbeat interval in ms (default: 60000).
- `HAPI_DAEMON_HTTP_TIMEOUT` - HTTP timeout for daemon control in ms (default: 10000).

## Storage

Data is stored in `~/.hapi/` (or `$HAPI_HOME`):

- `settings.json` - User settings (machineId, token, onboarding flag). See `src/persistence.ts`.
- `daemon.state.json` - Daemon state (pid, port, version, heartbeat).
- `logs/` - Log files.

## Requirements

- Claude CLI installed and logged in (`claude` on PATH).
- Bun for building from source.

## Build from source

From the repo root:

```bash
bun install
bun run build:cli
bun run build:cli:exe
```

For an all-in-one binary that also embeds the web app:

```bash
bun run build:single-exe
```

## Source structure

- `src/api/` - Bot communication (Socket.IO + REST).
- `src/claude/` - Claude Code integration.
- `src/codex/` - Codex mode integration.
- `src/agent/` - Multi-agent support (Gemini via ACP).
- `src/daemon/` - Background service.
- `src/commands/` - CLI command handlers.
- `src/ui/` - User interface and diagnostics.
- `src/modules/` - Tool implementations (ripgrep, difftastic, git).

## Related docs

- `../server/README.md`
- `../web/README.md`
