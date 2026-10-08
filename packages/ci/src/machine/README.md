# machine

Machines and the commands that run on them.

- `machine.ts`: creating, snapshotting and destroying a job's machines. A job only snapshots its own machine, at the end of its build run. A restore from a cached snapshot is checked against its parents; a bad or stale one is deleted and built again. A cached job's snapshot is taken under its name and stays for later runs. Every other snapshot a build run makes, a job without a `cache`, is deleted when the pipeline run that asked for it ends (`keepOnFailure` snapshots stay).
- `from.ts`: `from()`, starting a job from the snapshot its parent's build run took. Children of one parent share one invoke of the build.
- `sandbox.ts`: `sandbox()`, extra machines alongside a job's own.
- `command.ts`: the `$` command tag.
- `snapshotMeta.ts`: the metadata file CI writes into a machine before snapshotting it (working tree, cached parents), read back when a machine starts from the snapshot.
