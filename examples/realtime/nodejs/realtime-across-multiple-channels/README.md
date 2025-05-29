# Realtime: stream updates from multiple function runs

This demo Node.js project shows how to use [Realtime](https://www.inngest.com/docs/features/realtime) to stream updates from
multiple Inngest Function runs by a mix of global and dynamics channels.

```
npm install
```

```
npm run dev
```

The app will send periodic `app/post.like` events to the server, causing
publishes and the subscriptions to fire.
