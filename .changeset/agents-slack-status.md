---
"inngest": minor
---

Experimental agents: `report.status("working" | "idle" | "waiting")` shows whether the agent is working on a thread, through the channels that have a `status` (a step per destination, written in order with the cards, so a replay shows nothing twice). The Slack channel shows it on Slack's agent status line (`agents.sessions.setStatus`, falling back to `assistant.threads.setStatus`, and showing none when neither is available). A card can also carry `output` and `sources`, which the Slack stream sends as the task card's output and source links.
