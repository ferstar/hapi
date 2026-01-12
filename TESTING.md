# Testing in this repo

Practical defaults for the hapi monorepo (Bun + Vitest). Use the commands below from the repo root unless noted.

## Quick commands

- CLI fast path: `cd cli && bun run test:unit` (skips `*.integration.test.ts`).
- CLI integrations only: `cd cli && bun run test:integration` (requires `.env.integration-test` with `HAPI_SERVER_URL` + `CLI_API_TOKEN`).
- Full CLI suite: `cd cli && bun run test`.
- Server: `bun run test:server` (from repo root).

## Port & state isolation

- Tests default `HAPI_HOME` to a temp directory via `cli/src/test/setup.ts` unless you explicitly set it.
- For ad-hoc runs, you can still override: `HAPI_HOME=$(mktemp -d) cd cli && bun run test:unit`. On Windows, use a temp path (e.g. `%TEMP%\\hapi-test-%RANDOM%`).
- When a test spins up an HTTP server, bind to an ephemeral port (`server.listen(0)`) and inject it via `HAPI_SERVER_URL=http://127.0.0.1:<port>` or `configuration._setServerUrl` inside the test.
- Use per-test temp directories (`mkdtemp`, `fs.mkdtempSync`) for any file IO; never share `~/.hapi` or repo-root paths between tests.

## Suite labeling & selection

- Keep long-running/system tests in `*.integration.test.ts` so they can be filtered with the new `test:unit` / `test:integration` scripts.
- Prefer `describe.skipIf` / `test.skipIf` for env-gated cases (e.g., missing `CLI_API_TOKEN`) instead of conditional early returns.
- Name tests after the behavior (“daemon restarts when version mismatches”) to make `--grep "<phrase>"` filters obvious.

## Failure reproduction & logs

- Re-run the exact test with verbose output: `cd cli && HAPI_HOME=$(mktemp -d) bun run vitest run cli/src/daemon/daemon.integration.test.ts --runInBand --reporter verbose`.
- For integration tests, load env via `--env-file .env.integration-test` or export `HAPI_SERVER_URL` + `CLI_API_TOKEN` explicitly; mismatched tokens will cause skips.
- Check daemon/CLI logs under `$HAPI_HOME/logs/` when diagnosing flakes; ensure the temp home is preserved when you need the logs.
- Capture failing HTTP traffic by logging request/response bodies in test helpers rather than inside app code; keep logs scoped to the test run.
