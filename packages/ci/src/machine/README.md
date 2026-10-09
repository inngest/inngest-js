# machine

Machines and the commands that run on them.

- `machine.ts`: creating, snapshotting and destroying a job's machines. A job only snapshots its own machine, at the end of its build run. A cached job's name includes the snapshot of its parent, so a parent that changed means a new name and a miss, with nothing to check on restore; a snapshot that won't start is deleted and built again. A cached job's snapshot is taken under its name and stays for later runs. Every other snapshot a build run makes, a job without a `cache`, is deleted when the pipeline run that asked for it ends (`keepOnFailure` snapshots stay).
- `from.ts`: a job's `from` option: working out the parent, resolving the snapshot it starts from (and its parent's, for its name), and starting the job from it. Children of one parent share one invoke of the build.
- `sandbox.ts`: `sandbox()`, extra machines alongside a job's own.
- `command.ts`: the `$` command tag.
