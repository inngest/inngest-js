/**
 * @module
 * Read-only. The tour's MCP server: JSON-RPC over HTTP, one tool.
 */
const docs = [
  "Deploys run from main after CI passes.",
  "Rollbacks: revert the PR, then deploy again.",
  "On call rotates every Monday at 10:00.",
  "CI runs the tests and the linter on every push.",
  "Reviews need one approval before a merge.",
];

const searchDocs = {
  name: "search_docs",
  description: "Searches the team's docs",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "A word to find" } },
    required: ["query"],
  },
};

type Rpc = {
  id?: number;
  method: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: { query?: string };
  };
};

export const handleMcp = async (request: Request, token?: string) => {
  if (token && request.headers.get("authorization") !== `Bearer ${token}`) {
    return Response.json({ error: "Wrong token" }, { status: 401 });
  }

  const { id, method, params } = (await request.json()) as Rpc;
  const answer = (body: object) => {
    return Response.json({ jsonrpc: "2.0", id, ...body });
  };

  if (id === undefined) {
    return new Response(null, { status: 202 });
  }

  if (method === "initialize") {
    const { protocolVersion } = params ?? {};

    return answer({
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "team-docs", version: "1" },
      },
    });
  }

  if (method === "tools/list") {
    return answer({ result: { tools: [searchDocs] } });
  }

  if (method === "tools/call" && params?.name === "search_docs") {
    const query = (params.arguments?.query ?? "").toLowerCase();
    const found = docs.filter((doc) => {
      return doc.toLowerCase().includes(query);
    });

    return answer({
      result: { content: [{ type: "text", text: found.join("\n") }] },
    });
  }

  return answer({ error: { code: -32601, message: `Unknown: ${method}` } });
};
