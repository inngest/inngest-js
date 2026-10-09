# machine

Machines and the commands that run on them.

- `machine.ts`: creating, snapshotting and destroying a job's machines. A cached job's snapshot is taken under its name and stays for later runs. A cached job's name includes its parent's snapshot, so a parent that changed means a new name and a miss, with nothing to check on restore. A snapshot that won't start is deleted and the parent runs again on the job's own machine. Every other snapshot a run takes is deleted when the run ends (`keepOnFailure` snapshots stay).
- `from.ts`: a job's `from` option: working out the parent, getting its snapshot, and starting the job from it.
- `sandbox.ts`: `sandbox()`, extra machines alongside a job's own.
- `command.ts`: the `$` command tag.
