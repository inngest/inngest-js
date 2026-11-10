---
"inngest": patch
---

Build the memoized step state for each request in linear time. The previous reduce copied the whole state for every step, which was quadratic in the number of completed steps.
