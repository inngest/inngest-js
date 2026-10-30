---
"inngest": patch
---

A `git_push` without git now reads its manifest in pieces, so a push can weigh up to 8 MiB (`maxBytes`, default 4 MiB) instead of about 700 KB of new files. A new branch may be cut from any older commit of the repository, not only the default branch's tip. If GitHub rebuilds the commits with other hashes than the sandbox's, the result carries `sandboxSha` and a warning to clone or fetch before the next push. A file that replaces a directory in one commit, a file too big for a policy to read, and a missing `git` now give clear, non-retried errors.
