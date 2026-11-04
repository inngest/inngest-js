# Agents Tour

An interactive tour of `inngest/experimental/agents`, in the style of the Go Tour. Lesson text on the left, an editor on the right, and below it the output of your code and the real trace of its runs. Every Run goes to a real Dev Server on your machine, so what you see is what you would get in production.

Today the tour shows the welcome pages and a sample exercise. The first lessons were written against an older agents API and are parked in `lessons/_parked/` (modules `01-agents-and-triggers` and `02-the-fakes`, with their checks and verify promises); the loader skips any folder whose name starts with `_`. The new module 1 replaces them.

## Run it

You need Node 24, pnpm, git and Go. Go builds the Dev Server (see below); nothing else is downloaded or installed outside this checkout and a cache directory.

```bash
# try-the-tour.sh
(
  set -e
  corepack enable
  node -e 'process.exit(+process.versions.node.split(".")[0] < 24)' || { echo "Node 24 or newer is required"; exit 1; }
  [ -d inngest-js ] || git clone https://github.com/inngest/inngest-js
  cd inngest-js
  git fetch origin
  git checkout jack/agent-primitives
  git pull --ff-only
  pnpm install
  pnpm --filter inngest build
  cd examples/agents-tour
  pnpm install --ignore-workspace --config.lockfile=false
  pnpm tour:devserver
  pnpm tour
)
```

`pnpm tour` prints the address and opens your browser. Press Ctrl-C to stop everything it started.

If something is missing, `pnpm tour` and `pnpm tour:devserver` check the machine first and say what to install.

## The Dev Server

Agents use `step.subscribe`, which the published Inngest CLI does not have yet. `.devserver-pin` holds the inngest/inngest commit to use.

- `pnpm tour:devserver` fetches that commit (shallow), builds the Dev Server's own UI (`pnpm install` and `pnpm build` in `ui/apps/dev-server-ui`), embeds it, builds the Dev Server with `go build` and caches the binary in `~/.cache/inngest-agents-tour/devserver/<commit>/`. Running it again does nothing. The first run takes several minutes: it installs the packages of the Dev Server UI and the dashboard sources it imports (not the rest of the OSS repo's UI workspace), builds the UI, then compiles the Go binary. The tour's "Dev Server" button opens that dashboard.
- `pnpm tour` starts that binary as `inngest dev` with the options below, on free ports.
- The pin is a commit, never a branch tip: the branch moves, and a newer tip can reject what the SDK sends. Today it is `7ce9ac384` (`jack/subscribe-v1`), which has the `subscribe` capability and the inbox shapes the SDK uses. `test/run.test.ts` runs an agent end to end on the pinned binary, so a pin that does not fit the SDK fails a test. Bumping the pin is a one-line change; when `step.subscribe` ships in the published CLI the pin becomes a version.

### Dev Server options

Every `inngest dev` option was considered. These are set (`server/devserver.ts`):

| Option | Value | Why |
|---|---|---|
| `--no-discovery` | on | The tour tells the Dev Server about its one app; scanning common ports could find someone else's. |
| `--no-poll` | on | The app's address never changes (the tour's proxy), so there is nothing to poll for. |
| `-u` | the tour's app address | The one app to sync. |
| `--host` | `127.0.0.1` | Nothing outside the machine can reach it. |
| `--port`, `--connect-gateway-port`, `--connect-gateway-grpc-port`, `--connect-executor-grpc-port` | free ports | The defaults (8288 and neighbours) belong to whatever else is running. |
| `--tick` | `25` ms | How often the executor polls the queue; the default is 150 ms. A step starts sooner after the one before it, which adds up over a lesson's steps. |
| `--retry-interval` | `1` s | A failed step retries after a fixed second on every retry (at the pinned commit the interval ignores the attempt number). The default is 15 s plus up to 30 s of jitter on the first retry, then longer; the reader waited about 19 s (`test/retry.test.ts`). |

These keep their defaults:

