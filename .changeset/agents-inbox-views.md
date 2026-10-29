---
"inngest": minor
---

`inbox.of(type)` is a view of the messages of one event: it reads them with a cursor of its own, in the order they arrived, and hides nothing from the inbox or other views. A view has `next()` (waits; `{ timeout }` gives up with `undefined`, `{ timeout: 0 }` never waits), `unread()` (what is after its cursor) and `current()` (every one so far), and iterates with `for await`. Messages are typed by the event type. `msg.is(type)` narrows a message by event name and data: `if (msg.is(order)) msg.data.total`.

Messages from an inbox source are checked against its event type like trigger events: ones that break the schema are dropped. Each source words its messages for the model by itself, even when two sources take the same event (`msg.stream` tells which source saved a message).
