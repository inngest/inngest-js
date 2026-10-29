# A blank agent

An agent is a function that Inngest runs for you.

It starts when an event arrives. Run sends one:

`{ name: "agent/message", data: { content: "Hi", ... } }`

That event starts a run, and it is also the first message in the agent's inbox. Click **Run sends** to see all of it.

This agent has an `id` and does nothing. Press **Run**: the Trace shows the run, and its first row is that event.
