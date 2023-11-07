import { serve } from "inngest/next";
import { functions, inngest } from "../../inngest";

export default serve({ client: inngest, functions });
