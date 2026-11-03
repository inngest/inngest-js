# Hello, agent

An agent is a function that Inngest runs for us, durably. Let's start with the smallest one there is: our `hello` agent has an `id` and nothing else.

Press {Run}. Run calls the code in `run.ts`, which starts `hello` with the message `Hi`.

In the Trace, the run is completed. The first row of the run is the message `Hi`. `hello` has no body yet, so the run returns nothing.
