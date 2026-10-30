---
"inngest": patch
---

`run_code` now stops a replay that no longer matches its first run: a script that calls another tool, passes other arguments or makes fewer calls exits with code 76 and says so on stderr, where a `try`/`except` can't hide it. A script's own exit code 75 is no longer mistaken for a wait. The `timeout` option is per run of the script between waits, and anything a script does outside tool calls (writing files, starting processes) happens again on each run. A tool named `now` or `sleep`, or `tools` with an `only` that leaves out `run_code`, now throws.
