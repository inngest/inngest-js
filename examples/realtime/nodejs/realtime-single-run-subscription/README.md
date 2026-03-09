# Realtime: stream updates from a single function run

This demo Node.js project shows how to [stream](https://www.inngest.com/docs/features/realtime) and subscribe to updates from a single Inngest Function run.

```
npm install
```

```
npm run dev
```

The app will send 10 `app/process-upload` events while subscribing to a specific run using a `uuid`.
