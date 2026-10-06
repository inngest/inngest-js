# machine

Machines and the commands that run on them.

- `machine.ts`: creating, pausing, snapshotting and destroying a job's machines. A restore from a cached snapshot is probed once per run and checked against its parents; a bad or stale one is deleted and rebuilt. A cached job's snapshot is taken under its name and stays for later runs. Every other snapshot a run takes, including a cached job's unnamed fallback when the server refuses names, is deleted when the run ends (`keepOnFailure` snapshots stay).
- `from.ts`: `from()`, starting a job from another job's machine.
- `sandbox.ts`: `sandbox()`, extra machines alongside a job's own.
- `command.ts`: the `$` command tag.
- `snapshotMeta.ts`: the metadata file CI writes into a machine before snapshotting it (working tree, cached parents), read back when a machine starts from the snapshot.
