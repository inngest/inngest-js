# render

Pure functions from data to the markdown a check shows. No GitHub calls, no run state, so each is tested with plain objects.

- `job.ts`: a job's check in each state (`jobCheck`). The callout answers the reader's main question, one row holds every link, and only commands that have started are listed.
- `pipeline.ts`: the pipeline's check while running and when passed, failed or cancelled (`pipelineCheck`).
- `callout.ts`, `links.ts`, `commands.ts`: the callout, the links row (each link once) and the commands table.
- `graph.ts`, `gantt.ts`, `dag.ts`, `tree.ts`: the job list the charts draw, the critical path, the text Gantt, the Mermaid graph and the job tree.
- `types.ts`: the payload, the buttons (at most three) and the shared links.
