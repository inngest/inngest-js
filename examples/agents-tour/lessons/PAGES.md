# Writing a page

How to add one page of the Agents Tour and prove it works. Written for someone who has never seen the tour. The plan for every page is `projects/agents-tour/lesson-plan.md` in Jack's workspace; teach only the API in `packages/inngest/src/experimental/agents/` and its spec.

## Writing the text

- **Show, don't tell.** Every call, value or file the text names is on screen: a tab, the Trace, a panel. If Run does something, the code for it is in `run.ts`. Never describe in prose something the reader cannot see.
- **Name the thing every time.** No "it", "its", "this" or "that" standing in for a thing: write "Run calls...", "The run returns...", "`hello` has no body". A learner cannot tell what "it" points at.
- **Every "look at" sentence says where**: "In `run.ts`, ...", "In the Trace, ...".
- **One shape per page**, one paragraph each:
  1. What the idea does for you, in one or two sentences. The code is in the editor.
  2. "Press {Run}." and what `run.ts` does, naming the tab: "Run calls the code in `run.ts`, which starts `hello` with the message `Hi`."
  3. Where to look and what is there: "In the Trace, the run of `hello` is completed."
- At most three short sentences before the reader needs the code.
- Name every action with its key hint in braces: `Press {Run}.` renders as **Run** plus its key. The names come from the key table in `shared/keys/*.ts` (`{Run}` and `{cheat}` are in use; `shared/hints.ts` resolves them); an unknown name fails `pnpm tour:lessons`.
- First line of `page.md` is `# Title`. Supported markdown: paragraphs, `code`, **bold**, *italic*, `<kbd>`. Nothing else.
- No em dashes, no arrows, plain sentences.

## Files

```text
lessons/<nn>-<module>/module.json        { "title": "Agents", "opening": "One line." }
lessons/<nn>-<module>/<nn>-<page>/       one core page
  page.md                                # Title, then the text
  manifest.json                          tabs, pills, panels
  agent.ts                               the code the reader edits
  run.ts                                 what Run runs, a read-only tab
lessons/<nn>-<module>/<nn>a-<page>/      a Go deeper page (label 3a)
lessons/_shared/                         shared read-only tabs (setup.ts, ...) and concepts.json
lessons/_parked/                         old pages on the old API: copy their shape, never their API
```

- Folders are sorted by name; the loader skips any folder starting with `_`. The page's URL is `/tour/<module slug>/<page slug>`, the folder names without their number (`01-agents/02-hello-agent` is `/tour/agents/hello-agent`).
- Use the plan's page number for the page folder (`02-hello-agent` for plan page 2): the footer shows that number. The module's number in the left nav is its position, not the folder number, so module 1 (Agents) shows as `2. Agents` after Welcome. Leave it.
- Editable files default to `agent.ts`; read-only tabs default to `setup.ts`. A page's code imports from `./setup`, as `import { agents } from "./setup";`.

## run.ts

Every page with Run has its own `run.ts`. Run calls its `run` export inside the tour's `tour-start` function, so `start()` works there (`start()`, `message()` and `ask()` throw outside a function). The runs list and the Trace hide `tour-start` itself.

```ts
import { hello } from "./agent";

// Run calls this.
export const run = async () => {
  await hello.start("Hi");
};
```

- Keep `run.ts` as plain as the page allows, and use only what the tour has taught by then: page 2 passes no thread, since threads come in module 2.
- A run opened by `start()` ends after its answer.

## manifest.json

```json
{
  "readOnly": ["run.ts", "setup.ts"],
  "apis": ["agents.agent"],
  "concepts": ["agent", "run"]
}
```

- `readOnly`: the read-only tabs, in order after the editable file. A name is found in the page's folder first (`run.ts`), then the module's `_shared`, then `lessons/_shared`. Order: the editable file, `run.ts`, then `setup.ts` and the rest.
- `apis` and `concepts`: the pills under the text. API pills are code; concept pills open the Concepts collection, and the first page to name a concept collects it. Every concept needs a line in `lessons/_shared/concepts.json` (`pnpm tour:lessons` fails otherwise). Introduce each on one page only.
- `panels`: play-pane tabs by id (`message`, `github`, `slack`, `events`; files in `site/src/panels/`). `message: { agent, thread }` adds the Messages box, which sends a plain `agent/message` event with a `content` field. Such a message starts a run that waits the agent's `idle` for more, unlike a run opened by `start()`.
- `start`: the older way to say what Run sends, still read after `run.ts`. `{ event: { name, data } }` sends a plain event (for a trigger page, if the page cannot show the send in `run.ts`); `{ agent, thread, content }` starts an agent without showing the call. Prefer `run.ts`.
- `exercise`: `{ check, hint, stub, solution }`, with `check.ts` and `stub/` and `solution/` folders. `run.ts` stays the same for the stub and the solution. See `03-sample-exercise/12-greeter`.
- `verify`: what `tour:verify` expects (`shared/types.ts`), optional.

