# DeepResearch - Inngest Durable Endpoints Demo

An AI-powered deep research assistant showcasing [Inngest's Durable Endpoints](https://www.inngest.com/docs/features/inngest-functions/durable-endpoints) - bringing durability to HTTP endpoints without requiring queues, workers, or background job infrastructure.

## What are Durable Endpoints?

**Durable Endpoints** transform regular HTTP handlers into fault-tolerant, resumable workflows. Unlike traditional API endpoints that fail completely on errors, Durable Endpoints persist execution state at each step, enabling:

- **Automatic Retries**: Failed steps retry automatically without re-executing completed work
- **Crash Recovery**: Resume from the last successful step after server restarts
- **Long-running Operations**: Handle workflows that take minutes or hours
- **No Infrastructure**: No queues, workers, or job processors required

### How It Works

```typescript
import { Inngest, step } from "inngest";
import { endpointAdapter } from "inngest/next";

const inngest = new Inngest({ id: "my-app", endpointAdapter });

// Regular Next.js route handler becomes durable
export const GET = inngest.endpoint(async (req) => {
  // Each step.run() is persisted and can retry independently
  const data = await step.run("fetch-data", async () => {
    return await fetchExternalAPI(); // Retries on failure
  });

  const result = await step.run("process", async () => {
    return await processData(data); // Won't re-run if fetch already succeeded
  });

  return Response.json({ result });
});
```

### Benefits Over Traditional Approaches

| Traditional API                             | Durable Endpoint                         |
| ------------------------------------------- | ---------------------------------------- |
| Fails completely on any error               | Retries failed steps, preserves progress |
| Timeout after 30s-60s                       | Can run for hours                        |
| Requires separate job queue for reliability | Built-in durability                      |
| Manual retry logic needed                   | Automatic with memoization               |
| Lost work on crashes                        | Resumes from last checkpoint             |

## Features

- **Recursive Deep Research**: 3 levels of search depth, exploring subtopics and follow-up questions
- **Clarification Questions**: AI-generated questions to refine research focus
- **Real-time Progress**: Live polling updates showing sources, learnings, and reasoning
- **Parallel Execution**: Search and analysis steps run in parallel for speed
- **Durability Demo Mode**: Inject failures to see automatic retry behavior
- **Live Code Highlighting**: Visual display of which step is currently executing

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) 20+ installed
- [Anthropic API key](https://console.anthropic.com/)
- [Exa API key](https://exa.ai/)

### Clone the Repository

```bash
git clone https://github.com/inngest/inngest-js.git
cd inngest-js/examples/durable-endpoints-deepresearch/next-app
```

### Install Dependencies

```bash
npm install
# or
pnpm install
```

### Configure Environment Variables

Create `next-app/.env.local`:

```bash
EXA_API_KEY=your_exa_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
```

### Start the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to start researching.

### Demo Mode: Testing Durability

To see Inngest's automatic retry behavior, add URL parameters:

```
http://localhost:3000?injectFailure=search&failureRate=0.3
```

Options:

- `injectFailure`: Step type to fail (`search`, `learn`, or `report`)
- `failureRate`: Probability of failure (0.0 to 1.0, default: 0.3)

Watch the Execution Log to see retries and recoveries in action.

## Project Structure

```
durable-endpoints-deepresearch/
└── next-app/                       # Next.js full-stack app
    └── src/
        ├── app/
        │   ├── page.tsx            # Main page with split view
        │   └── api/research/
        │       ├── route.ts        # Main durable research endpoint
        │       ├── clarify/
        │       │   └── route.ts    # Durable clarification endpoint
        │       └── events/
        │           └── route.ts    # Polling endpoint for progress events
        ├── inngest/
        │   ├── client.ts           # Inngest client with Next.js adapter
        │   ├── deep-research.ts    # Recursive research algorithm
        │   ├── llm.ts              # LLM functions (Claude via Vercel AI SDK)
        │   ├── search.ts           # Exa search integration
        │   ├── event-store.ts      # Polling-based progress events
        │   ├── types.ts            # Backend type definitions
        │   └── utils.ts            # Helper functions
        ├── components/
        │   ├── TopicInput.tsx      # Research topic input form
        │   ├── ClarificationForm.tsx  # Clarification Q&A
        │   ├── ResearchProgress.tsx   # Progress display with sources
        │   ├── ResearchComplete.tsx   # Final report view
        │   ├── CodeViewer.tsx      # Live code highlighting
        │   ├── ExecutionLog.tsx    # Real-time execution logs
        │   └── ui.tsx              # Shared UI components
        ├── hooks/
        │   └── useResearch.ts      # Research state management & polling
        └── types.ts                # Frontend type definitions
```

## DeepResearch Algorithm

The research workflow implements a recursive depth-first search with parallel execution:

### Phase 1: Planning

```
User Topic + Clarifications
         │
         ▼
┌─────────────────────────────────┐
│  Generate Search Queries        │  ← step.run("generate-queries")
│  (3 queries with reasoning)     │
└─────────────────────────────────┘
```

### Phase 2: Recursive Deep Research

```
For each query at depth N:
         │
         ▼
┌─────────────────────────────────┐
│  Search (Exa API)               │  ← step.run(`search-d${depth}-${hash}`)
│  Returns 5 sources per query    │     Parallel execution via Promise.all
└─────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  Extract Learnings              │  ← step.run(`learn-d${depth}-${hash}`)
│  - Key insights                 │     Parallel execution via Promise.all
│  - Source rationale             │
│  - Follow-up queries            │
└─────────────────────────────────┘
         │
         ▼
    If depth > 1 && followUps exist
         │
         ▼
    Recurse with follow-up queries
    (depth - 1, breadth / 2)
```

### Phase 3: Synthesis

```
All accumulated learnings + sources
         │
         ▼
┌─────────────────────────────────┐
│  Generate Report                │  ← step.run("generate-report")
│  - Executive summary            │
│  - Themed sections              │
│  - Inline citations [1][2]      │
│  - References list              │
└─────────────────────────────────┘
```

## Technology Stack

- **Framework**: [Next.js](https://nextjs.org) 15 + React 19
- **Durability**: [Inngest Durable Endpoints](https://www.inngest.com/docs)
- **LLM**: [Vercel AI SDK](https://sdk.vercel.ai/) + Anthropic Claude Sonnet
- **Search**: [Exa API](https://exa.ai/)
- **Styling**: TailwindCSS

## Learn More

- [Inngest Documentation](https://www.inngest.com/docs)
- [Durable Endpoints Guide](https://www.inngest.com/docs/learn/rest-endpoints)
- [Exa API](https://docs.exa.ai/)

## License

MIT
