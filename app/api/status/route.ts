import { count } from "drizzle-orm";
import { getDb } from "@/db";
import { evidenceChunks, knowledgeSources } from "@/db/schema";
import { isGranolaConfigured } from "@/lib/granola";
import { getRuntimeEnv, hasTenstorrentConfiguration } from "@/lib/runtime-env";

export async function GET() {
  const runtime = getRuntimeEnv();
  let knowledgeSourceCount = 0;
  let evidenceChunkCount = 0;
  let databaseReady = false;

  try {
    const db = getDb();
    const [[sources], [chunks]] = await Promise.all([
      db.select({ value: count() }).from(knowledgeSources),
      db.select({ value: count() }).from(evidenceChunks),
    ]);
    knowledgeSourceCount = sources?.value ?? 0;
    evidenceChunkCount = chunks?.value ?? 0;
    databaseReady = true;
  } catch {
    // The app can still rehearse before its private knowledge database is provisioned.
  }

  const inworld = Boolean(runtime.INWORLD_API_KEY?.trim());
  const granola = isGranolaConfigured();
  const tenstorrent = hasTenstorrentConfiguration();
  const live =
    inworld &&
    granola &&
    tenstorrent &&
    databaseReady &&
    evidenceChunkCount > 0;

  return Response.json(
    {
      inworld,
      granola,
      tenstorrent,
      mode: live ? "live" : "rehearsal",
      voiceId: runtime.INWORLD_VOICE_ID?.trim() || "Dennis",
      databaseReady,
      knowledgeSources: knowledgeSourceCount,
      evidenceChunks: evidenceChunkCount,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
