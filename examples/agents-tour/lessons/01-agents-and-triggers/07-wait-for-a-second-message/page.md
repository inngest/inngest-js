# Wait for a second message

A second `next()` has nothing to return yet, so the run waits. Nothing is held while it waits.

Each message is its own `agent/message` event, so each has its own `data.text`.

Run it, then press **Send a message** on the left. The run wakes up, and the second row of the Trace ends.
