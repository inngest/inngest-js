import express from "express";
import { inngest } from "./inngest/client";
import { serve } from "inngest/express";
import { retrieveTextFile } from "./inngest/functions";
const app = express();

// Important:  ensure you add JSON middleware to process incoming JSON POST payloads.
app.use(express.json());
app.use(
  // Expose the middleware on our recommended path at `/api/inngest`.
  "/api/inngest",
  serve({ client: inngest, functions: [retrieveTextFile] })
);

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
