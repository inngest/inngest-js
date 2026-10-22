---
"@inngest/ci": patch
---

Pull request runs now test the pull request as it would be merged, as GitHub's own checks do: `checkout()` and `files()` cache keys use the commit of GitHub's test merge of the head into the base, so a branch that is behind its base is no longer tested without the base's latest fixes. Checks and statuses are still posted on the head commit. A pull request that conflicts with its base fails the run with "PR has conflicts with main", naming its base branch.
