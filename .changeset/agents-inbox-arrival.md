---
"inngest": minor
---

An agent can react the moment a message reaches a thread whose run is busy. `onArrival({ message, thread, step, ... })` runs once per such message, as soon as it is saved, in a function of its own (`<id>-arrival`, served by `agents.functions()`), so it can post an acknowledgement while the turn is still working. It does not run for the message that started the run, or for a thread that is waiting for its next message.

`agent.loop()` inside an agent body now steers and stops through the agent's inbox without the app spreading `control`: messages that arrive during a turn are folded in at the next model call. `foldMessages: "all"` folds user messages too (default `"steer"`: only steering messages). A folded message is consumed, so `next()` does not return it again. For a loop of your own, `inbox.drain()` takes the pending messages (stops included) the same way.
