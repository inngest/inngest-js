import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/lib/inngest";
import { db, campaigns } from "@/lib/db";
import { eq } from "drizzle-orm";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const campaignId = Number(params.id);
  if (isNaN(campaignId)) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  }
  // Fetch campaign to get segmentId
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  const { subject, content } = await req.json();
  await inngest.send({
    name: "app/campaign.send",
    data: {
      campaignId: campaign.id,
      segmentId: campaign.segmentId,
      scheduledAt: campaign.scheduledAt || null,
      subject: subject || campaign.subject,
      content: content || campaign.content,
    },
  });
  return NextResponse.json({ success: true });
}
