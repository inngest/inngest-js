# The inbox

An agent has an `inbox`. `inbox.next()` waits for a message and returns it.

The event Run sends starts the run and is also the inbox's first message, so the first `next()` returns it straight away.

Run it: the agent returns the text of that message.
