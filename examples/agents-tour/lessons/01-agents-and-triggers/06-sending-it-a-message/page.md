# Sending it a message

An agent has an `inbox`. `inbox.next()` waits for a message and returns it.

Run sends an event, shown in the `run.ts` tab. That event starts the run and is also the inbox's first message, so the first `next()` returns it straight away.

The second `next()` has nothing to return yet, so the run waits. Press **Send a message** on the left to send it one.
