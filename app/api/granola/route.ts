import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { knowledgeSources } from "@/db/schema";
import {
  isGranolaConfigured,
  listGranolaNotes,
  toGranolaRouteError,
} from "@/lib/granola";

const FOLDER_ID_PATTERN = /^fol_[a-zA-Z0-9]{14}$/;
const MAX_CURSOR_LENGTH = 2_048;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const pageSizeResult = parsePageSize(url.searchParams.get("page_size"));
  if (typeof pageSizeResult !== "number") {
    return Response.json(pageSizeResult, { status: 400 });
  }

  const cursorResult = parseCursor(url.searchParams.get("cursor"));
  if (cursorResult.error) {
    return Response.json(cursorResult, { status: 400 });
  }

  const folderResult = parseFolderId(url.searchParams.get("folder_id"));
  if (folderResult.error) {
    return Response.json(folderResult, { status: 400 });
  }

  const configured = isGranolaConfigured();
  if (!configured) {
    return Response.json({
      provider: "granola",
      configured: false,
      notes: [],
      hasMore: false,
      cursor: null,
    });
  }

  try {
    const [result, syncedNoteIds] = await Promise.all([
      listGranolaNotes({
        pageSize: pageSizeResult,
        cursor: cursorResult.value,
        folderId: folderResult.value,
      }),
      readSyncedGranolaNoteIds(),
    ]);

    return Response.json({
      provider: "granola",
      configured: true,
      notes: result.notes.map(({ id, title, created_at, updated_at }) => ({
        id,
        title,
        created_at,
        updated_at,
        synced: syncedNoteIds.has(id),
      })),
      hasMore: result.hasMore,
      cursor: result.cursor,
    });
  } catch (error) {
    const routeError = toGranolaRouteError(error);
    return Response.json(
      {
        provider: "granola",
        configured: true,
        error: routeError.error,
        code: routeError.code,
      },
      { status: routeError.status }
    );
  }
}

async function readSyncedGranolaNoteIds() {
  try {
    const rows = await getDb()
      .select({ externalId: knowledgeSources.externalId })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.provider, "granola"));

    return new Set(
      rows.flatMap(({ externalId }) => (externalId ? [externalId] : [])),
    );
  } catch {
    // Listing Granola notes should still work before D1 is available.
    return new Set<string>();
  }
}

function parsePageSize(value: string | null) {
  if (value === null) {
    return 20;
  }
  if (!/^\d+$/.test(value)) {
    return {
      error: "page_size must be an integer between 1 and 30.",
      code: "invalid_page_size",
    };
  }

  const pageSize = Number(value);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 30) {
    return {
      error: "page_size must be an integer between 1 and 30.",
      code: "invalid_page_size",
    };
  }
  return pageSize;
}

function parseCursor(value: string | null) {
  if (value === null) {
    return { value: undefined };
  }
  if (!value.trim() || value.length > MAX_CURSOR_LENGTH) {
    return {
      error: "cursor must be a non-empty Granola pagination cursor.",
      code: "invalid_cursor",
    };
  }
  return { value };
}

function parseFolderId(value: string | null) {
  if (value === null) {
    return { value: undefined };
  }
  if (!FOLDER_ID_PATTERN.test(value)) {
    return {
      error: "folder_id must be a valid Granola folder ID.",
      code: "invalid_folder_id",
    };
  }
  return { value };
}
