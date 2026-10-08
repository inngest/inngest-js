# machine

Machines and the commands that run on them.

- `machine.ts`: creating, pausing, snapshotting and destroying a job's machines. A cached job's snapshot is taken under its name and stays for later runs. A restore from a cached snapshot is checked against its parents; a bad or stale one is deleted and the parent runs again on the job's own machine. Every other snapshot a run takes is deleted when the run ends (`keepOnFailure` snapshots stay).
- `from.ts`: `from()`, starting a job from another job's machine.
- `sandbox.ts`: `sandbox()`, extra machines alongside a job's own.
- `command.ts`: the `$` command tag.
- `snapshotMeta.ts`: the metadata file CI writes into a machine before snapshotting it (its working tree and the cached parents), read back when a machine starts from the snapshot.
