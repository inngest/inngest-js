---
"inngest": minor
---

Experimental agents: the names of an agent's sandboxes and of their tools are typed. In the body, `sandboxes` is keyed by the names in the config's `sandboxes` and `sandboxTools` by `<sandbox>_<tool>` (`work_run`), so a typo such as `sandboxes.wrok` or `sandboxTools.work_rn` fails to compile. `sandbox({ tools })` keeps the names of the tools its factory brings, including `only` of `sandbox.tools.code()`.

A `sandboxes` record you type yourself as `Record<string, SandboxDefinition>` is not narrowed: any name compiles.

An agent without `sandboxes` now has `sandboxes` and `sandboxTools` typed as `{}`, so indexing them with a dynamic or unknown key no longer compiles.
