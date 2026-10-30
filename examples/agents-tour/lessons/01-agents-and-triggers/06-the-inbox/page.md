# The inbox

An agent has an `inbox`. `inbox.next()` waits for a message and returns it.

A message is a plain event: `id`, `name`, `data`, `ts` and `seq`. The event Run sends starts the run and is also the inbox's first message, so the first `next()` returns it straight away.

Checking `message.name` tells TypeScript what `data` holds. For `agent/message` the text is `message.data.text`.

Run it: the agent returns that text.
