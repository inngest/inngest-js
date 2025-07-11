import { NextRequest, NextResponse } from "next/server";
import { db, campaigns } from "@/lib/db";
import { desc } from "drizzle-orm";
// import { inngest } from "@/lib/inngest";

// GET /api/campaigns - list last 5 campaigns
export async function GET() {
  const allCampaigns = await db
    .select()
    .from(campaigns)
    .orderBy(desc(campaigns.createdAt))
    .limit(5);
  return NextResponse.json(allCampaigns);
}

// POST /api/campaigns - create campaign and return it (do not send)
export async function POST(req: NextRequest) {
  const data = await req.json();
  // Validate required fields
  if (
    !data.name ||
    !data.subject ||
    !data.content ||
    !data.segmentId ||
    !data.status
  ) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }
  // Insert into DB
  const [newCampaign] = await db
    .insert(campaigns)
    .values({
      name: data.name,
      subject: data.subject,
      content: data.content,
      segmentId: data.segmentId,
      status: data.status,
      scheduledAt: data.scheduledAt || null,
    })
    .returning();

  // Do not send campaign yet
  return NextResponse.json(newCampaign, { status: 201 });
}
