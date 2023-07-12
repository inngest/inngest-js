import { serve } from "inngest/nuxt";
import { inngest, functions } from "~~/inngest";

export default defineEventHandler(serve(inngest, functions));
