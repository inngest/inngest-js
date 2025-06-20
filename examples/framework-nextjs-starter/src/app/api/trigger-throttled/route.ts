import { NextResponse } from "next/server";
import { inngest } from "@/lib/inngest";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST() {
  for (let i = 0; i < 10; i++) {
    await inngest.send({
      name: "demo/throttled.function",
      data: {},
    });
    await sleep(200);
  }
  // Return the event ID
  return NextResponse.json({ ok: true });
}
