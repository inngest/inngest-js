import express from "express";
import { serve } from "../../packages/inngest/src/express.ts";
import { functions, inngest } from "./inngest";

const app = express();

app.use(
  express.json({
    limit: "5mb",
  }),
);

app.use("/api/inngest", serve({ client: inngest, functions }));

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
