# Next.js + Inngest Realtime Example

This is a [Next.js](https://nextjs.org/) project showcasing how to use [`@inngest/realtime`](https://npm.im/@inngest/realtime) with Inngest for real-time data streaming.

## Features

- Live data streaming from Inngest to your frontend
- React hooks for real-time data updates
- Typescript integration with channel and topic typing
- Example pattern for real-time event handling

## Getting Started

### Clone the Repository

```bash
git clone https://github.com/inngest/inngest-js.git
cd inngest-js/examples/realtime/next-realtime-hooks
```

### Install Dependencies

```bash
npm install
# or
yarn install
# or
pnpm install
```

### Start the Development Server

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
```

In a separate terminal, start the Inngest Dev Server:

```bash
npx inngest-cli@latest dev
```

Open [localhost:3000](http://localhost:3000) and click on the "Start" button to see the incoming realtime message appear.

## Project Structure

- `/app` - Next.js app router pages and components
- `/app/api/inngest` - Inngest API route handler
- `/app/inngest` - Inngest function definitions
- `/components` - React components including realtime examples

## Key Concepts

### Setting Up Inngest

The project uses the Inngest client defined in `/app/inngest/client.ts`:

```typescript
import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "realtime-next-app",
  // Additional config options here
});
```

### Using Realtime Subscriptions

The `@inngest/realtime` package provides hooks for subscribing to real-time data:

```typescript
import { useInngestSubscription } from "@inngest/realtime/hooks";
import { inngest } from "./path-to-client";

function MyComponent() {
  const { data, latestData, state } = useInngestSubscription({
    app: inngest,
    token: {
      channel: "my-channel",
      topics: ["my-topic"],
    },
    enabled: true,
  });

  // Render with real-time data
}
```

### Subscription Tokens

To create subscription tokens for specific channels and topics:

```typescript
import { getSubscriptionToken } from "@inngest/realtime";

const token = await getSubscriptionToken(inngest, {
  channel: "my-channel",
  topics: ["my-topic"],
  // Optional filters, expiration, etc.
});
```

## Learn More

- [Inngest Documentation](https://www.inngest.com/docs) - Learn about Inngest features and API
- [Inngest Realtime Documentation](https://www.inngest.com/docs/features/realtime) - Learn about the realtime features
- [Next.js Documentation](https://nextjs.org/docs) - Learn about Next.js features and API
