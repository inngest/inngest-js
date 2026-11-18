---
"inngest": patch
"@inngest/ci": patch
---

Reject `$.sh` templates that combine interpolated values with `<<` in static text before starting the command. Heredoc bodies ignore the single quotes added around values, which allowed command substitution in untrusted text to execute. This conservative restriction includes quoted or escaped `<<` literals and values outside the heredoc body. Static heredocs and `<<` passed as data remain supported. Use `$.sh` with `printf %s ${value}` to write untrusted text instead.

Templates with interpolated values also reject backticks in static text, including quoted or escaped literals. The shell removes one level of backslashes inside backticks, which hid `<<` from the check, and a backtick in a value ended the substitution and ran the rest of the value as a command. Static backticks and backticks passed as data remain supported. Use `$(command)` instead.
