import { NextRequest, NextResponse } from "next/server";
import { db, segments, contactSegments, contacts } from "@/lib/db";
import { eq } from "drizzle-orm";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const segmentId = Number(params.id);
  if (isNaN(segmentId)) {
    return NextResponse.json({ error: "Invalid segment id" }, { status: 400 });
  }
  const [segment] = await db
    .select()
    .from(segments)
    .where(eq(segments.id, segmentId));
  if (!segment) {
    return NextResponse.json({ error: "Segment not found" }, { status: 404 });
  }
  const segmentContacts = await db
    .select()
    .from(contacts)
    .innerJoin(contactSegments, eq(contactSegments.contactId, contacts.id))
    .where(eq(contactSegments.segmentId, segmentId));
  // Flatten join result
  const contactsList = segmentContacts.map((row: any) => row.contacts);
  return NextResponse.json({ segment, contacts: contactsList });
}
