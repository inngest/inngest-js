---
"@inngest/ci": minor
---

`checkout()` and `files()` take `repo` and `ref`, to read another repository or ref. The ref is resolved to a commit once per run, and the GitHub App installation is found from the repository. `checkout({ repo })` also works in a run whose trigger has no repository.
