# machine

Machines and the commands that run on them.

- `machine.ts`: creating, pausing, snapshotting and destroying a job's machines, and deleting the snapshots a run took when it ends (cache entries and `keepOnFailure` snapshots stay).
- `from.ts`: a job's `from` option: working out the parent, and starting the job from its machine.
- `sandbox.ts`: `sandbox()`, extra machines alongside a job's own.
- `command.ts`: the `$` command tag.
