import { NextResponse } from "next/server";
import { inngest } from "@/lib/inngest";

export async function POST() {
  // Send an event to trigger the simpleSleepFunction
  const { ids } = await inngest.send({
    name: "demo/simple.sleep",
    data: {},
  });
  // Return the run ID (first, since only one function is triggered)
  return NextResponse.json({ eventId: ids[0] });
}
