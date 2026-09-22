import { serve } from "../../dist/cloudflare.js";
import { runPlatformSmoke } from "./scenario.mjs";

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") return new Response("ready");
    if (pathname !== "/smoke")
      return new Response("Not found", { status: 404 });
    try {
      // Run within an actual workerd request context, using the native Workers
      // adapter and the real environment bindings received by this fetch entry.
      const result = await runPlatformSmoke((options) => {
        const handler = serve(options);
        return (executionRequest) => handler(executionRequest, env);
      });
      return Response.json({ runtime: "workerd", ...result });
    } catch (error) {
      return Response.json(
        { ok: false, error: String(error), stack: error?.stack },
        { status: 500 },
      );
    }
  },
};
