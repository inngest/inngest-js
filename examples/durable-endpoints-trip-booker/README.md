# Durable Trip Booking Example

A comprehensive trip booking system demonstrating **Inngest's Durable Endpoints** approach, built with Bun and Next.js.

## What are Durable Endpoints?

**Durable Endpoints** is a new durable execution approach in Inngest that allows you to make regular HTTP handlers durable using `step.run()` directly, without defining separate Inngest functions or using events.

```typescript
import { step } from "inngest";
import { createExperimentalEndpointWrapper } from "inngest/edge";

const wrap = createExperimentalEndpointWrapper({
  client: new Inngest({ id: "my-app" }),
});

// This HTTP handler is now durable!
const handler = wrap(async (req: Request) => {
  // Each step is persisted - survives crashes/restarts
  const result = await step.run("my-step", async () => {
    return await doSomething();
  });

  return new Response(JSON.stringify({ result }));
});
```

## Features Demonstrated

This example showcases production-ready patterns using Inngest Durable Endpoints:

✅ **Durable HTTP Handlers** - Regular handlers made durable with `wrap()`
✅ **7-Step Booking Orchestration** - Flight search, booking and payment processing
✅ **Inline Error Handling** - Try/catch with durable compensation steps
✅ **Compensation Patterns (Saga)** - Inline rollback on failure with idempotent operations
✅ **Real-time UI Updates** - Live progress tracking with polling
✅ **Demo Scenarios** - Happy path and flight failure

## Architecture

```
┌─────────────────┐                  ┌───────────────────────────┐
│   Next.js App   │                  │   Bun API (Durable)       │
│   (Port 3000)   │                  │   (Port 4000)             │
├─────────────────┤                  ├───────────────────────────┤
│ - Booking Form  │                  │ - wrap() durable handlers │
│ - Status Page   │                  │ - step.run() in handlers  │
│ - Email Handler │◄────REST────────►│ - Inline compensation     │
│                 │                  │ - Mock Providers          │
└─────────────────┘                  └───────────────────────────┘
```

### Key Difference from Traditional Inngest

| Traditional Inngest              | Durable Endpoints           |
| -------------------------------- | --------------------------- |
| Define separate functions        | Inline in HTTP handlers     |
| Trigger via events               | Direct HTTP calls           |
| `inngest.createFunction()`       | `wrap(async (req) => ...)`  |
| `{ event, step }` from context   | Import `step` directly      |
| Separate `/api/inngest` endpoint | No separate endpoint needed |

## Getting Started

### Prerequisites

- **Bun** (for backend API) - https://bun.sh
- Node.js 20+ (for Next.js frontend)

### Installation & Setup

**1. Install Dependencies**

```bash
# Install Bun API dependencies
cd express-api
bun install

# Install Next.js app dependencies
cd ../next-app
npm install
```

**2. Start Services**

```bash
# Terminal 1: Start Bun API with Durable Endpoints
cd express-api
bun run dev
# Runs on http://localhost:4000

# Terminal 2: Start Next.js App
cd next-app
npm run dev
# Runs on http://localhost:3000
```

**3. Create a Booking**

1. Open http://localhost:3000
2. Fill out the booking form
3. Select a demo scenario (or use "Happy Path")
4. Click "Book Trip"
5. Watch real-time progress on the status page

## Learn More

- [Inngest Documentation](https://www.inngest.com/docs)
- [Inngest Step Functions](https://www.inngest.com/docs/functions/steps)
- [Bun Documentation](https://bun.sh/docs)
- [Saga Pattern](https://microservices.io/patterns/data/saga.html)

## License

MIT
