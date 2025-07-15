import { inngest } from "@/lib/inngest";
import { NextRequest, NextResponse } from "next/server";

// POST /api/contacts - import contacts (triggers Inngest job)
export async function POST(req: NextRequest) {
  // For simplicity, assume JSON body with contacts array (CSV parsing can be added later)
  const data = await req.json();
  // Send event to Inngest
  await inngest.send({
    name: "app/contact.import",
    data,
  });
  return NextResponse.json(
    { success: true, message: "Import job triggered via Inngest" },
    { status: 202 }
  );
}
