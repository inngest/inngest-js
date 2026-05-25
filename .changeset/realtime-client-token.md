---
"inngest": patch
---

Allow `useRealtime` to accept direct client subscription tokens from `getClientSubscriptionToken()` when `channel` and `topics` are provided as hook options, and avoid reconnecting solely because an inline token factory or token object gets a new render identity.
