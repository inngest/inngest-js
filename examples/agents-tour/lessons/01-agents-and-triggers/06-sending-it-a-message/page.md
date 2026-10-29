# Sending it a message

An agent has an `inbox`. `inbox.next()` waits for a message and returns it.

Run sends an event. That event starts the run and is also the inbox's first message, so the first `next()` returns it straight away.

The second `next()` has nothing to return yet, so the run waits.
Type a message in the box on the left and press Enter.
