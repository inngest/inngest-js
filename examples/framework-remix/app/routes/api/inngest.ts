import { serve } from "inngest/remix";
import { inngest, functions } from "~/inngest";

const handler = serve(inngest, functions);

export { handler as loader, handler as action };
