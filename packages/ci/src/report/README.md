# report

Reading what a command's output says about a failure.

- `classify.ts`: the class of a failed command (test, code, infrastructure, out of memory, signal, timeout, or plain failure), from its exit code and output. `infraSignals` is the one list of output that points at the platform, with a test for each entry.
