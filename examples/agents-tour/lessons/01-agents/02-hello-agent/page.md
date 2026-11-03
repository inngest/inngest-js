# Hello, agent

An agent is a function that Inngest runs for you, durably. This is the smallest one there is: an `id` and nothing else.

Press {Run}. It calls `hello.start("Hi")`, which starts one run of `hello`.

In the Trace, the run is completed. Its first row is the message, `Hi`. It has no body yet, so it returns nothing.
