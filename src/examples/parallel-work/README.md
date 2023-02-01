# Parallel Work Example

This example demonstrates how to run concurrent chains of work in the same step function, bringing their values together at the end.

It is triggered by a `demo/parallel.work` event, runs 2 separate chains of work in parallel: `getScore()` and `getFruits()`.

`getScore()` will run 3 steps sequentially, returning a `number` score.

`getFruits()` will run 3 steps in parallel, returning an array of fruits.

Finally, we return the result of these two chains of work at the end of the function.

```mermaid
graph TD
Inngest -->|demo/parallel.work| Function

subgraph getScore["getScore (sequential)"]
score1[First score]
score1 -->|Run step| score2[Second score]
score2 -->|Run step| score3[Third score]
end

subgraph getFruits["getFruits (parallel)"]
apple[Get apple]
banana[Get banana]
orange[Get orange]
end

Function -->|Run steps| getScore & getFruits

getFruits ----> ret[Accumulate results]
score3 --> ret
ret -->|Returns| done["[ 6, 'Apple, Banana, Orange' ]"]
```
