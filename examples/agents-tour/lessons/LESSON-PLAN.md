# The Agents Tour lesson plan

Every page of the tour, in order. `PAGES.md` is how to write one; this is what to write. The API is whatever is in `packages/inngest/src/experimental/agents/`: where this plan and that code disagree, the code is right and this file is stale.

## What the reader builds

The tour builds one chatbot and keeps adding to it. The play pane's bottom right is a chat: the reader types, the agent answers, and every tool the agent uses shows as a plain line between the speech bubbles. The bottom left holds the fakes the agent acts on, a GitHub and a Slack. So a page is not "press Run and read the trace"; a page is "press Run, then ask it this", and the page says what to ask.

That changes what a page has to earn. Each page must unlock something the reader can see the chatbot do, in the chat, on that page.

## Why handlerless first

An agent is a config object. `agents.agent({ id: "hello", model })` is a complete agent: the reader can talk to it and it talks back, and nothing on the page explains a loop, a turn, an inbox or a batch. That is page 2, and it is the whole of page 2.

The handler is the last module instead of the first. The body is an escape hatch: you supply one when you want to be the one in control. A reader who reaches it already knows agents, models, threads, inboxes, tools, skills, sandboxes, cards and discovery, so the handler page can explain what the default body actually does, and why you would replace it, instead of teaching nine concepts through its arguments. Taught first, the handler forces the reverse: the reader writes `inbox.batches()` and `loop(batch)` before knowing what a batch, a loop or a turn is.

The ordering also front-loads agent teams and agent discovery, which were near the end of the old plan. The card is the most impressive thing the primitives do, so it comes before the config tour and before handlers, not after them.

## Matching the docs

The tour's modules follow the concepts of the Inngest agents docs (`pages/docs/labs/agents/` on `labs/inngest-agents-docs` in the website repo), so a reader who finishes a module can read that docs page next and recognise every word.

| Tour module | Docs page |
|---|---|
| 1. Agents | `agents.mdx`, `quick-start.mdx` |
| 2. Models | `models.mdx` |
| 3. Threads | `threads.mdx` |
| 4. Inboxes | `inboxes.mdx` |
| 5. Tools | `tools.mdx`, `skills.mdx`, `sandboxes.mdx`, `calling-home.mdx` |
| 6. Teams and discovery | `agent-discovery.mdx`, `agent-teams.mdx` |
| 7. The rest of the config | `reliability.mdx`, `observability.mdx` |
| 8. Handlers | `agents.mdx` (the handler half), `reference.mdx` |

Two docs pages have no tour module on purpose. `memory.mdx` is to be deleted, so the tour has no memory concept and must not grow one; what a thread keeps between runs is taught as thread state in module 3. `workers.mdx` and `structure.mdx` are deployment and layout advice, which the tour cannot show in an editor with one `agent.ts`.

## Module 0: Welcome

Folders `00-welcome/01-welcome`, `02-the-controls`, `03-what-runs-on-your-machine`. Written, and not plan-numbered: these three pages have no code and teach no concept.

`02-the-controls` needs rewriting for the chat: the chat box, that clicking out of the editor saves and runs, and what the unsaved marker means. `03-what-runs-on-your-machine` names what answers the chat (see "The model the tour talks to" below).

## Module 1: Agents

`01-agents/`. Opening: "An agent is a function: code Inngest runs for you, durably."

### 1. What we are building

Folder `01-what-we-are-building`. No code (`{ "code": false }`).

One screen on the shape of the tour: the editor holds the agent, the chat talks to it, the panels on the left are the world it acts on. Each module adds to the same chatbot.

The reader reads and presses Next. Nothing runs.

### 2. Hello, agent

Folder `02-hello-agent`. Written; keep the code, rewrite the third paragraph for the chat.

Concepts: `agent`, `run`, `address`.

Code: `agents.agent({ id: "hello" })`, and `run.ts` calling `hello.start("Hi")`.

The reader presses Run. In the chat, the reader's `"Hi"` appears on the right and nothing comes back: `hello` has no model and no body, so the run reads the message and ends.

