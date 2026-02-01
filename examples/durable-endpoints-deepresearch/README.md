# DeepResearch - Inngest Durable Endpoints Demo

AI-powered deep research tool showcasing Inngest's Durable Endpoints approach - bringing durability to API endpoints without requiring queues or background jobs.

## Features

- **Deep Recursive Search**: Performs 3 levels of recursive search, finding subtopics and exploring each
- **Clarification Questions**: AI-generated questions to refine research focus before starting
- **Real-time Progress**: Live updates via SSE showing sources found and reasoning
- **Durable Execution**: Each search step is persisted and can survive crashes/restarts
- **Live Code Highlighting**: See which code is executing in real-time

## Architecture

```
durable-endpoints-deepresearch/
├── express-api/              # Bun backend with Durable Endpoints
│   └── src/
│       ├── index.ts          # Server setup
│       └── routes/
│           └── research.ts   # Durable research handlers
└── next-app/                 # Next.js frontend
    └── src/app/
        └── page.tsx          # Main UI
```

## Technology Stack

- **Backend**: Bun + Inngest Durable Endpoints (`inngest.endpoint()`)
- **LLM**: Vercel AI SDK with Anthropic Claude Sonnet
- **Search**: Exa API for web search
- **Frontend**: Next.js 15 + React 19 + TailwindCSS

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) installed
- [Node.js](https://nodejs.org) 20+ installed
- Anthropic API key
- Exa API key

### Setup

1. **Clone and navigate to the example:**

   ```bash
   cd examples/durable-endpoints-deepresearch
   ```

2. **Set up the backend:**

   ```bash
   cd express-api
   bun install

   # Create .env file
   echo "EXA_API_KEY=your_exa_api_key" > .env
   echo "ANTHROPIC_API_KEY=your_anthropic_api_key" >> .env
   ```

3. **Set up the frontend:**
   ```bash
   cd ../next-app
   npm install
   ```

### Running

1. **Start the backend (port 4000):**

   ```bash
   cd express-api
   bun run dev
   ```

2. **Start the frontend (port 3000):**

   ```bash
   cd next-app
   npm run dev
   ```

3. **Open http://localhost:3000**

## How It Works

### Research Flow

1. **Topic Input**: User enters a research topic
2. **Clarification**: LLM generates 3-4 questions to refine the research focus
3. **Query Generation**: Creates initial search queries based on topic and answers
4. **Recursive Search** (3 levels deep):
   - Search with Exa API
   - Extract learnings and follow-up questions
   - Recursively search follow-ups
5. **Report Generation**: Synthesizes findings into a comprehensive report

### Durable Steps

Each major operation is wrapped in `step.run()` for durability:

```typescript
// Generate search queries (durable step)
const queries = await step.run("generate-queries", async () => {
  return await generateSearchQueries(topic, clarifications, breadth);
});

// Each search is a durable step
const results = await step.run(`search-d${depth}-${hash(query)}`, async () => {
  return await searchExa(query);
});

// Extract learnings (durable step)
const learnings = await step.run(`learn-d${depth}-${hash(query)}`, async () => {
  return await extractLearnings(topic, query, results);
});
```

### Progress Events

The backend emits real-time events via SSE:

- `search-start`: New search query starting
- `source-found`: New source discovered
- `learning-extracted`: Insight extracted from sources
- `depth-complete`: One level of recursion complete
- `report-generating`: Final report being generated
- `complete`: Research finished

## API Endpoints

| Endpoint                                                    | Method | Description                      |
| ----------------------------------------------------------- | ------ | -------------------------------- |
| `/api/research/clarify?topic=...`                           | GET    | Generate clarification questions |
| `/api/research?researchId=...&topic=...&clarifications=...` | GET    | Start deep research (durable)    |
| `/api/research/events?researchId=...`                       | GET    | SSE stream for progress updates  |

> **Note**: Durable Endpoints currently require GET requests. The `clarifications` parameter is a JSON-encoded object.

## Environment Variables

### express-api/.env

```
EXA_API_KEY=your_exa_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
```

### next-app/.env.local (optional)

```
NEXT_PUBLIC_BUN_API_URL=http://localhost:4000
```

## License

MIT
