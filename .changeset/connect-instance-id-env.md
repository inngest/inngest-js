---
"inngest": minor
---

Add support for `INNGEST_CONNECT_INSTANCE_ID` to set the connect instance ID when the `instanceId` option is omitted.  Checkpoint requests now include the connected app's instance ID in the `x-inngest-instance-id` header.  Outside of connect, checkpoint requests use `INNGEST_CONNECT_INSTANCE_ID` when it is set.