## Prove it

1. Typecheck the page's code the way the editor will (a red squiggle counts as broken), and the manifest, hints and formatting:

   ```bash
   pnpm tour:lessons
   ```

2. Start a tour for your page from your worktree. It picks free ports, so many can run at once, and never uses port 4730 (Jack's live tour). In a fresh worktree it links the built SDK and the repo's `node_modules` from another worktree of the same SDK tree, then installs the tour's own packages (about a second); nothing is rebuilt. The Dev Server is the cached pinned build.

   ```bash
   devstack proc start --name page-<n> --cwd <worktree>/examples/agents-tour \
     --cmd 'pnpm tour:page 01-agents/02-hello-agent' --ready-log 'Page ready'
   grep 'Page ready' <log path it printed>     # the page's URL
   ```

   Without devstack: `pnpm tour:page 01-agents/02-hello-agent`, stopped with Ctrl-C or `pnpm tour:page --stop` from the same worktree.

3. Drive the page and read what it shows:

   ```bash
   pnpm tour:page-check <page url>              # Run, then report
   pnpm tour:page-check <page url> --exercise   # also Check, Show a solution, Check
   pnpm tour:page-check <page url> --keep       # leave the browser open
   ```

   It prints the title, pills, the file tabs in order (and warns when `run.ts` is missing), the concept count, the page's nav state (`opened`, `ran`, `passed`), the editor's red squiggles, then after Run (pressed with Ctrl+Enter in the editor) each run's status, output and trace rows, the first trace row opened, the nav state again and a screenshot path. The runs list hides `tour-start`, each agent's `-cleanup` and `-finished` and the SDK's shared functions, so "one run" means one row.

4. Press the rest by hand with `agent-browser` in the session it printed (`export AGENT_BROWSER_SESSION=<session>`, `--keep`):

   | Control | Click | Key |
   |---|---|---|
   | Run | `button` named Run | `Control+Enter` in the editor (`agent-browser click .view-lines` first) |
   | Format | Format | `Alt+Shift+F` |
   | Reset (code and runs) | Reset | `Alt+Shift+R` |
   | Next, Previous | Next, Previous (footer) | `Alt+]`, `Alt+[` |
   | Next file tab | Next file, or a tab | `Alt+Shift+L` |
   | Raw trace | Show everything | `Alt+Shift+H` |
   | Concepts, Search, Keys, Dev Server | top bar buttons | `Alt+Shift+O`, `Alt+Shift+P`, `Alt+/`, `Alt+Shift+.` |
   | Focus lesson, trace, editor | | `Alt+Shift+1`, `Alt+Shift+T`, `Alt+Shift+E` |

   Useful reads: `agent-browser snapshot -i` for refs; the code is `Array.from(document.querySelectorAll(".view-line")).sort((a,b)=>parseFloat(a.style.top)-parseFloat(b.style.top)).map(l=>l.innerText).join("\n")`; to put messy code in, `click .view-lines`, `press Control+a`, `keyboard inserttext "..."` (typing triggers auto-close brackets).

5. Stop your tour: `devstack stop page-<n>`.

## Gotchas

- Key hints are hidden in headless Chromium (`@media (hover: none)` hides `kbd`), so "Press Run ." in a snapshot is right; a real screen shows the key.
- agent-browser key names: write `Alt+[` and `Alt+]`, not `Alt+BracketLeft`, which sends nothing useful.
- Monaco's suggest box can cover the buttons after typing in the editor; `press Escape` before clicking.
- Reset progress needs two presses of the same button within a few seconds ("Press again to reset").
- The trace's first row for a run started by `start()` is labelled `inbox.next()` even when the agent has no body; open it and the message (`content`) is there.
- Progress is saved per worktree in `.tour-cache/progress.json`, so your checks never touch anyone else's.
- An agent with no body (`agents.agent({ id })`) is valid: the run reads its first message and ends with no output.
