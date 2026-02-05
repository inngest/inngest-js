import type { Inngest } from "./Inngest.ts";

/**
 * Context extracted from a durable endpoint proxy request.
 */
export interface DurableEndpointProxyContext {
  /**
   * The run ID from the query parameters.
   */
  runId: string | null;

  /**
   * The token from the query parameters.
   */
  token: string | null;

  /**
   * The HTTP method of the request.
   */
  method: string;
}

/**
 * The result of processing a durable endpoint proxy request.
 */
export interface DurableEndpointProxyResult {
  /**
   * HTTP status code.
   */
  status: number;

  /**
   * HTTP headers to include in the response.
   */
  headers: Record<string, string>;

  /**
   * Response body as a string.
   */
  body: string;
}

/**
 * Default CORS headers for durable endpoint proxy responses.
 */
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Helper to create a JSON response with CORS headers.
 */
const jsonResponse = (
  status: number,
  body: unknown,
): DurableEndpointProxyResult => ({
  status,
  headers: { "Content-Type": "application/json", ...corsHeaders },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/**
 * Helper to create an error response.
 */
const errorResponse = (
  status: number,
  message: string,
): DurableEndpointProxyResult => jsonResponse(status, { error: message });

/**
 * Core durable endpoint proxy logic - framework-agnostic.
 *
 * This function handles the common logic for durable endpoint proxy handlers:
 * - CORS preflight handling
 * - Parameter validation
 * - Fetching results from Inngest API
 * - Decrypting results via middleware (if configured)
 *
 * Framework adapters wrap this with their specific Request/Response types.
 *
 * @param client - The Inngest client to use for API requests and decryption
 * @param ctx - The request context containing runId, token, and method
 * @returns A DurableEndpointProxyResult with status, headers, and body
 */
export async function handleDurableEndpointProxyRequest(
  client: Inngest.Any,
  ctx: DurableEndpointProxyContext,
): Promise<DurableEndpointProxyResult> {
  // Handle CORS preflight
  if (ctx.method === "OPTIONS") {
    return {
      status: 204,
      headers: { ...corsHeaders, "Access-Control-Max-Age": "86400" },
      body: "",
    };
  }

  const { runId, token } = ctx;

  if (!runId || !token) {
    return errorResponse(400, "Missing runId or token query parameter");
  }

  try {
    const response = await client["inngestApi"].getRunOutput(runId, token);

    if (!response.ok) {
      return jsonResponse(response.status, await response.text());
    }

    let body = await response.json();
    body = await client["decryptProxyResult"](body);

    return jsonResponse(200, body);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch run output";
    return errorResponse(500, message);
  }
}
