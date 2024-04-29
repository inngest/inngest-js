import { Hono } from "hono";
import { serve } from "inngest/hono";
import { functions, inngest } from "./inngest";

export type Env = {
	INNGEST_SIGNING_KEY?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.on(["GET", "PUT", "POST"], "/api/inngest", (c) => {
	const handler = serve({
		client: inngest,
		functions,
		signingKey: c.env.INNGEST_SIGNING_KEY,
	});
	return handler(c);
});

export default app;
