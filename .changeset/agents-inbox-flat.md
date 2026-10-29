---
"inngest": minor
---

**Breaking (experimental agents):** an inbox message is the event it was made from, flat like `trigger` (`id`, `name`, `data`, `ts`, `seq`), with the fields of a thread message beside it (`kind`, `content`, `payload`, `replyTo`, `when`). Read `msg.content` and `msg.kind`, not `msg.data.content` and `msg.data.kind`, and `msg.name` / `msg.data` for the trigger event, not `msg.data.event`. `msg.name` is the event's own name: the trigger's for a message made from a trigger (narrow it by `name`, `msg.data` is typed from `on`), the event's for a message from an inbox source (`slack/thread.start` stays `slack/thread.start`; narrow it with `msg.is(type)`), and `agent/message` for a plain thread message (`thread.send()`, a reply, a request), whose `data` is the thread message. `inbox.putBack()` takes these messages.
