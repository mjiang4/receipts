import { env } from "cloudflare:workers";

const GRANOLA_API_BASE_URL = "https://public-api.granola.ai";
const REQUEST_TIMEOUT_MS = 15_000;
const NOTE_ID_PATTERN = /^not_[a-zA-Z0-9]{14}$/;

type RuntimeEnv = {
  GRANOLA_API_KEY?: string;
};

type UnknownRecord = Record<string, unknown>;

export type GranolaNoteListItem = {
  id: string;
  object: "note";
  title: string | null;
  owner: {
    name: string | null;
    email: string | null;
  };
  created_at: string;
  updated_at: string;
};

export type GranolaNoteList = {
  notes: GranolaNoteListItem[];
  hasMore: boolean;
  cursor: string | null;
};

export type NormalizedEvidenceChunk = {
  chunkIndex: number;
  content: string;
  speakerSource: string | null;
  speakerAttribution: string | null;
  speakerLabel: string | null;
  startTime: string | null;
  endTime: string | null;
};

export type NormalizedGranolaNote = {
  externalId: string;
  title: string;
  date: string;
  webUrl: string;
  remoteCreatedAt: string;
  remoteUpdatedAt: string;
  chunks: NormalizedEvidenceChunk[];
};

export class GranolaError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "GranolaError";
    this.code = code;
    this.status = status;
  }
}

export function isGranolaConfigured() {
  return Boolean(readGranolaApiKey());
}

export function isGranolaNoteId(value: string) {
  return NOTE_ID_PATTERN.test(value);
}

export function toGranolaRouteError(error: unknown) {
  if (error instanceof GranolaError) {
    return { error: error.message, code: error.code, status: error.status };
  }

  return {
    error: "An unexpected error occurred while contacting Granola.",
    code: "granola_unexpected_error",
    status: 500,
  };
}

export async function listGranolaNotes(options: {
  pageSize: number;
  cursor?: string;
  folderId?: string;
}): Promise<GranolaNoteList> {
  const searchParams = new URLSearchParams({
    page_size: String(options.pageSize),
  });

  if (options.cursor) {
    searchParams.set("cursor", options.cursor);
  }
  if (options.folderId) {
    searchParams.set("folder_id", options.folderId);
  }

  const payload = await granolaRequest(`/v1/notes?${searchParams.toString()}`);
  const record = requireRecord(payload, "Granola returned an invalid note list.");
  if (!Array.isArray(record.notes) || typeof record.hasMore !== "boolean") {
    throw invalidResponse("Granola returned an invalid note list.");
  }

  const cursor = record.cursor;
  if (cursor !== null && typeof cursor !== "string") {
    throw invalidResponse("Granola returned an invalid pagination cursor.");
  }
  if (record.hasMore && !cursor) {
    throw invalidResponse("Granola omitted the next pagination cursor.");
  }

  return {
    notes: record.notes.map(parseNoteListItem),
    hasMore: record.hasMore,
    cursor,
  };
}

