import { and, count, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  evidenceChunks,
  knowledgeSources,
} from "@/db/schema";
import {
  fetchGranolaNotes,
  isGranolaConfigured,
  isGranolaNoteId,
  listDefaultGranolaNotes,
  type GranolaNoteListItem,
  type NormalizedGranolaNote,
  toGranolaRouteError,
} from "@/lib/granola";

const MAX_SELECTED_NOTES = 20;
const FETCH_CONCURRENCY = 4;
const CHUNK_INSERT_BATCH_SIZE = 50;
const GRANOLA_SYNC_LEASE_KEY = "granola-default-sync";
const SYNC_LEASE_MS = 120_000;

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

  const requestResult = parseSyncRequest(payload);
  if ("error" in requestResult) {
    return Response.json(requestResult, { status: 400 });
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

  let leaseToken: string | null;
  try {
    leaseToken = await acquireSyncLease(db);
  } catch (error) {
    return databaseErrorResponse(error);
  }
  if (!leaseToken) {
    return Response.json(
      {
        error: "Another Receipts tab is already refreshing Granola. Try again in a moment.",
        code: "granola_sync_in_progress",
      },
      { status: 409 },
    );
  }

  try {
    let selectedNotes: GranolaNoteListItem[] | null = null;
    let defaultFolder: { id: string; name: string } | null = null;
    let effectiveLimit: number | null = null;
    let noteIds = requestResult.mode === "manual" ? requestResult.noteIds : [];

  try {
    if (requestResult.mode === "default") {
      const selection = await listDefaultGranolaNotes();
      selectedNotes = selection.notes;
      defaultFolder = {
        id: selection.folder.id,
        name: selection.folder.name,
      };
      effectiveLimit = selection.limit;
      noteIds = selectedNotes.map((note) => note.id);
    }
  } catch (error) {
    const routeError = toGranolaRouteError(error);
    return Response.json(
      { error: routeError.error, code: routeError.code },
      { status: routeError.status }
    );
  }

  if (requestResult.mode === "default" && selectedNotes?.length === 0) {
    try {
      await replaceActiveCorpus(db, []);
    } catch (error) {
      return databaseErrorResponse(error);
    }
    return Response.json({
      provider: "granola",
      folder: defaultFolder,
      limit: effectiveLimit,
      selected_count: 0,
      synced_count: 0,
      updated_count: 0,
      unchanged_count: 0,
      notes: [],
      synced: [],
    });
  }

  let existing = new Map<
    string,
    {
      remoteUpdatedAt: string;
      chunkCount: number;
      actualChunkCount: number;
    }
  >();
  if (requestResult.mode === "default") {
    try {
      const rows = await db
        .select({
          externalId: knowledgeSources.externalId,
          remoteUpdatedAt: knowledgeSources.remoteUpdatedAt,
          chunkCount: knowledgeSources.chunkCount,
          actualChunkCount: count(evidenceChunks.id),
        })
        .from(knowledgeSources)
        .leftJoin(
          evidenceChunks,
          eq(knowledgeSources.id, evidenceChunks.sourceId),
        )
        .where(
          and(
            eq(knowledgeSources.provider, "granola"),
            inArray(knowledgeSources.externalId, noteIds),
          ),
        )
        .groupBy(knowledgeSources.id);
      existing = new Map(
        rows.map((row) => [
          row.externalId,
          {
            remoteUpdatedAt: row.remoteUpdatedAt,
            chunkCount: row.chunkCount,
            actualChunkCount: row.actualChunkCount,
          },
        ]),
      );
    } catch (error) {
      return databaseErrorResponse(error);
    }
  }

  const noteIdsToFetch =
    requestResult.mode === "default"
      ? selectedNotes!
          .filter((note) => {
            const stored = existing.get(note.id);
            return (
              !stored ||
              stored.remoteUpdatedAt !== note.updated_at ||
              stored.chunkCount === 0 ||
              stored.actualChunkCount !== stored.chunkCount
            );
          })
          .map((note) => note.id)
      : noteIds;

  let notes: NormalizedGranolaNote[];
  try {
    notes = noteIdsToFetch.length
      ? await fetchGranolaNotes(noteIdsToFetch, FETCH_CONCURRENCY)
      : [];
  } catch (error) {
    const routeError = toGranolaRouteError(error);
    return Response.json(
      { error: routeError.error, code: routeError.code },
      { status: routeError.status },
    );
  }

  try {
    const synced = [];

    for (const note of notes) {
      const sourceId = await ensureSource(db, note);
      await replaceEvidenceChunks(db, sourceId, note);
      synced.push({
        id: note.externalId,
        title: note.title,
        date: note.date,
        web_url: note.webUrl,
        chunk_count: note.chunks.length,
      });
    }

    const sourceIds = noteIds.length
      ? await findSourceIds(db, noteIds)
      : [];
    if (sourceIds.length !== noteIds.length) {
      throw new Error("Receipts could not resolve every synced Granola source.");
    }
    if (requestResult.mode === "default") {
      await replaceActiveCorpus(db, sourceIds);
    } else {
      await activateSources(db, sourceIds);
    }

    return Response.json({
      provider: "granola",
      folder: defaultFolder,
      limit: effectiveLimit,
      selected_count: noteIds.length,
      synced_count:
        requestResult.mode === "default" ? noteIds.length : synced.length,
      updated_count: synced.length,
      unchanged_count:
        requestResult.mode === "default" ? noteIds.length - synced.length : 0,
      notes:
        selectedNotes?.map(({ id, title, created_at, updated_at }) => ({
          id,
          title,
          created_at,
          updated_at,
        })) ?? [],
      synced,
    });
  } catch (error) {
    return databaseErrorResponse(error);
  }
  } finally {
    await releaseSyncLease(db, leaseToken);
  }
}

