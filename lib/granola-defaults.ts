export const DEFAULT_GRANOLA_FOLDER_NAME = "Demo notes";
export const DEFAULT_GRANOLA_NOTE_LIMIT = 10;
export const MAX_DEFAULT_GRANOLA_NOTE_LIMIT = 20;

export type GranolaFolderCandidate = {
  id: string;
  name: string;
  parent_folder_id: string | null;
};

export type GranolaNoteCandidate = {
  id: string;
  created_at: string;
  updated_at: string;
};

export class GranolaDefaultSelectionError extends Error {
  readonly code:
    | "folder_missing"
    | "folder_id_missing"
    | "folder_ambiguous"
    | "invalid_note_date"
    | "invalid_note_limit";

  constructor(
    message: string,
    code: GranolaDefaultSelectionError["code"],
  ) {
    super(message);
    this.name = "GranolaDefaultSelectionError";
    this.code = code;
  }
}

export function resolveGranolaFolder<T extends GranolaFolderCandidate>(
  folders: T[],
  options: { folderName: string; folderId?: string },
): T {
  if (options.folderId) {
    const folder = folders.find((candidate) => candidate.id === options.folderId);
    if (!folder) {
      throw new GranolaDefaultSelectionError(
        "The configured Granola folder ID is not accessible to this API key.",
        "folder_id_missing",
      );
    }
    return folder;
  }

  const expected = options.folderName.trim();
  const exact = folders.filter((folder) => folder.name.trim() === expected);
  const matches = exact.length
    ? exact
    : folders.filter(
        (folder) => folder.name.trim().toLowerCase() === expected.toLowerCase(),
      );

  if (!matches.length) {
    throw new GranolaDefaultSelectionError(
      `Granola folder “${expected}” was not found.`,
      "folder_missing",
    );
  }
  if (matches.length > 1) {
    throw new GranolaDefaultSelectionError(
      `More than one Granola folder is named “${expected}”.`,
      "folder_ambiguous",
    );
  }
  return matches[0];
}

export function selectMostRecentGranolaNotes<T extends GranolaNoteCandidate>(
  notes: T[],
  limit: number,
) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_DEFAULT_GRANOLA_NOTE_LIMIT
  ) {
    throw new GranolaDefaultSelectionError(
      `Granola note limit must be between 1 and ${MAX_DEFAULT_GRANOLA_NOTE_LIMIT}.`,
      "invalid_note_limit",
    );
  }

  const unique = new Map<string, T>();
  const timestamps = new Map<string, { created: number; updated: number }>();

  for (const note of notes) {
    const created = Date.parse(note.created_at);
    const updated = Date.parse(note.updated_at);
    if (!Number.isFinite(created) || !Number.isFinite(updated)) {
      throw new GranolaDefaultSelectionError(
        `Granola note ${note.id} has an invalid timestamp.`,
        "invalid_note_date",
      );
    }

    const previous = timestamps.get(note.id);
    if (
      !previous ||
      created > previous.created ||
      (created === previous.created && updated > previous.updated)
    ) {
      unique.set(note.id, note);
      timestamps.set(note.id, { created, updated });
    }
  }

  return [...unique.values()]
    .sort((left, right) => {
      const leftTimes = timestamps.get(left.id)!;
      const rightTimes = timestamps.get(right.id)!;
      return (
        rightTimes.created - leftTimes.created ||
        rightTimes.updated - leftTimes.updated ||
        left.id.localeCompare(right.id)
      );
    })
    .slice(0, limit);
}
