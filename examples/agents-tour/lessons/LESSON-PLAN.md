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
