# Agents Tour

An interactive tour of `inngest/experimental/agents`, in the style of the Go Tour. Lesson text on the left, an editor on the right, and below it the output of your code and the real trace of its runs. Every Run goes to a real Dev Server on your machine, so what you see is what you would get in production.

This is phase 1: the runtime, the site and the first lesson (pages 1 to 8). The fake Slack and GitHub, the event sender and the rest of the lessons come next.

## Run it

You need Node 24, pnpm, git and Go. Go builds the Dev Server (see below); nothing else is downloaded or installed outside this checkout and a cache directory.

```bash
git clone https://github.com/inngest/inngest-js.git   # or cd into your checkout
cd inngest-js
git checkout jack/agent-primitives
git pull
pnpm install
pnpm --filter inngest build
cd examples/agents-tour
pnpm install --ignore-workspace --config.lockfile=false
pnpm tour:devserver
pnpm tour
```

`pnpm tour` prints the address and opens your browser. Press Ctrl-C to stop everything it started.

If something is missing, `pnpm tour` and `pnpm tour:devserver` check the machine first and say what to install.

## The Dev Server

Agents use `step.subscribe`, which the published Inngest CLI does not have yet. `.devserver-pin` holds the inngest/inngest commit to use.

- `pnpm tour:devserver` fetches that commit (shallow), builds the Dev Server with `go build` and caches the binary in `~/.cache/inngest-agents-tour/devserver/<commit>/`. Running it again does nothing.
- `pnpm tour` starts that binary as `inngest dev --no-discovery -u <the tour's app address>` on free ports. The Dev Server's own UI is not built; the tour has its own Trace panel.
- Bumping the pin is a one-line change. When `step.subscribe` ships in the published CLI the pin becomes a version.

Fast paths, all optional: `TOUR_DEVSERVER_BIN=/path/to/inngest` uses a binary you already have (for example a `devstack build-local` result), `TOUR_CACHE` moves the cache, `TOUR_OSS_REMOTE` fetches from another remote, `TOUR_PORT` fixes the tour's port, `TOUR_NO_OPEN=1` skips opening the browser.

## Keys

The cursor starts in the editor, so every key is a modifier key that works there and everywhere else. Each button shows its key, and the hint never changes with focus. Press <kbd>Alt</kbd>+<kbd>/</kbd> for the full list.

| Action | Key |
|---|---|
| Run (formats first) | Ctrl/Cmd+Enter |
| Next, previous page | Alt+] and Alt+[ |
| Lesson text, message box, trace | Alt+Shift+1, Alt+Shift+M, Alt+Shift+T |
| Show the event Run sends | Alt+Shift+2 |
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
- The page's start events are sent through the agent's own thread handle (or as a plain event for a trigger page).
- The Trace pane reads the Dev Server's GraphQL API (`runs`, `runTraceSpanOutputByID`, the trigger event) every 300 ms and draws the real spans as a waterfall.
- **Reset** restores the page's code and restarts the Dev Server, so the runs list is clean.

## Layout

| Path | What |
|---|---|
| `lessons/<nn-lesson>/<nn-page>/` | `page.md`, `agent.ts`, `setup.ts` (read-only in the editor, identical for a lesson), `manifest.json` (start events, panels) |
| `scripts/` | `tour.ts`, `devserver.ts`, `check.ts` (what the type checker cannot see), shared `lib.ts` |
| `server/` | the tour server, the Dev Server and app supervisors, the trace reader |
| `runtime/host.ts` | the app the learner's code runs in |
| `site/` | the React and Monaco front end (Vite) |
| `shared/` | the key table and the types the site and server share |

`pnpm typecheck` checks the lessons against the real SDK types, the site, and `tour:check`. The repo root script `agents:examples` runs it with biome.
