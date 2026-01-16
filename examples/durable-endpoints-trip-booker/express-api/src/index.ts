/**
 * Bun API server for trip booking backend
 *
 * Uses Inngest's Durable Endpoints approach with createExperimentalEndpointWrapper()
 * This allows HTTP handlers to become durable directly using step.run()
 */

import { bookingHandler, bookingEventsHandler } from "./routes/bookings";

const PORT = Number(process.env.PORT) || 4000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Start the Bun server with routes
const server = Bun.serve({
  port: PORT,
  routes: {
    // GET /api/booking?bookingId=...&origin=...&destination=...&date=...
    // The durable endpoint - client calls this to start the booking
    "/api/booking": {
      GET: async (req) => {
        const response = await bookingHandler(req);
        const newHeaders = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => {
          newHeaders.set(key, value);
        });
        return new Response(response.body, {
          status: response.status,
          headers: newHeaders,
        });
      },
      OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders }),
    },

    // GET /api/booking/events?bookingId=...
    // SSE endpoint - client connects to this to receive progress updates
    "/api/booking/events": {
      GET: bookingEventsHandler,
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
🚀 Trip Booking API Server Running (Bun + Durable Endpoints)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Server URL:      http://localhost:${server.port}

  Endpoints:
    Durable:       GET /api/booking?bookingId=...&origin=...&destination=...&date=...
    SSE Events:    GET /api/booking/events?bookingId=...

  Runtime:         Bun ${Bun.version}
  CORS:            Enabled (*)

  Flow:
    1. Client generates bookingId (UUID)
    2. Client connects to /api/booking/events?bookingId=...
    3. Client calls /api/booking?bookingId=...&origin=...
    4. Client receives real-time updates via SSE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
