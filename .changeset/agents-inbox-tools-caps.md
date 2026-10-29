---
"inngest": patch
---

The model's inbox tools have tighter default caps: a source can be listened to 3 times in a run (`maxPerRun`; stopping a listener does not give the place back), and the model may wait 2 hours in all in a run (`maxTotalWait`), besides the longest single wait (`maxWait`, default 30 minutes). An `if` that indexes the event as `event["data"]`, or holds a line break beyond ASCII, is refused.
