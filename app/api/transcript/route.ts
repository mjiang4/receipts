import { getDb } from "@/db";
import { meetingSessions, utterances } from "@/db/schema";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ error: "Invalid transcript payload." }, { status: 400 });
  }
  const { sessionId, text } = payload as Record<string, unknown>;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    return Response.json({ error: "Invalid meeting session." }, { status: 400 });
  }
  if (typeof text !== "string" || !text.trim() || text.length > 2_000) {
    return Response.json({ error: "Transcript text is required." }, { status: 400 });
  }

  try {
    const db = getDb();
    await db
      .insert(meetingSessions)
      .values({ id: sessionId })
      .onConflictDoNothing({ target: meetingSessions.id });
    await db.insert(utterances).values({
      sessionId,
      content: text.trim(),
      capturedAt: new Date().toISOString(),
    });
    return Response.json({ stored: true }, { status: 201 });
  } catch {
    return Response.json(
      { error: "The private transcript store is unavailable." },
      { status: 503 },
    );
  }
}