function parseSyncRequest(payload: unknown):
  | { mode: "default" }
  | { mode: "manual"; noteIds: string[] }
  | { error: string; code: string } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {
      error: "Request body must be an object with a noteIds array.",
      code: "invalid_request",
    };
  }

  const record = payload as Record<string, unknown>;
  if (record.useDefaultFolder === true) {
    return { mode: "default" };
  }

  const noteIds = record.noteIds;
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

  return { mode: "manual", noteIds: normalized };
}

async function ensureSource(
  db: ReturnType<typeof getDb>,
  note: NormalizedGranolaNote,
) {
  const [existing] = await db
    .select({ id: knowledgeSources.id })
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.provider, "granola"),
        eq(knowledgeSources.externalId, note.externalId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  await db
    .insert(knowledgeSources)
    .values({
      provider: "granola",
      externalId: note.externalId,
      title: note.title,
      sourceDate: note.date,
      webUrl: note.webUrl,
      remoteCreatedAt: note.remoteCreatedAt,
      remoteUpdatedAt: note.remoteUpdatedAt,
      chunkCount: 0,
      syncedAt: new Date().toISOString(),
    })
    .onConflictDoNothing();

  const [source] = await db
    .select({ id: knowledgeSources.id })
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.provider, "granola"),
        eq(knowledgeSources.externalId, note.externalId),
      ),
    )
    .limit(1);
  if (!source) {
    throw new Error("D1 did not return the synced knowledge source.");
  }
  return source.id;
}

