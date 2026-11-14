---
"inngest": patch
---

Fix `timeStr` silently turning a duration string that `ms` cannot parse (such as the compound `"1h30m"` / `"1h 30m"` form) into `""`, which the server treats as a 0-second wait. `step.sleep`, `step.waitForEvent`, `step.waitForSignal`, `step.invoke` and `cancelOn` timeouts now sum compound duration strings (matching `durationToMs`) and throw on an unparseable duration instead of sending `""`.