export async function fetchGranolaNotes(
  noteIds: string[],
  concurrency = 4
): Promise<NormalizedGranolaNote[]> {
  const workerCount = Math.max(1, Math.min(concurrency, noteIds.length));
  const results = new Array<NormalizedGranolaNote>(noteIds.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < noteIds.length) {
      const index = nextIndex;
      nextIndex += 1;
      const noteId = noteIds[index];
      const payload = await granolaRequest(
        `/v1/notes/${encodeURIComponent(noteId)}?include=transcript`
      );
      results[index] = normalizeGranolaNote(payload, noteId);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function readGranolaApiKey() {
  const runtimeEnv = env as unknown as RuntimeEnv;
  const value = runtimeEnv.GRANOLA_API_KEY;
  return typeof value === "string" ? value.trim() : "";
}

async function granolaRequest(path: string): Promise<unknown> {
  const apiKey = readGranolaApiKey();
  if (!apiKey) {
    throw new GranolaError(
      "Granola is not configured. Add the GRANOLA_API_KEY server secret.",
      "granola_not_configured",
      503
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${GRANOLA_API_BASE_URL}${path}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw errorForStatus(response.status);
    }

    try {
      return await response.json();
    } catch {
      throw invalidResponse("Granola returned a non-JSON response.");
    }
  } catch (error) {
    if (error instanceof GranolaError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new GranolaError(
        "Granola did not respond before the request timed out.",
        "granola_timeout",
        504
      );
    }
    throw new GranolaError(
      "Receipts could not reach Granola. Try again shortly.",
      "granola_unavailable",
      502
    );
  } finally {
    clearTimeout(timeout);
  }
}

function errorForStatus(status: number) {
  if (status === 401 || status === 403) {
    return new GranolaError(
      "Granola rejected the configured API key. Verify the key and its note access scopes.",
      "granola_auth_failed",
      502
    );
  }
  if (status === 404) {
    return new GranolaError(
      "A selected Granola note was not found or is not fully processed.",
      "granola_note_not_found",
      404
    );
  }
  if (status === 429) {
    return new GranolaError(
      "Granola's rate limit was reached. Try the sync again shortly.",
      "granola_rate_limited",
      503
    );
  }

  return new GranolaError(
    `Granola returned an upstream error (${status}).`,
    "granola_upstream_error",
    502
  );
}

function parseNoteListItem(value: unknown): GranolaNoteListItem {
  const note = requireRecord(value, "Granola returned invalid note metadata.");
  const id = requireString(note.id, "Granola returned a note without an ID.");
  if (!isGranolaNoteId(id)) {
    throw invalidResponse("Granola returned a malformed note ID.");
  }

  const owner = isRecord(note.owner) ? note.owner : {};
  const title = note.title;
  if (title !== null && typeof title !== "string") {
    throw invalidResponse("Granola returned an invalid note title.");
  }

  return {
    id,
    object: "note",
    title,
    owner: {
      name: optionalString(owner.name),
      email: optionalString(owner.email),
    },
    created_at: requireString(
      note.created_at,
      "Granola returned a note without created_at."
    ),
    updated_at: requireString(
      note.updated_at,
      "Granola returned a note without updated_at."
    ),
  };
}

function normalizeGranolaNote(
  value: unknown,
  requestedNoteId: string
): NormalizedGranolaNote {
  const note = requireRecord(value, "Granola returned an invalid note.");
  const externalId = requireString(
    note.id,
    "Granola returned a note without an ID."
  );
  if (externalId !== requestedNoteId || !isGranolaNoteId(externalId)) {
    throw invalidResponse("Granola returned an unexpected note ID.");
  }

  const remoteCreatedAt = requireString(
    note.created_at,
    "Granola returned a note without created_at."
  );
  const remoteUpdatedAt = requireString(
    note.updated_at,
    "Granola returned a note without updated_at."
  );
  const webUrl = requireWebUrl(note.web_url);
  const calendarEvent = isRecord(note.calendar_event)
    ? note.calendar_event
    : null;
  const scheduledStart = calendarEvent
    ? optionalString(calendarEvent.scheduled_start_time)
    : null;

  if (!Array.isArray(note.transcript)) {
    throw invalidResponse(
      "Granola did not include a transcript for a selected note."
    );
  }

  const title = optionalString(note.title)?.trim() || "Untitled Granola note";
  const chunks = note.transcript
    .map(parseTranscriptChunk)
    .filter((chunk): chunk is Omit<NormalizedEvidenceChunk, "chunkIndex"> =>
      Boolean(chunk)
    )
    .map((chunk, chunkIndex) => ({ ...chunk, chunkIndex }));

  return {
    externalId,
    title,
    date: scheduledStart || remoteCreatedAt,
    webUrl,
    remoteCreatedAt,
    remoteUpdatedAt,
    chunks,
  };
}

function parseTranscriptChunk(
  value: unknown
): Omit<NormalizedEvidenceChunk, "chunkIndex"> | null {
  const chunk = requireRecord(
    value,
    "Granola returned an invalid transcript chunk."
  );
  const content = requireString(
    chunk.text,
    "Granola returned a transcript chunk without text."
  ).trim();
  if (!content) {
    return null;
  }

  const speaker = isRecord(chunk.speaker) ? chunk.speaker : {};
  return {
    content,
    speakerSource: optionalString(speaker.source),
    speakerAttribution: optionalString(speaker.attribution),
    speakerLabel: optionalString(speaker.diarization_label),
    startTime: optionalString(chunk.start_time),
    endTime: optionalString(chunk.end_time),
  };
}

function requireWebUrl(value: unknown) {
  const webUrl = requireString(
    value,
    "Granola returned a note without web_url."
  );
  try {
    const url = new URL(webUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Unsupported protocol");
    }
  } catch {
    throw invalidResponse("Granola returned an invalid web_url.");
  }
  return webUrl;
}

function requireRecord(value: unknown, message: string): UnknownRecord {
  if (!isRecord(value)) {
    throw invalidResponse(message);
  }
  return value;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, message: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidResponse(message);
  }
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function invalidResponse(message: string) {
  return new GranolaError(message, "granola_invalid_response", 502);
}
