# machine

Machines and the commands that run on them.

- `machine.ts`: creating, pausing, snapshotting and destroying a job's machines.
- `from.ts`: `from()`, starting a job from another job's machine.
- `sandbox.ts`: `sandbox()`, extra machines alongside a job's own.
- `layer.ts`: layer snapshots, one per run, for jobs that would each upload the same large change.
- `command.ts`: the `$` command tag.
