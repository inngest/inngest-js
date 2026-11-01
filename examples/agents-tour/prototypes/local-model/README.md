# Local model prototype (throwaway)

Answers one question: is a small GGUF model, run in the tour's Node process by `node-llama-cpp`, good enough to be the tour's default model when the reader has no API key?

This is a prototype. It is not wired into the tour and will not be merged. The answer is in `projects/agents-tour/notes/prototype-local-model.md` (inngest workspace notes).

## Run

From `examples/agents-tour`, after `pnpm install --ignore-workspace --config.lockfile=false` (and `pnpm --filter inngest build` at the repo root, for the types):

```sh
pnpm tour:model-proto --model qwen3-1.7b --runs 10
```

Options: `--scenarios answer,tool,chain`, `--threads 4`, `--no-cache` (drop the evaluated prefix before each call), `--tag name` (suffix for the results file). Models are listed in `models.ts` and download once into `~/.cache/agents-tour-models/`.

Each run prints every step: the request summary, the raw model output and the pass or fail note. Results go to `results/<model>.json`; `node prototypes/local-model/report.ts` prints the summary table. `node --test prototypes/local-model/history.test.ts` checks the request-to-history mapping.

## Files

- `local-model.ts`: `localModel(file)`, an `AgentModel` over `node-llama-cpp`'s `LlamaChat`.
- `history.ts`: maps an `AgentModelRequest` to chat history (tested).
- `scenarios.ts`: answer, one tool, and the find-and-start-an-agent chain.
- `run.ts`, `report.ts`, `all.sh`: harness, summary, and a one-at-a-time runner.
