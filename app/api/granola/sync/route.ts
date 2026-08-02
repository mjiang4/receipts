import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { evidenceChunks, knowledgeSources } from "@/db/schema";
import {
  fetchGranolaNotes,
  isGranolaConfigured,
  isGranolaNoteId,
  type NormalizedGranolaNote,
  toGranolaRouteError,
} from "@/lib/granola";

const MAX_SELECTED_NOTES = 20;
const FETCH_CONCURRENCY = 4;
const CHUNK_INSERT_BATCH_SIZE = 10;

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON.", code: "invalid_json" },
      { status: 400 }
    );
  }

  const noteIdsResult = parseNoteIds(payload);
  if ("error" in noteIdsResult) {
    return Response.json(noteIdsResult, { status: 400 });
  }

  if (!isGranolaConfigured()) {
    return Response.json(
      {
        error: "Granola is not configured. Add the GRANOLA_API_KEY server secret.",
        code: "granola_not_configured",
      },
      { status: 503 }
    );
  }

  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return databaseErrorResponse();
  }

  let notes: NormalizedGranolaNote[];
  try {
    notes = await fetchGranolaNotes(
      noteIdsResult.noteIds,
      FETCH_CONCURRENCY
    );
  } catch (error) {
    const routeError = toGranolaRouteError(error);
    return Response.json(
      { error: routeError.error, code: routeError.code },
      { status: routeError.status }
    );
  }

  try {
    const synced = [];

    for (const note of notes) {
      const sourceId = await upsertSource(db, note);
      await replaceEvidenceChunks(db, sourceId, note);
      synced.push({
        id: note.externalId,
        title: note.title,
        date: note.date,
        web_url: note.webUrl,
        chunk_count: note.chunks.length,
      });
    }

    return Response.json({
      provider: "granola",
      synced_count: synced.length,
      synced,
    });
  } catch (error) {
    return databaseErrorResponse(error);
  }
}

function parseNoteIds(payload: unknown):
  | { noteIds: string[] }
  | { error: string; code: string } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {
      error: "Request body must be an object with a noteIds array.",
      code: "invalid_request",
    };
  }

  const noteIds = (payload as Record<string, unknown>).noteIds;
  if (!Array.isArray(noteIds)) {
    return {
      error: "noteIds must be an array of Granola note IDs.",
      code: "invalid_note_ids",
    };
  }
  if (noteIds.length < 1 || noteIds.length > MAX_SELECTED_NOTES) {
    return {
      error: `Select between 1 and ${MAX_SELECTED_NOTES} Granola notes.`,
      code: "invalid_note_count",
    };
  }

  const normalized = noteIds.map((noteId) =>
    typeof noteId === "string" ? noteId.trim() : ""
  );
  if (normalized.some((noteId) => !isGranolaNoteId(noteId))) {
    return {
      error: "Every noteIds entry must be a valid Granola note ID.",
      code: "invalid_note_id",
    };
  }
  if (new Set(normalized).size !== normalized.length) {
    return {
      error: "noteIds must not contain duplicates.",
      code: "duplicate_note_id",
    };
  }

  return { noteIds: normalized };
}

async function upsertSource(
  db: ReturnType<typeof getDb>,
  note: NormalizedGranolaNote
) {
  const syncedAt = new Date().toISOString();
  const [source] = await db
    .insert(knowledgeSources)
    .values({
      provider: "granola",
      externalId: note.externalId,
      title: note.title,
      sourceDate: note.date,
      webUrl: note.webUrl,
      remoteCreatedAt: note.remoteCreatedAt,
      remoteUpdatedAt: note.remoteUpdatedAt,
      chunkCount: note.chunks.length,
      syncedAt,
    })
    .onConflictDoUpdate({
      target: [knowledgeSources.provider, knowledgeSources.externalId],
      set: {
        title: note.title,
        sourceDate: note.date,
        webUrl: note.webUrl,
        remoteCreatedAt: note.remoteCreatedAt,
        remoteUpdatedAt: note.remoteUpdatedAt,
        chunkCount: note.chunks.length,
        syncedAt,
      },
    })
    .returning({ id: knowledgeSources.id });

  if (!source) {
    throw new Error("D1 did not return the synced knowledge source.");
  }
  return source.id;
}

async function replaceEvidenceChunks(
  db: ReturnType<typeof getDb>,
  sourceId: number,
  note: NormalizedGranolaNote
) {
  await db.delete(evidenceChunks).where(eq(evidenceChunks.sourceId, sourceId));

  for (
    let offset = 0;
    offset < note.chunks.length;
    offset += CHUNK_INSERT_BATCH_SIZE
  ) {
    const chunks = note.chunks.slice(offset, offset + CHUNK_INSERT_BATCH_SIZE);
    await db.insert(evidenceChunks).values(
      chunks.map((chunk) => ({
        sourceId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        speakerSource: chunk.speakerSource,
        speakerAttribution: chunk.speakerAttribution,
        speakerLabel: chunk.speakerLabel,
        startTime: chunk.startTime,
        endTime: chunk.endTime,
      }))
    );
  }
}

function databaseErrorResponse(error?: unknown) {
  const message = error instanceof Error ? error.message : "";
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : "";
  const combined = `${message}\n${cause}`;
  const unavailable =
    error === undefined ||
    combined.includes("no such table") ||
    combined.includes("knowledge_sources") ||
    combined.includes("evidence_chunks") ||
    combined.includes("D1 binding `DB`");

  return Response.json(
    {
      error: unavailable
        ? "The knowledge database is unavailable. Configure the D1 DB binding and apply the generated Drizzle migration."
        : "Receipts could not store the selected Granola notes in the knowledge database.",
      code: unavailable
        ? "knowledge_database_unavailable"
        : "knowledge_database_write_failed",
    },
    { status: unavailable ? 503 : 500 }
  );
}
