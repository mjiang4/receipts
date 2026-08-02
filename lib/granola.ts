import { env } from "cloudflare:workers";
import {
  DEFAULT_GRANOLA_FOLDER_NAME,
  DEFAULT_GRANOLA_NOTE_LIMIT,
  GranolaDefaultSelectionError,
  MAX_DEFAULT_GRANOLA_NOTE_LIMIT,
  resolveGranolaFolder,
  selectMostRecentGranolaNotes,
} from "./granola-defaults";

const GRANOLA_API_BASE_URL = "https://public-api.granola.ai";
const REQUEST_TIMEOUT_MS = 15_000;
const GRANOLA_PAGE_SIZE = 30;
const MAX_PAGINATION_PAGES = 20;
const MIN_REQUEST_INTERVAL_MS = 210;
const NOTE_ID_PATTERN = /^not_[a-zA-Z0-9]{14}$/;
const FOLDER_ID_PATTERN = /^fol_[a-zA-Z0-9]{14}$/;
let nextGranolaRequestAt = 0;

type RuntimeEnv = {
  GRANOLA_API_KEY?: string;
  GRANOLA_DEFAULT_FOLDER_ID?: string;
  GRANOLA_DEFAULT_FOLDER_NAME?: string;
  GRANOLA_DEFAULT_NOTE_LIMIT?: string;
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

export type GranolaFolderListItem = {
  id: string;
  object: "folder";
  name: string;
  parent_folder_id: string | null;
};

export type GranolaFolderList = {
  folders: GranolaFolderListItem[];
  hasMore: boolean;
  cursor: string | null;
};

export type DefaultGranolaSelection = {
  folder: GranolaFolderListItem;
  notes: GranolaNoteListItem[];
  limit: number;
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

export function isGranolaFolderId(value: string) {
  return FOLDER_ID_PATTERN.test(value);
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

export async function listGranolaFolders(options: {
  pageSize: number;
  cursor?: string;
}): Promise<GranolaFolderList> {
  const searchParams = new URLSearchParams({
    page_size: String(options.pageSize),
  });
  if (options.cursor) {
    searchParams.set("cursor", options.cursor);
  }

  const payload = await granolaRequest(`/v1/folders?${searchParams.toString()}`);
  const record = requireRecord(payload, "Granola returned an invalid folder list.");
  if (!Array.isArray(record.folders) || typeof record.hasMore !== "boolean") {
    throw invalidResponse("Granola returned an invalid folder list.");
  }

  const cursor = record.cursor;
  if (cursor !== null && typeof cursor !== "string") {
    throw invalidResponse("Granola returned an invalid folder pagination cursor.");
  }
  if (record.hasMore && !cursor) {
    throw invalidResponse("Granola omitted the next folder pagination cursor.");
  }

  return {
    folders: record.folders.map(parseFolderListItem),
    hasMore: record.hasMore,
    cursor,
  };
}

export async function listDefaultGranolaNotes(): Promise<DefaultGranolaSelection> {
  const config = readDefaultGranolaConfig();
  const folders = await listAllGranolaFolders(config.folderId);

  let folder: GranolaFolderListItem;
  try {
    folder = resolveGranolaFolder(folders, config);
  } catch (error) {
    throw defaultSelectionError(error, config.folderName);
  }

  const notes = await listAllGranolaNotes(folder.id);
  try {
    return {
      folder,
      notes: selectMostRecentGranolaNotes(notes, config.limit),
      limit: config.limit,
    };
  } catch (error) {
    throw defaultSelectionError(error, folder.name);
  }
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

function readDefaultGranolaConfig() {
  const runtimeEnv = env as unknown as RuntimeEnv;
  const folderName =
    runtimeEnv.GRANOLA_DEFAULT_FOLDER_NAME?.trim() ||
    DEFAULT_GRANOLA_FOLDER_NAME;
  const folderId = runtimeEnv.GRANOLA_DEFAULT_FOLDER_ID?.trim() || undefined;
  const rawLimit = runtimeEnv.GRANOLA_DEFAULT_NOTE_LIMIT?.trim();
  const limit = rawLimit ? Number(rawLimit) : DEFAULT_GRANOLA_NOTE_LIMIT;

  if (folderId && !isGranolaFolderId(folderId)) {
    throw new GranolaError(
      "GRANOLA_DEFAULT_FOLDER_ID is not a valid Granola folder ID.",
      "granola_default_folder_invalid",
      503,
    );
  }
  if (!folderName || folderName.length > 120) {
    throw new GranolaError(
      "GRANOLA_DEFAULT_FOLDER_NAME must contain between 1 and 120 characters.",
      "granola_default_folder_invalid",
      503,
    );
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_DEFAULT_GRANOLA_NOTE_LIMIT
  ) {
    throw new GranolaError(
      `GRANOLA_DEFAULT_NOTE_LIMIT must be between 1 and ${MAX_DEFAULT_GRANOLA_NOTE_LIMIT}.`,
      "granola_default_limit_invalid",
      503,
    );
  }

  return { folderName, folderId, limit };
}

async function listAllGranolaFolders(stopAtFolderId?: string) {
  const folders: GranolaFolderListItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
    const result = await listGranolaFolders({
      pageSize: GRANOLA_PAGE_SIZE,
      cursor,
    });
    folders.push(...result.folders);
    if (
      stopAtFolderId &&
      result.folders.some((folder) => folder.id === stopAtFolderId)
    ) {
      return folders;
    }
    if (!result.hasMore) return folders;

    const nextCursor = result.cursor!;
    if (seenCursors.has(nextCursor)) {
      throw invalidResponse("Granola repeated a folder pagination cursor.");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new GranolaError(
    "The Granola folder list is too large to resolve safely.",
    "granola_pagination_limit",
    502,
  );
}

async function listAllGranolaNotes(folderId: string) {
  const notes: GranolaNoteListItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
    const result = await listGranolaNotes({
      pageSize: GRANOLA_PAGE_SIZE,
      folderId,
      cursor,
    });
    notes.push(...result.notes);
    if (!result.hasMore) return notes;

    const nextCursor = result.cursor!;
    if (seenCursors.has(nextCursor)) {
      throw invalidResponse("Granola repeated a note pagination cursor.");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new GranolaError(
    "The default Granola folder is too large to load safely.",
    "granola_pagination_limit",
    502,
  );
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
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await waitForGranolaRateSlot();
      const response = await fetch(`${GRANOLA_API_BASE_URL}${path}`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      });

      if (response.status === 429 && attempt === 0) {
        await waitForGranolaRetry(response.headers.get("Retry-After"));
        continue;
      }

      if (!response.ok) {
        throw errorForStatus(response.status);
      }

      try {
        return await response.json();
      } catch {
        throw invalidResponse("Granola returned a non-JSON response.");
      }
    }
    throw errorForStatus(429);
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

async function waitForGranolaRateSlot() {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextGranolaRequestAt);
  nextGranolaRequestAt = scheduledAt + MIN_REQUEST_INTERVAL_MS;
  if (scheduledAt > now) {
    await new Promise((resolve) => setTimeout(resolve, scheduledAt - now));
  }
}

async function waitForGranolaRetry(value: string | null) {
  const seconds = value ? Number(value) : Number.NaN;
  const parsedDate = value ? Date.parse(value) : Number.NaN;
  const requestedDelay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Number.isFinite(parsedDate)
      ? parsedDate - Date.now()
      : 1_000;
  const delay = Math.max(250, Math.min(3_000, requestedDelay));
  await new Promise((resolve) => setTimeout(resolve, delay));
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

function parseFolderListItem(value: unknown): GranolaFolderListItem {
  const folder = requireRecord(value, "Granola returned invalid folder metadata.");
  const id = requireString(folder.id, "Granola returned a folder without an ID.");
  if (!isGranolaFolderId(id)) {
    throw invalidResponse("Granola returned a malformed folder ID.");
  }
  const name = requireString(
    folder.name,
    "Granola returned a folder without a name.",
  );
  const parentFolderId = folder.parent_folder_id;
  if (
    parentFolderId !== null &&
    (typeof parentFolderId !== "string" || !isGranolaFolderId(parentFolderId))
  ) {
    throw invalidResponse("Granola returned an invalid parent folder ID.");
  }

  return {
    id,
    object: "folder",
    name,
    parent_folder_id: parentFolderId,
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

function defaultSelectionError(error: unknown, folderName: string) {
  if (!(error instanceof GranolaDefaultSelectionError)) {
    return error;
  }

  if (error.code === "folder_missing") {
    return new GranolaError(
      `Receipts could not find an accessible Granola folder named “${folderName}”. Create it in Granola or share it with this API key.`,
      "granola_default_folder_not_found",
      404,
    );
  }
  if (error.code === "folder_id_missing") {
    return new GranolaError(
      "The configured Granola default folder ID is not accessible to this API key. Check GRANOLA_DEFAULT_FOLDER_ID and its sharing permissions.",
      "granola_default_folder_id_not_found",
      404,
    );
  }
  if (error.code === "folder_ambiguous") {
    return new GranolaError(
      `More than one accessible Granola folder is named “${folderName}”. Set GRANOLA_DEFAULT_FOLDER_ID to choose one.`,
      "granola_default_folder_ambiguous",
      409,
    );
  }
  return invalidResponse(error.message);
}
