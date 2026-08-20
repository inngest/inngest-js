# Durable Trip Booking Example

A comprehensive trip booking system demonstrating **Inngest's Durable Endpoints** approach, built with Next.js.

## What are Durable Endpoints?

**Durable Endpoints** is a new durable execution approach in Inngest that allows you to make regular HTTP handlers durable using `step.run()` directly, without defining separate Inngest functions or using events.

```typescript
import { step } from "inngest";
import { Inngest } from "inngest";
import { endpointAdapter } from "inngest/next";

const inngest = new Inngest({ id: "my-app", endpointAdapter });

// This Next.js API route is now durable!
export const GET = inngest.endpoint(async (req) => {
  // Each step is persisted - survives crashes/restarts
  const result = await step.run("my-step", async () => {
    return await doSomething();
  });

  return new Response(JSON.stringify({ result }));
});
```

## Features Demonstrated

This example showcases production-ready patterns using Inngest Durable Endpoints:

- **Durable HTTP Handlers** - Next.js API routes made durable with `inngest.endpoint()`
- **4-Step Booking Orchestration** - Flight search, reservation, payment, and confirmation
- **Automatic Retries** - Step failures trigger Inngest's built-in retry mechanism
- **Real-time UI Updates** - Live progress tracking with polling
- **Code Viewer** - See the durable endpoint code highlighted as each step executes

## Architecture

```
┌─────────────────────────────────────────┐
│   Next.js App (Port 3000)               │
├─────────────────────────────────────────┤
│ Frontend:                               │
│ - Booking Form                          │
│ - Progress Tracker                      │
│ - Code Viewer                           │
│                                         │
│ API Routes (Durable):                   │
│ - GET /api/booking        (endpoint)    │
│ - GET /api/booking/events (polling)     │
└─────────────────────────────────────────┘
```

### Key Difference from Traditional Inngest

| Traditional Inngest              | Durable Endpoints           |
| -------------------------------- | --------------------------- |
| Define separate functions        | Inline in HTTP handlers     |
| Trigger via events               | Direct HTTP calls           |
| `inngest.createFunction()`       | `inngest.endpoint()`        |
| `{ event, step }` from context   | Import `step` directly      |
| Separate `/api/inngest` endpoint | No separate endpoint needed |

## Getting Started

### Prerequisites

- Node.js 20+

### Installation & Setup

**1. Install Dependencies**

```bash
cd next-app
npm install
```

**2. Start the App**

```bash
cd next-app
npm run dev
# Runs on http://localhost:3000
```

**3. Create a Booking**

1. Open http://localhost:3000
2. Select origin and destination airports
3. Pick a departure date
4. Click "Search & Book"
5. Watch real-time progress as each durable step executes

## Learn More

- [Inngest Documentation](https://www.inngest.com/docs)
- [Inngest Step Functions](https://www.inngest.com/docs/functions/steps)

## License

MIT
