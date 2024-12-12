import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

async function getRuns(eventId: string) {
  const response = await fetch(
    process.env.INNGEST_SIGNING_KEY
      ? `https://api.inngest.com/v1/events/${eventId}/runs`
      : `http://localhost:8288/v1/events/${eventId}/runs`,
    {
      ...(process.env.INNGEST_SIGNING_KEY
        ? {
            headers: {
              Authorization: `Bearer ${process.env.INNGEST_SIGNING_KEY}`,
            },
          }
        : {}),
    }
  );
  const json = await response.json();
  return json.data;
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");

  const runs = await getRuns(id as string);
  if (runs[0] && runs[0].output) {
    const run = runs[0];
    console.log("run", JSON.stringify(run, null, 2));
    return NextResponse.json({
      menu: run.output.mealPlan.choices[0].message.content,
    });
  }

  return NextResponse.json({
    menu: null,
  });
}