### 3. Give it a model

Folder `03-give-it-a-model`. Replaces `03-give-it-a-body`, which taught the body first.

Concepts: `model`, `turn`.

Code: `agents.agent({ id: "hello", model })`, with `model` imported from `./models`.

The reader presses Run, then types anything into the chat. The agent answers in the chat, on the left. The page says that `hello` has no body: the `model` alone is a working agent, and the model's final text is the run's output.

### 4. Tell it what it is for

Folder `04-tell-it-what-it-is-for`.

Concepts: `system prompt`.

Code: adds `system` to the config, as a value.

The reader presses Run and asks the same question as on page 3. The answer is different: the chat shows the agent behaving as the `system` text says. The page says what belongs in `system` (policy) and what does not (the protocol, which the SDK's briefing already covers).

### 5. It remembers what you said

Folder `05-it-remembers`.

Concepts: `history`.

Code: unchanged from page 4, so the diff is in the chat, not the editor.

The reader asks a question, then asks a follow-up that only makes sense given the first ("and the one before that?"). The chat shows the agent answering it. The page says the model's history carries across messages inside the run, with no code from the reader.

## Module 2: Models

`02-models/`. Opening: "A model is a function of the right shape."

This module is a documentation obligation for the release and has no written content anywhere else, so it carries real weight. Two custom adapters, both runnable.

### 6. The model we ship

Folder `06-the-model-we-ship`.

Concepts: `model adapter`.

Code: `anthropic({ model: "claude-sonnet-5-5" })` in the config, in place of the import from `./models`.

The reader presses Run and asks something. The chat answers as before. The page names the one adapter the SDK ships, and that `anthropic()` knows its own prices, so the run reports what the answer cost.

### 7. A model is a function

Folder `07-a-model-is-a-function`.

Concepts: none new.

Code: a model written in the page, `agentModel(async (request) => ...)`, that answers without calling anything: it reads the last message of `request.messages` and returns `{ message, text, toolCalls: [] }`.

The reader presses Run and says `"hello"` in the chat. The agent answers with the reader's own words, from the adapter in the editor. The page says the four fields a reply needs and that `agentModel()` is what marks a function as a model rather than a run field.

### 8. An adapter for another provider

Folder `08-another-provider`.

Concepts: none new.

Code: a second adapter, the shape a real provider takes: map `request.messages` to the provider's wire format, `fetch` the provider, map the reply back, and fill `toolCalls` from the provider's tool calls so tools still work. The provider is one of the tour's own fakes, so the page runs with no key.

The reader presses Run and asks the agent to use a tool. The chat shows the tool line and then the answer, proving the mapping of `toolCalls` is what makes tools work, not anything the SDK knows about the provider.

### 9. A model per run

Folder `09-a-model-per-run`.

Concepts: none new.

Code: `model: ({ event, thread }) => ...`, choosing between two adapters from the message.

The reader presses Run, says something short, then something long. The chat answers both; the page says the function is read once at the start of each run, and that this is how a key that only exists per request is read.

## Module 3: Threads

`03-threads/`. Opening: "A thread is one conversation, named by a key."

The sample exercise module currently sits at `03-sample-exercise`. Move it to `_parked` when this module lands, so the folder numbers do not collide.

### 10. One conversation

Folder `10-one-conversation`.

Concepts: `thread`, `thread key`.

Code: `run.ts` starts the agent with `{ thread: "ada" }`.

The reader presses Run, talks to the agent, and the chat shows one conversation. The page names the key and says a thread has at most one live run.

### 11. Two conversations

Folder `11-two-conversations`.

Concepts: `run` already collected; nothing new.

Code: `run.ts` starts two threads, `"ada"` and `"grace"`.

The chat has a thread switcher for this page. The reader says something in `ada`, switches to `grace`, and finds that the agent does not know it: two threads, two histories. The page says which events belong to which thread, and that `thread` on the config is the expression that decides.

### 12. What a thread keeps

Folder `12-what-a-thread-keeps`.

Concepts: `thread state`, `scope`.

Code: a handler-free agent with one tool that writes `kv.thread`, and a `system` line telling the model to use it.

The reader presses Run, tells the agent a fact ("call me Ada"), then presses Run again, which ends the run and starts a new one. The reader asks the agent for the fact and gets it. The page says thread state is what survives between runs, and that a run's history does not.

## Module 4: Inboxes and listening

`04-inboxes/`. Opening: "An agent keeps listening while it works."

### 13. The inbox

Folder `13-the-inbox`.

Concepts: `inbox`, `message`, `unread`.

Code: unchanged agent; the page is about what happens when two messages arrive.

The reader presses Run, asks for something slow, and while the agent works, sends a second message. The chat shows the second bubble going up while the agent is still working, then one answer that accounts for both. The page says what the inbox is: a durable, ordered collection inside one run, whose first message is the event that started the run.

### 14. Forward only

Folder `14-forward-only`.

Concepts: `batch`, `fold`.

Code: unchanged.

The reader sends three messages fast. The chat shows one tool-free answer covering all three. The page says the inbox only goes forward: a read gives up every unread message at once, as a batch, and the default loop folds the batch into the next model call. There is no rewinding and no re-reading.

### 15. Listening for something else

Folder `15-listening`.

Concepts: `source`, `trigger`.

Code: `inbox: [prOpened]`, an event source keyed to the thread, with the fake GitHub panel on the bottom left.

The reader presses Run, asks the agent to watch for a pull request, then opens one in the GitHub panel. The chat shows a non-speech line for the arriving event, then the agent's comment on it. The page says a source reaches a live run and never starts one.

### 16. Letting the model listen

Folder `16-the-model-listens`.

Concepts: none new.

Code: `listen: [prOpened, ciFinished]` instead of `inbox`, which gives the model `inbox_listen` and `inbox_close`.

The reader asks the agent, in the chat, to watch for CI on one pull request. The chat shows an `inbox_listen` line with the `source`, the `match` and the `as` the model chose, then the event, then the answer. The page says the model decides what to subscribe to, and that `listen` is the list it may choose from.

## Module 5: Tools

`05-tools/`. Opening: "A tool is the only way an agent acts on anything."

### 17. A tool

Folder `17-a-tool`.

Concepts: `tool`, `step`.

Code: `tools: { getOrder: tool({ description, input, output, run }) }`, imported from `inngest/experimental`.

The reader asks the agent about an order. The chat shows a `getOrder` line with the input and the result, then the answer. The page says a tool call is a durable step, so a tool that succeeds never runs twice.

### 18. Writing a tool the model can choose

Folder `18-describing-a-tool`.

Concepts: none new.

Code: a second, neighbouring tool, and `description` in parts (`does`, `use`, `avoid`) on both.

The reader asks something ambiguous, and the chat shows which tool the model picked. The reader edits `avoid` in the editor, clicks into the chat (which saves and runs), and asks again: the other tool is picked. The page says the description is the model's only basis for choosing.

### 19. Tools from an MCP server

Folder `19-mcp-tools`.

Concepts: none new.

Code: `mcp()` from `inngest/experimental`, pointed at the tour's own MCP server (`lessons/_shared/mcp.ts`).

The reader asks a question the team's docs answer. The chat shows the `search_docs` line and the answer. The page says an MCP server's tools are tools like any other.

### 20. Skills

Folder `20-skills`.

Concepts: `skill`.

Code: `skills: [skills.folder("./skills")]`, with one `SKILL.md` in the page's folder as a read-only tab.

The reader asks for something the skill covers. The chat shows an `open_skill` line, then an answer in the house style the skill describes. The page says the model sees only names and descriptions until it opens one, and that a skill adds no tool.

### 21. A sandbox

Folder `21-a-sandbox`.

Concepts: `sandbox`.

Code: `sandboxes: { work: sandbox({ tools: ["run"] }) }`.

The reader asks the agent to work something out that needs code. The chat shows a `work_run` line with the code the model wrote and its output, then the answer. The page says the sandbox belongs to the thread, and that the model writes the code while the tools stay the app's.

### 22. The sandbox calls home

Folder `22-calling-home`.

Concepts: none new.

Code: a tool made in the page and given to the sandbox, so a script inside the sandbox can call back into the app.

The reader asks for something that needs both: compute in the sandbox, then write through the app's own credentials. The chat shows the `work_run` line, then the tool line from inside it, then the answer. The page says what this unlocks: code the model wrote, running where it cannot hurt anything, using access that never leaves the app.

## Module 6: Agent teams and discovery

`06-teams/`. Opening: "This is the card. This is how agents find each other."

### 23. The card

Folder `23-the-card`.

Concepts: `card`.

Code: `card: { description: { does, use, avoid }, capabilities, tags, effects }` on the agent the reader has been building.

The reader presses Run. The chat shows the card the agent published, as a non-speech line. The page says every agent publishes a card whether or not it asks to, that `description` and `capabilities` are what a model choosing an agent reads, and that `effects` is `"read"`, `"write"` or `"destructive"`.

### 24. Finding another agent

Folder `24-finding-another-agent`.

Concepts: none new.

Code: a second agent in the editor with its own card, and `discovery: true` on the first.

The reader asks the first agent what else is around. The chat shows a `list_agents` line, the roster it returned, a `describe_agent` line, then the answer. The page says `list_agents` gives the roster of what this caller may see and `describe_agent` gives one full card.

### 25. Who may see whom

Folder `25-who-may-see-whom`.

Concepts: none new.

Code: `share`, `explicit` on the second agent's card and a filter in `discovery: { agents: [{ tags: ["research"] }] }`.

The reader asks for the roster, sees the second agent, then edits `tags` in the editor, clicks into the chat and asks again: the second agent is gone. The page says the card's `share` and `explicit` decide who may see, and `discovery.agents` decides what this agent is shown.

### 26. Starting another agent

Folder `26-starting-another-agent`.

Concepts: none new.

Code: as page 25, with the second agent given a `model` and a job of its own.

The reader gives the first agent work that suits the second. The chat shows the whole handoff as non-speech lines: `list_agents`, `start_agent` with the input, then the second agent's own lines indented under it, then the answer that came back. The page says this is a team: one agent choosing another at the time, not a graph written in advance.

### 27. Getting reports back

Folder `27-reports`.

Concepts: none new.

Code: `start_agent` with `reports`, an event type the child owes back, and `ask_agent` for a question while it works.

The reader gives the first agent a long job. The chat shows a report line arriving while the second agent is still going, then an `ask_agent` line and the answer to it, then the final answer. The page says a report is a typed event routed back to the thread that started the agent, and that a `required` report is one the child's model is reminded of before it may finish.

## Module 7: The rest of the config

`07-config/`. Opening: "Everything else the config takes."

Each page here adds one field to the same agent, so the reader watches one config expand. The fields are whatever `AgentFunctionConfig` and `AgentFunctionOptions` accept at the time of writing: check both before writing the module, since this is the part of the API that moves.

### 28. Limits

Folder `28-limits`.

Concepts: none new.

Code: `limits: { depth: 1 }` and `loop: { maxTurns: 4 }`.

The reader asks for something that would run away. The chat shows the agent stopping, with the limit named. The page says a chain of started agents multiplies cost, so the default `depth` is 1.

### 29. When something fails

Folder `29-when-something-fails`.

Concepts: none new.

Code: `retries`, `timeouts: { finish }` and `recovery: true`, with a tool that fails on purpose.

The reader asks for the thing that fails. The chat shows the tool line failing, the retry, and then the answer. The page says a failed step retries and a completed step never runs again, and that `recovery` resends the message a dead run was holding.

### 30. Scoring a run

Folder `30-scoring`.

Concepts: none new.

Code: a tool that calls `score("helpful", 1)`.

The reader talks to the agent, and the chat shows the score line. The page says what a score is for: judging the run from inside it, so a change to the prompt can be compared.

### 31. Everything else

Folder `31-everything-else`.

Concepts: `plain function`.

Code: the config with `concurrency`, `idempotency`, `throttle` and `name` added, each one line.

The reader reads and presses Run; the chat is unchanged, which is the point. The page says these are the ordinary Inngest function options, that an agent is an Inngest function, and names the four an agent refuses (`debounce`, `batchEvents`, `singleton`, `checkpointing`) and why.

## Module 8: Handlers

`08-handlers/`. Opening: "By the way: you can supply a body. Then you are in control of all of this."

### 32. The body the SDK writes

Folder `32-the-default-body`.

Concepts: `loop`.

Code: the default body, written out in the editor exactly as the SDK's own is: `for await (const batch of inbox.batches()) { answer = (await loop(batch)).text; }`.

The reader presses Run and talks to the agent. The chat behaves exactly as it did on the page before, because the body in the editor is the one that was running all along. The page says this is what has been running since page 3, and names each piece: `inbox.batches()`, `loop`, `result.text`.

### 33. Changing the loop

Folder `33-changing-the-loop`.

Concepts: none new.

Code: the same body with something the reader can only do here: a line printed before each turn, a `loop.with()` for one batch, a value returned that is not the model's text.

The reader talks to the agent and the chat shows the extra lines, and the page says what the output of the run is now. The page says the body's return value is the run's output, which is why an agent with a body has a typed output and one without has the model's text.

### 34. Reading the inbox yourself

Folder `34-reading-the-inbox`.

Concepts: none new.

Code: `inbox.next()` instead of `inbox.batches()`, answering one message at a time, and a background read beside it.

The reader sends two messages fast and sees two answers rather than one. The page says the difference between reading in the foreground, where the run waits for a message, and in the background, where a read happens while a turn is in flight, and which the default body does.

### 35. Why you would write one

Folder `35-why-write-one`.

No code (`{ "code": false }`), or the finished chatbot with every page's config in one file.

The closing page: what a body is for (work that is not a conversation, a typed output, a protocol of your own), and what to read next, which is the docs pages this plan's table names.

## Open questions for the plan, not for the pages

- **The model the tour talks to.** A chat that answers needs a model. `runtime/scripted-model.ts` is the only model the tour has, and `00-welcome/03-what-runs-on-your-machine` promises the reader that "no API key is needed: the models in the tour are scripted". A scripted model cannot hold the conversations module 1 promises. The resolution is a `lessons/_shared/models.ts` that gives `anthropic()` when `ANTHROPIC_API_KEY` is set and the scripted model otherwise, and a welcome page that says so. Pages 6 to 9 then teach what that file already does.
- **The fake provider of page 8.** The adapter for another provider needs something to `fetch`. The tour already serves its own MCP server from `lessons/_shared/mcp.ts`, so a fake provider endpoint beside it is the same move.
- **Exercises.** `03-sample-exercise/12-greeter` is a temporary page that proves Check works. Each module should end with one exercise, written once the module's pages exist; a page that is an exercise takes the next page number in its module.

## Where this got to

Written at the point the tour was parked until the agent primitives settle. The plan above is finished and agreed. The chat box is half built. Read this before touching `site/`.

### The model: a real key, not the scripted one

Decided and not yet carried out. Every page runs a genuine model: the reader supplies `ANTHROPIC_API_KEY` and pages call `anthropic()` directly. There is no conditional `lessons/_shared/models.ts` and no scripted fallback for the reader. `runtime/scripted-model.ts` stays, for the test suite only (`test/run.test.ts`, `tour:page-check`, the exercise checks), so CI stays keyless and deterministic while the reader's experience is real. Nothing in the code or in `PAGES.md` says this yet, and these four jobs are outstanding:

1. Rewrite `00-welcome/03-what-runs-on-your-machine`, which still promises "no API key is needed: the models in the tour are scripted". That is now false.
2. Add a loud, early preflight check for `ANTHROPIC_API_KEY` to `pnpm tour` and `pnpm tour:devserver`, beside the checks they already do, failing by name before the browser opens.
3. Say in `PAGES.md` that a page check asserts shape, not wording: a reply exists, is not empty, the run completed. A real model cannot be asserted against an exact string.
4. Give `check.ts` scripts the same treatment: assert what the reader's code did, never what the model said.

### What the chat box change is, so far

One commit, `wip(agents-tour): start the chat box that replaces the trace view`. It compiles as far as it was taken by hand, but it has not been typechecked, not been built, and never been opened in a browser. Treat it as a sketch with real intent, not as working code.

Done:

- **`site/src/chat.tsx`, new.** `ChatPanel`: the reader's messages as bubbles on the right, the agent's as bubbles on the left, and everything the agent does as a plain line between them. A line is clickable and reveals the step's input and output, reusing `Detail` from `trace.tsx`. The box has an optional thread switcher (`chat.threads`) and optional suggestion buttons (`chat.prompts`).
- **`site/src/trace.tsx`.** Nothing removed. `isPlumbing`, `isPlaceholder`, `isFinalization`, `isNextCall`, `parse`, `rounded`, `Detail` and `FailedRun` are now exported so the chat uses the same rules rather than its own.
- **`shared/types.ts`.** The manifest's `message?: { agent, thread, threads? }` became `chat?: { agent, thread, threads?, prompts? }`.
- **The Messages panel is gone.** `site/src/panels/message.panel.tsx` and `panels/Messages.tsx` are deleted: the chat does that job, better. `01-agents/04-what-started-it` still names the Messages panel in its prose and its manifest, and is now broken until it is rewritten for the chat.
- **Keys.** `shared/keys/messages.ts` became `shared/keys/chat.ts`: `chat` focuses the box (`Alt+Shift+M`, `3`, `g m`, the old message-box binding) and `chatSend` sends it (`Alt+Shift+Enter`, `s`). `sendEvent` moved to `shared/keys/events.ts`, where the Events panel still owns it, on `Alt+Shift+9` and `9`. `sendOther` is gone with the Messages panel.
- **`site/src/App.tsx`.** A `dirty` flag, set by the editor's `onChange` and cleared in `run()` just before the files are posted. The `chatTarget` memo: the page's `manifest.chat` if it has one, else inferred from the newest run, whose `fn` is the agent's id and whose trigger's `data.thread` is the thread, so a page that says nothing still has a working chat. The play pane no longer falls back to the Messages panel, and `play` starts as `""` instead of `"message"`.

### How a chat entry is derived from a run

This is the part worth keeping. The chat reads exactly what the Trace reads, `TraceRun[]` off the stream, and nothing else.

- **The reader's messages** come from two places. A run's trigger gives one, read as `data.content`, falling back to `data.text` and `data.message`. The chat's own sends give the rest: a sent message is held in local state and shown at the bottom until it stops being in flight, because a message that arrives in a live run's inbox leaves no span of its own (the SDK's `subscribe` spans are plumbing) and so cannot be read back from the trace.
- **The agent's answers** come from the model call's step, not from the run's output. The SDK records one step per model call, `id` `<loop>:model:<turn>`, name `Thinking`, span kind `llm`, and that step's recorded output is the whole `AgentModelResponse`. So `api.output(step.outputID)` parsed gives `.text`, which is what the agent said on that turn. `isThinking()` matches on the name, `type` or `group` being `llm`, because which of those the Dev Server puts a span's kind in was never confirmed against a live run: see below.
- **The lines** are every other step the run recorded, after the same filter the Trace uses: not a placeholder, not `Finalization`, not an `inbox.next()` call, and not `isPlumbing`. That is the reuse, not a copy: `trace.tsx` keeps the rules and the chat imports them. The SDK's own `subscribe`, `inbox`, `close`, thread state and ledger spans are therefore invisible in the chat as they are in the Trace, which is the whole point of reusing it.
- **A line's words.** A tool the reader wrote keeps its own name, since that name is in the editor in front of them. The tools the SDK gives a model are renamed to what they did: `list_agents` reads "looked for other agents", `start_agent` "started another agent", `ask_agent` "asked another agent", and so on through `message_agent`, `stop_agent`, `describe_agent`, `inbox_listen`, `inbox_close`, `open_skill` and `report`. The map is `saidAs` in `chat.tsx`.
- **Another agent's work** is nested by run, not by span. Runs whose `fn` is not the chat's own agent are indented one level and their rows carry that agent's name, so a handoff reads as a handoff. Rows of every run are merged and each run's steps are sorted by `startedAt`.
- **Threads** filter the rows: when the chat has a thread selected, a run whose trigger names a different thread is left out.

### What did not work, or was not finished

- **Per-turn answers are unverified, and this is the main risk.** The design above reads each `Thinking` step's output so that a multi-turn loop shows each turn as its own bubble, rather than one bubble at the end. `api.output` on a step id does return `{ input, data, error }`, so the mechanism exists. What was never checked against a live run is whether the Dev Server's `runTraceSpanOutputByID` returns the full `AgentModelResponse` for that step or something trimmed, and whether a large reply is spilled elsewhere: the SDK has a `${stepId}:spill` step named "Save the full output of ...", which suggests a big output does not live on the step. If per-turn text turns out not to be readable, the fallback is one bubble per run from `run.output`, which is the run's final result only, and the multi-turn conversation then collapses into its last line.
- **The span's kind was never confirmed.** The SDK passes `"~span": { kind: "llm" }` for a model call and `{ kind: "tool" }` for a tool call. `server/runs.ts` reads `stepType` into `TraceStep.type` and `groupKind` into `TraceStep.group`, and which of the two carries `"llm"` for a `step.run` with a `~span` was not established. `isThinking()` hedges by checking the name and both fields. Confirm it against one real run and then narrow it.
- **Reports arriving back are still invisible.** Jack asked explicitly for "getting reports back from them, and understanding those reports" to show as lines. A report arrives as an inbox message, which leaves only plumbing spans, so there is no line for it today. What the chat does show is the `start_agent` or `ask_agent` line, whose output carries the child's answer. A real solution needs either a non-plumbing span for an arriving report, or a server-side stream event when one lands.
- **Nothing was wired into the layout.** `App.tsx` still renders `TracePanel` in the bottom right and nothing renders `ChatPanel`. The intention, which is a decision worth confirming before building it, was two tabs in that pane, Chat by default and Trace beside it, rather than deleting the Trace: every written page's prose says "In the Trace, ..." and `PAGES.md` documents it at length, so deleting it breaks all of that at once.
- **Save-and-run on blur is only half there.** `ChatPanel.send()` awaits `onRun()` when `dirty`, but `onRun` resolves when the files have been posted, not when the restarted app is serving again, so a message sent straight after an edit can reach an app that is still starting. It needs a queue that waits for the status to be `live` before it sends.

### The immediate next step

Render `ChatPanel` in the bottom right of `App.tsx`, as a tab beside the Trace, passing `runs`, `chatTarget`, `live`, `dirty`, `runSignal`, `failure`, `run` and `jumpTo`. Add the chat's CSS to `site/src/styles.css`, which has none of it: `.chat`, `.chat-scroll`, `.chat-line` with `.reader` and `.agent`, `.bubble`, `.chat-did`, `.chat-box`. Add `chat` and `chatSend` to the key handler map in `App.tsx` (they are not panel ids any more, so `panelHandlers` does not cover them, and an unhandled action does nothing). Then `pnpm tour:lessons`, then `pnpm tour:page 01-agents/02-hello-agent`, and drive it in a browser: whether the per-turn bubbles work is a thing to see, not to reason about.

### Two defects to fix while in there

Both were reported as pre-existing and neither was looked for in this worktree.

- The harness UI and observer show a `destructive` tool as `write`. `AgentEffects` is `"read" | "write" | "destructive"`, so three values, and a UI that knows two is wrong.
- The agent-builder's prompt text describes the old discovery card schema. The card and the per-caller roster were split, so `AgentCard`, `AgentRoster` and `AgentSummary` are what the prompt should describe.
