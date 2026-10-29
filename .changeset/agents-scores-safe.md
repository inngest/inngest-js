---
"inngest": minor
---

Agent scores are best effort, and `AgentScores` and `AgentScoreName` are exported from `inngest/experimental/agents`. Scores need a server that stores score metadata (Dev Server 1.49 or later, and Inngest Cloud with scores enabled). Checked on Dev Server 1.45.1: a step that carries a score still completes, and `agent.score()` outside a step logs a warning (once per execution of the run) and goes on instead of failing or retrying the run. Names starting with `agent.` are kept for the framework's own scores, so `agent.score("agent.model_ms", 1)` throws. With `scores: false`, a `report()` post step saves nothing, as before. With scores on, a post step saves the time it finished, so a run that saved posts before the upgrade is not rescored: its saved posts are replayed unscored, the post after them is not scored as the first, and later posts are scored from the first post that saved a time.
