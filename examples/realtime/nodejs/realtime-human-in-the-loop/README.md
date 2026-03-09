# Realtime: Implementing Human in the loop with `step.waitForEvent()`

This demos showcases how to combine [Realtime](https://www.inngest.com/docs/features/realtime)'s `publish()` with `step.waitForEvent()` to
enable users to interact with ongoing workflows.

```
npm install
```

```
npm run dev
```

The app will send an event kicking off a workflow and prompt in the terminal to choose
to stop or continue the workflow.
