import { NextRequest, NextResponse } from "next/server";
import { db, segments, contactSegments } from "@/lib/db";
import { desc, sql } from "drizzle-orm";

// GET /api/segments - list last 5 segments or all if ?all=1
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const all = searchParams.get("all") === "1";
  const query = db
    .select({
      id: segments.id,
      name: segments.name,
      description: segments.description,
      createdAt: segments.createdAt,
      contactCount: sql`(
        SELECT COUNT(*) FROM contact_segments WHERE contact_segments.segment_id = segments.id
      )`.as("contactCount"),
    })
    .from(segments)
    .orderBy(desc(segments.createdAt));
  if (!all) {
    query.limit(5);
  }
  const allSegments = await query;
  return NextResponse.json(allSegments);
}

// POST /api/segments - create segment (placeholder)
export async function POST(req: NextRequest) {
  // TODO: Insert into DB
  return NextResponse.json(
    { success: true, message: "Segment created (placeholder)" },
    { status: 201 }
  );
}
