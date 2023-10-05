import { serve } from "inngest/remix";
import { functions, inngest } from "~/inngest";

const handler = serve({ client: inngest, functions });

export { handler as action, handler as loader };
