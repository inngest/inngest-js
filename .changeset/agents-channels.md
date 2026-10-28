---
"inngest": minor
---

Agents in `inngest/experimental/agents` can report where work started. `channels` in the agent config names destinations (a value, or a function of the trigger), `report` picks where progress goes, and the body's `report("...")` posts to them, one durable step per destination. `defineChannel({ post, ask })` makes a channel from your own adapter. Experimental `slack.thread({ in })` and `github.thread({ repos })` start an agent from a Slack message or a GitHub comment, and `slack.channel(event, { in })` and `github.channel(event, { repos })` post back to the same thread. The allow list is required and checked again by the channel, text the agent writes is escaped so it cannot mention people or forge links, and API errors that a retry cannot fix are not retried.

```ts
const support = agents.agent(
  {
    id: "support",
    on: slack.thread({ in: ["C0123ABC"] }),
    channels: ({ event }) => {
      return { main: slack.channel(event, { in: ["C0123ABC"] }) };
    },
  },
  async ({ inbox, report }) => {
    await report("Looking into it");
  },
);
```
