import { serve } from "inngest/nuxt";
import { functions, inngest } from "~~/inngest";

export default defineEventHandler(serve({ client: inngest, functions }));
