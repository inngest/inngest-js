import jwt from "jsonwebtoken";
import { NextRequest, NextResponse } from "next/server";

const REALTIME_JWT_SECRET = "dev-mode-is-not-secret";
const ACCOUNT_ID = "00000000-0000-4000-a000-000000000000";
const ENV_ID = "00000000-0000-4000-b000-000000000000";

export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get("runId");
  if (!runId) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);

  const token = jwt.sign(
    {
      iss: "rt.inngest.com",
      sub: ACCOUNT_ID,
      exp: now + 60,
      iat: now,
      env: ENV_ID,
      topics: [
        {
          kind: "run",
          env_id: ENV_ID,
          channel: runId,
          name: "$stream",
        },
      ],
      publish: false,
    },
    REALTIME_JWT_SECRET,
    { algorithm: "HS256" }
  );

  return NextResponse.json({ token });
}