async function replaceEvidenceChunks(
  db: ReturnType<typeof getDb>,
  sourceId: number,
  note: NormalizedGranolaNote,
) {
  const d1 = db.$client;
  const statements = [
    d1
      .prepare("DELETE FROM evidence_chunks WHERE source_id = ?")
      .bind(sourceId),
  ];

  for (
    let offset = 0;
    offset < note.chunks.length;
    offset += CHUNK_INSERT_BATCH_SIZE
  ) {
    const chunks = note.chunks.slice(offset, offset + CHUNK_INSERT_BATCH_SIZE);
    const placeholders = chunks.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const values = chunks.flatMap((chunk) => [
      sourceId,
      chunk.chunkIndex,
      chunk.content,
      chunk.speakerSource,
      chunk.speakerAttribution,
      chunk.speakerLabel,
      chunk.startTime,
      chunk.endTime,
    ]);
    statements.push(
      d1
        .prepare(
          `INSERT INTO evidence_chunks (
            source_id, chunk_index, content, speaker_source,
            speaker_attribution, speaker_label, start_time, end_time
          ) VALUES ${placeholders}`,
        )
        .bind(...values),
    );
  }

  statements.push(
    d1
      .prepare(
        `UPDATE knowledge_sources
         SET title = ?, source_date = ?, web_url = ?, remote_created_at = ?,
             remote_updated_at = ?, chunk_count = ?, synced_at = ?
         WHERE id = ?`,
      )
      .bind(
        note.title,
        note.date,
        note.webUrl,
        note.remoteCreatedAt,
        note.remoteUpdatedAt,
        note.chunks.length,
        new Date().toISOString(),
        sourceId,
      ),
  );

  await d1.batch(statements);
}

async function findSourceIds(
  db: ReturnType<typeof getDb>,
  noteIds: string[],
) {
  const rows = await db
    .select({
      id: knowledgeSources.id,
      externalId: knowledgeSources.externalId,
    })
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.provider, "granola"),
        inArray(knowledgeSources.externalId, noteIds),
      ),
    );
  const byExternalId = new Map(rows.map((row) => [row.externalId, row.id]));
  return noteIds
    .map((noteId) => byExternalId.get(noteId))
    .filter((sourceId): sourceId is number => typeof sourceId === "number");
}

async function replaceActiveCorpus(
  db: ReturnType<typeof getDb>,
  sourceIds: number[],
) {
  const d1 = db.$client;
  const statements = [d1.prepare("DELETE FROM active_knowledge_sources")];
  if (sourceIds.length) {
    const placeholders = sourceIds.map(() => "(?, CURRENT_TIMESTAMP)").join(", ");
    statements.push(
      d1
        .prepare(
          `INSERT INTO active_knowledge_sources (source_id, activated_at)
           VALUES ${placeholders}`,
        )
        .bind(...sourceIds),
    );
  }
  await d1.batch(statements);
}

async function activateSources(
  db: ReturnType<typeof getDb>,
  sourceIds: number[],
) {
  if (!sourceIds.length) return;
  const d1 = db.$client;
  const placeholders = sourceIds.map(() => "(?, CURRENT_TIMESTAMP)").join(", ");
  await d1
    .prepare(
      `INSERT INTO active_knowledge_sources (source_id, activated_at)
       VALUES ${placeholders}
       ON CONFLICT(source_id) DO UPDATE SET activated_at = excluded.activated_at`,
    )
    .bind(...sourceIds)
    .run();
}

async function acquireSyncLease(db: ReturnType<typeof getDb>) {
  const token = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SYNC_LEASE_MS).toISOString();
  const row = await db.$client
    .prepare(
      `INSERT INTO sync_leases (key, token, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         token = excluded.token,
         expires_at = excluded.expires_at
       WHERE sync_leases.expires_at <= ?
       RETURNING token`,
    )
    .bind(
      GRANOLA_SYNC_LEASE_KEY,
      token,
      expiresAt,
      now.toISOString(),
    )
    .first<{ token: string }>();
  return row?.token === token ? token : null;
}

async function releaseSyncLease(
  db: ReturnType<typeof getDb>,
  token: string,
) {
  try {
    await db.$client
      .prepare("DELETE FROM sync_leases WHERE key = ? AND token = ?")
      .bind(GRANOLA_SYNC_LEASE_KEY, token)
      .run();
  } catch {
    // The lease expires automatically if cleanup encounters a transient failure.
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
    combined.includes("active_knowledge_sources") ||
    combined.includes("sync_leases") ||
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
