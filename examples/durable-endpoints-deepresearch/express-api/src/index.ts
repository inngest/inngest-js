/**
 * Bun API server for DeepResearch backend
 *
 * Uses Inngest's Durable Endpoints approach with inngest.endpoint()
 * This allows HTTP handlers to become durable directly using step.run()
 */

import {
  clarifyHandler,
  researchHandler,
  researchEventsHandler,
} from "./routes/research";

const PORT = Number(process.env.PORT) || 4000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Helper to add CORS headers to a response
async function withCors(
  handler: (req: Request) => Promise<Response>,
  req: Request,
): Promise<Response> {
  const response = await handler(req);
  const newHeaders = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => {
    newHeaders.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}

// Start the Bun server with routes
const server = Bun.serve({
  port: PORT,
  idleTimeout: 255,
  routes: {
    // GET /api/research/clarify?topic=...
    // Generate clarification questions for a research topic
    "/api/research/clarify": {
      GET: async (req) => withCors(clarifyHandler, req),
      OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders }),
    },

    // GET /api/research?researchId=...&topic=...&clarifications=...
    // The durable endpoint - client calls this to start deep research
    "/api/research": {
      GET: async (req) => withCors(researchHandler, req),
      OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders }),
    },

    // GET /api/research/events?researchId=...
    // SSE endpoint - client connects to this to receive progress updates
    "/api/research/events": {
      GET: researchEventsHandler,
      OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders }),
    },
  },

  // Fallback for unmatched routes
  fetch(req) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  },
});

console.log(`
  DeepResearch API Server Running (Bun + Durable Endpoints)

  Server URL:      http://localhost:${server.port}

  Endpoints:
    Clarify:       GET /api/research/clarify?topic=...
    Research:      GET /api/research?researchId=...&topic=...&clarifications=...
    SSE Events:    GET /api/research/events?researchId=...

  Runtime:         Bun ${Bun.version}
  CORS:            Enabled (*)

  Flow:
    1. Client calls GET /api/research/clarify?topic=...
    2. Client receives clarification questions
    3. Client generates researchId (UUID)
    4. Client connects to /api/research/events?researchId=...
    5. Client calls GET /api/research?researchId=...&topic=...&clarifications=...
    6. Client receives real-time updates via SSE
`);