| Option | Default | Why |
|---|---|---|
| `--queue-workers` | 100 | A lesson runs a handful of steps at once; more or fewer workers change nothing the reader sees. |
| `--poll-interval` | 5 s | Unused with `--no-poll`. |
| `--persist` | off | A restart (the tour's Reset) should clear every run. |
| `--sqlite-dir`, `--postgres-*` | none | Persistence options; the tour has none. |
| `--config`, `--connect-*-grpc-ip`, `--debug-api-port`, `--system-trace-*`, `--duckdb*` | none | Not relevant to a single local app. |

Fast paths, all optional: `TOUR_DEVSERVER_BIN=/path/to/inngest` uses a binary you already have (for example a `devstack build-local` result), `TOUR_CACHE` moves the cache, `TOUR_OSS_REMOTE` fetches from another remote, `TOUR_PORT` fixes the tour's port, `TOUR_NO_OPEN=1` skips opening the browser.

## Keys

The cursor starts in the editor, so every key is a modifier key that works there and everywhere else. Each button shows its key, and the hint never changes with focus. Press <kbd>Alt</kbd>+<kbd>/</kbd> for the full list.

| Action | Key |
|---|---|
| Run (formats first) | Ctrl/Cmd+Enter |
| Next, previous page | Alt+] and Alt+[ |
| Lesson text, message box, trace | Alt+Shift+1, Alt+Shift+M, Alt+Shift+T |
| Open the Dev Server | Alt+Shift+. |
| Leave or return to the editor | Alt+Shift+E |

Single keys such as `r` and `j` also work outside text fields; they are never shown. The table is one file, `shared/keys.ts`: the editor commands, the window handler, the hints and the cheat sheet are all made from it.

## How it works

```text
browser (site/)  <--->  tour server (server/)  <--->  Dev Server (the cached binary)
                              |                              |
                              +-- app (runtime/host.ts, your agent.ts) <--+
```

- **Run** writes the page's files to `.tour/run/`, starts the app as a new process, switches the tour server's proxy to it once it serves, and registers it with the Dev Server. The Dev Server always talks to the proxy, so its address never changes. A file that does not load keeps the previous app serving and shows the error.
- Run then runs the page's read-only `run.ts`, so what Run does is on screen. `start()` works only inside a function, so the app also serves a tour-owned function, `tour-start` (triggered by `tour/start`), that imports `run.ts` afresh on every Run; the top-level code of `run.ts` runs inside that function, against the same agent modules the app serves. A manifest start entry `{ agent, thread, content }` still works the same way through `agent.start(content, { thread })`. A run opened by `start()` ends after its answer. The runs list and the trace hide `tour-start`, as they hide each agent's `-cleanup` and `-finished` and the SDK's shared agent functions (the ledger's included). The tour's `setup.ts` passes `store: memoryKvAdapter()`, so the pages do not use the ledger, but the host still serves `agents.functions()`. A start entry `{ event }` sends a plain event, for a trigger page.
- The Messages panel and a check's `t.send()` send a plain `agent/message` (`{ agent, thread, content }`) to the thread: into the live run's inbox, or as the start of a run that waits the agent's `idle` for more. A check's `t.start()` starts the agent the way Run does. Never send two messages to one thread at once: the second can be lost.
- The Trace pane reads the Dev Server's GraphQL API (`runs`, `runTraceSpanOutputByID`, the trigger event) every 300 ms and draws the real spans as a waterfall.
- **Reset** restores the page's code and restarts the Dev Server, so the runs list is clean.

## Layout

| Path | What |
|---|---|
| `lessons/<nn-module>/module.json` | a module's `title` and `opening` line |
| `lessons/<nn-module>/<nn>[a-z]-<page>/` | `page.md`, `manifest.json` and the editable files; `03-` is a core page, `03a-` a Go deeper page (label `3a`). An exercise adds `check.ts` and `stub/` and `solution/` folders |
| `lessons/PAGES.md` | how to write a page and prove it: `pnpm tour:page`, `pnpm tour:page-check`, `pnpm tour:lessons` |
| `lessons/_parked/` | lesson modules on the old agents API, kept but not loaded |
| `lessons/_shared/`, `lessons/<nn-module>/_shared/` | read-only files stored once; a manifest's `readOnly` names which a page shows (the module's first, then the tour-wide one) |
| `scripts/` | `tour.ts`, `devserver.ts`, `check.ts` (what the type checker cannot see), `typecheck-lessons.ts`, shared `lib.ts` |
| `server/` | the tour server, the Dev Server and app supervisors, the trace reader |
| `server/areas/` | one file per area of the server (`pages.ts`, `panels.ts`), each exporting `area`; a new file is picked up with no other edit |
| `runtime/host.ts` | the app the learner's code runs in |
| `site/` | the React and Monaco front end (Vite) |
| `site/src/panels/` | one `<id>.panel.tsx` per play-pane panel, calling `registerPanel` |
| `shared/` | the key table's helpers and the types the site and server share |
| `shared/keys/` | one key list per area (`core.ts`, `slack.ts`, ...), joined into the one table; a clash fails `tour:check` and the site |
| `test/` | `pnpm tour:test`: the tour server through its HTTP API, the key table, the port |

`pnpm tour` listens on port 4730 unless `TOUR_PORT` says otherwise; `pnpm tour:live` is the same without opening a browser, for a tour you leave running. A browser may reach it as `127.0.0.1` or `localhost`.

`pnpm typecheck` writes each page's files (read-only ones beside them) to `.tour/typecheck/` and checks them against the real SDK types, the site, and `tour:check`. The repo root script `agents:examples` runs it with biome.
