## Summary

Add SDK feature observations so the JS SDK reports app-level feature readiness and configuration during app sync. This lets Inngest understand whether features such as AI metadata extraction, Extended Traces, and event sending are configured and ready.

There are no user-facing changes in this PR. We're only adding more data to the existing app sync payload.

## Changes

- Added feature observation protobufs and generated TS bindings.
- Added `sdkFeatureObservations` state/serialization in the SDK client.
- Reports observations through Connect config and app sync payloads.
- Records AI metadata and Extended Traces setup outcomes, including async OTel provider setup before app sync snapshots are sent.
