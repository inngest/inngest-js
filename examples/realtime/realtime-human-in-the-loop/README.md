# Realtime V2: human in the loop with `step.waitForEvent()`

This Node.js example demonstrates a human-in-the-loop workflow using first-class realtime from the core `inngest` SDK.

It shows:

- `realtime.channel(...)` for a typed workflow message stream
- `publish(topicRef, data)` to prompt the user
- `step.waitForEvent(...)` to pause for user confirmation
- `inngest.realtime.subscribe(...)` to receive prompts in a terminal subscriber

## Setup

```bash
npm install
```

To test with local SDK changes:

```bash
# from packages/inngest
pnpm build && pnpm local:pack

# from this example directory
npm install --no-save ../../../packages/inngest/inngest.tgz
```

## Run

```bash
npm run dev
```

This starts the Inngest dev server and the local app. After sync:

1. The workflow is triggered with `agentic-workflow/start`.
2. A realtime message asks for confirmation.
3. In the terminal, type `yes` to continue or anything else to cancel.
