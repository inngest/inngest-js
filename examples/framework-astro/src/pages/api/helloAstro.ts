import { inngest } from "../../inngest/client";

export async function GET() {
  // Send your event payload to Inngest
  await inngest.send({
    name: "demo/hello.world",
    data: {
      message: "Hello, Houston!",
      email: "testToHouston@example.com",
    },
  });

  return Response.json({ name: "Hello Houston from Inngest!" });
}
