import express from "express";
import { serve } from "../../../packages/inngest/src/express";

import { inngest } from "./client";
import * as functions from "./fns";

const port = Number(process.env.PORT || "3939");

const app = express();

app.use(express.json({ limit: "10mb" }));

const handler = serve({
  client: inngest,
  functions: Object.values(functions) as any,
});

app.use("/api/inngest", handler);

app.listen(port, () => {
  console.log(`server started on 0.0.0.0:${port}`);
});
