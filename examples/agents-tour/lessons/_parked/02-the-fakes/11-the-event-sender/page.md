# The event sender

Any event can start an agent. The **Events** tab sends a `tour/greet` event for a random name to the Dev Server, and `message.name` tells the agent which event it got.

The agent reads the name from `message.data.name`. Run the page, press **Send an event**, and look at the Trace.
