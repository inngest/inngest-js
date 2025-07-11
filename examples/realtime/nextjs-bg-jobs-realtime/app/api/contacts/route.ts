import { NextRequest, NextResponse } from "next/server";
import { db, contacts } from "@/lib/db";
import { inngest } from "@/lib/inngest";

// GET /api/contacts - list contacts (placeholder)
export async function GET() {
  // TODO: Replace with real DB query
  const allContacts = [
    {
      id: 1,
      firstname: "Alice",
      lastname: "Smith",
      position: "CEO",
      company: "Acme",
      industry: "Tech",
      createdAt: new Date(),
    },
  ];
  return NextResponse.json(allContacts);
}

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
