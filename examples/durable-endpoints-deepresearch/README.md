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
import { endpointAdapter } from "inngest/edge";

const inngest = new Inngest({ id: "my-app", endpointAdapter });

// Regular endpoint becomes durable
export const handler = inngest.endpoint(async (req) => {
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

| Traditional API | Durable Endpoint |
|----------------|------------------|
| Fails completely on any error | Retries failed steps, preserves progress |
| Timeout after 30s-60s | Can run for hours |
| Requires separate job queue for reliability | Built-in durability |
| Manual retry logic needed | Automatic with memoization |
| Lost work on crashes | Resumes from last checkpoint |

## Features

- **Recursive Deep Research**: 3 levels of search depth, exploring subtopics and follow-up questions
- **Clarification Questions**: AI-generated questions to refine research focus
- **Real-time Progress**: Live polling updates showing sources, learnings, and reasoning
- **Parallel Execution**: Search and analysis steps run in parallel for speed
- **Durability Demo Mode**: Inject failures to see automatic retry behavior
- **Live Code Highlighting**: Visual display of which step is currently executing

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) installed
- [Node.js](https://nodejs.org) 20+ installed
- [Anthropic API key](https://console.anthropic.com/)
- [Exa API key](https://exa.ai/)

### Clone the Repository

```bash
git clone https://github.com/inngest/inngest-js.git
cd inngest-js/examples/durable-endpoints-deepresearch
```

### Install Dependencies

**Backend (Express API):**

```bash
cd express-api
bun install
```

**Frontend (Next.js):**

```bash
cd ../next-app
npm install
# or
pnpm install
```

### Configure Environment Variables

Create `express-api/.env`:

```bash
EXA_API_KEY=your_exa_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
```

Optionally create `next-app/.env.local`:

```bash
NEXT_PUBLIC_BUN_API_URL=http://localhost:4000
```

### Start the Development Servers

**Terminal 1 - Backend (port 4000):**

```bash
cd express-api
bun run dev
```

**Terminal 2 - Frontend (port 3000):**

```bash
cd next-app
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
├── express-api/                    # Bun backend with Durable Endpoints
│   └── src/
│       ├── index.ts                # Express server setup
│       └── routes/
│           ├── research.ts         # Main endpoint handlers (clarify, research, events)
│           ├── deep-research.ts    # Recursive research algorithm
│           ├── llm.ts              # LLM functions (Claude via Vercel AI SDK)
│           ├── search.ts           # Exa search integration
│           ├── event-store.ts      # Polling-based progress events
│           ├── types.ts            # TypeScript type definitions
│           └── utils.ts            # Helper functions
│
└── next-app/                       # Next.js frontend
    └── src/
        ├── app/
        │   └── page.tsx            # Main page with split view
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

### Key Files Explained

| File | Purpose |
|------|---------|
| `research.ts` | Durable endpoint handlers using `inngest.endpoint()` |
| `deep-research.ts` | Recursive parallel search with `step.run()` for durability |
| `llm.ts` | Claude integration for queries, learnings, and report generation |
| `event-store.ts` | In-memory event store for polling-based progress updates |
| `useResearch.ts` | React hook managing research state and event polling |
| `CodeViewer.tsx` | Syntax-highlighted code view with active step highlighting |

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

### Durability Model

Each `step.run()` provides:

1. **Memoization**: Results are cached; re-execution returns cached value
2. **Independent Retry**: Failed steps retry without re-running completed steps
3. **Parallel Safety**: `Promise.all` with multiple `step.run()` calls execute in parallel

```typescript
// Parallel search - all queries execute concurrently
const searchResults = await Promise.all(
  queries.map((q) =>
    step.run(`search-${hash(q.query)}`, async () => {
      return await searchExa(q.query);
    })
  )
);

// Side effects happen OUTSIDE steps (for proper memoization)
for (const { results } of searchResults) {
  emitProgress(researchId, { type: "source-found", ... });
  accumulated.sources.push(...results);
}
```

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/research/clarify?topic=...` | GET | Generate 3-4 clarification questions |
| `/api/research?researchId=...&topic=...&clarifications=...&depth=...&breadth=...` | GET | Start durable deep research |
| `/api/research/events?researchId=...&cursor=...` | GET | Poll for progress events |

### Query Parameters

**`/api/research`**:
- `researchId` (required): Unique identifier for tracking
- `topic` (required): Research topic
- `clarifications` (optional): JSON object of user answers
- `depth` (optional): Recursion depth (default: 3)
- `breadth` (optional): Queries per level (default: 3)
- `injectFailure` (optional): Step type to fail for demos
- `failureRate` (optional): Failure probability (default: 0.3)

## Technology Stack

- **Runtime**: [Bun](https://bun.sh)
- **Durability**: [Inngest Durable Endpoints](https://www.inngest.com/docs)
- **LLM**: [Vercel AI SDK](https://sdk.vercel.ai/) + Anthropic Claude Sonnet
- **Search**: [Exa API](https://exa.ai/)
- **Frontend**: Next.js 15 + React 19 + TailwindCSS

## Learn More

- [Inngest Documentation](https://www.inngest.com/docs) - Learn about Inngest features
- [Durable Endpoints Guide](https://www.inngest.com/docs/features/inngest-functions/durable-endpoints) - Deep dive into durability
- [Vercel AI SDK](https://sdk.vercel.ai/docs) - AI integration patterns
- [Exa API](https://docs.exa.ai/) - Neural search documentation

## License

MIT
