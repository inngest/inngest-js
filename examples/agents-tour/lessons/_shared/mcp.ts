/** @module Read-only. The tour's MCP server: JSON-RPC over HTTP. */
const docs = [
  "Deploys run from main after CI passes.",
  "On call rotates every Monday at 10:00.",
];

const searchDocs = {
  name: "search_docs",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

type Rpc = {
  id?: number;
  method: string;
  params?: { protocolVersion?: string; arguments?: { query?: string } };
};

export const handleMcp = async (request: Request, token?: string) => {
  if (token && request.headers.get("authorization") !== `Bearer ${token}`) {
    return Response.json({ error: "Wrong token" }, { status: 401 });
  }

  const { id, method, params } = (await request.json()) as Rpc;
  const query = (params?.arguments?.query ?? "").toLowerCase();
  const found = docs.filter((doc) => {
    return doc.toLowerCase().includes(query);
  });
  const result: Record<string, unknown> = {
    initialize: { protocolVersion: params?.protocolVersion, capabilities: {} },
    "tools/list": { tools: [searchDocs] },
    "tools/call": { content: [{ type: "text", text: found.join("\n") }] },
  };

  return id === undefined
    ? new Response(null, { status: 202 })
    : Response.json({ jsonrpc: "2.0", id, result: result[method] });
};
