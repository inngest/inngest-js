# Give it a body

An agent can do work of its own. Let's give our `hello` agent a body: the function we pass to `agents.agent` after the `id`, which runs when the agent starts and returns the run's output.

Press {Run}. Run calls the code in `run.ts`, which starts `hello` with the message `"Hi"`, just as before.

In the Trace, the run is completed. The output of the run is `"I ran."`, the value the body of `hello` returns.
