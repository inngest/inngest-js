---
"@inngest/ci": minor
---

Add `cache.maxAge`: a cached snapshot older than it counts as a miss, so the job builds again and the new snapshot takes the name. A malformed `maxAge` throws when the job is defined.
