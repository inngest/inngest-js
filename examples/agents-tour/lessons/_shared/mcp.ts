/** @module Read-only. The tour's MCP server: JSON-RPC over HTTP. */
const docs = [
  "Deploys run from main after CI passes.",
  "On call rotates every Monday at 10:00.",
];

const tools = [
  {
    name: "search_docs",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

export const handleMcp = async (request: Request, token?: string) => {
  if (token && request.headers.get("authorization") !== `Bearer ${token}`) {
    return Response.json({ error: "Missing or wrong token" }, { status: 401 });
  }

  const { id, method, params } = await request.json();
  const text = (params?.arguments?.query ?? "").toLowerCase();
  const found = docs.filter((doc) => doc.toLowerCase().includes(text));
  const results: Record<string, unknown> = {
    initialize: {
      protocolVersion: params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "team-docs", version: "1" },
    },
    "tools/list": { tools },
    "tools/call": { content: [{ type: "text", text: found.join("\n") }] },
  };

  return id === undefined
    ? new Response(null, { status: 202 })
    : Response.json({ jsonrpc: "2.0", id, result: results[method] });
};
