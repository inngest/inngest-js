# report

Reading what a command's output says about a failure.

- `classify.ts`: the class of a failed command (test, code, infrastructure, out of memory, signal, timeout, or plain failure), from its exit code and output. `infraSignals` is the one list of output that points at the platform, with a test for each entry.
- `tsc.ts`, `vitest.ts`, `eslint.ts`, `biome.ts`: parsers from a tool's output or JSON to `Found` (a problem in a file). A parser that finds nothing adds nothing and never fails.
- `detect.ts`: whether a command is a direct call of a tool that reports as JSON, and where it writes it. A script that wraps a tool is not recognised; `report.results` reads its file.
- `paths.ts`: a printed path to a path in the repository, from the machine's `/work`.
- `annotations.ts`: what a check carries: repeats grouped, duplicates dropped, failures first, at most 200.
