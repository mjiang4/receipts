import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  GranolaDefaultSelectionError,
  resolveGranolaFolder,
  selectMostRecentGranolaNotes,
} from "../lib/granola-defaults";

const folders = [
  {
    id: "fol_00000000000001",
    name: "demo notes",
    parent_folder_id: null,
  },
  {
    id: "fol_00000000000002",
    name: "Customer calls",
    parent_folder_id: null,
  },
];

function note(index: number, createdAt: string, updatedAt = createdAt) {
  return {
    id: `not_${String(index).padStart(14, "0")}`,
    title: `Note ${index}`,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

test("the default folder resolves by name without case sensitivity", () => {
  const result = resolveGranolaFolder(folders, { folderName: "Demo Notes" });
  assert.equal(result.id, "fol_00000000000001");
});

test("an explicit folder ID overrides the default name", () => {
  const result = resolveGranolaFolder(folders, {
    folderName: "missing",
    folderId: "fol_00000000000002",
  });
  assert.equal(result.name, "Customer calls");
  assert.throws(
    () =>
      resolveGranolaFolder(folders, {
        folderName: "demo notes",
        folderId: "fol_99999999999999",
      }),
    (error) =>
      error instanceof GranolaDefaultSelectionError &&
      error.code === "folder_id_missing",
  );
});

test("missing and ambiguous default folders fail instead of guessing", () => {
  assert.throws(
    () => resolveGranolaFolder(folders, { folderName: "Missing" }),
    (error) =>
      error instanceof GranolaDefaultSelectionError &&
      error.code === "folder_missing",
  );
  assert.throws(
    () =>
      resolveGranolaFolder([...folders, { ...folders[0] }], {
        folderName: "demo notes",
      }),
    (error) =>
      error instanceof GranolaDefaultSelectionError &&
      error.code === "folder_ambiguous",
  );
});

test("the newest ten notes are selected from an unsorted full folder", () => {
  const notes = Array.from({ length: 12 }, (_, index) =>
    note(index + 1, new Date(Date.UTC(2026, 0, index + 1)).toISOString()),
  ).reverse();
  const selected = selectMostRecentGranolaNotes(
    [notes[5], ...notes.slice(0, 5), ...notes.slice(6)],
    10,
  );

  assert.equal(selected.length, 10);
  assert.deepEqual(
    selected.map((item) => item.title),
    [
      "Note 12",
      "Note 11",
      "Note 10",
      "Note 9",
      "Note 8",
      "Note 7",
      "Note 6",
      "Note 5",
      "Note 4",
      "Note 3",
    ],
  );
});

test("duplicate note IDs are de-duplicated using their newest metadata", () => {
  const selected = selectMostRecentGranolaNotes(
    [
      note(1, "2026-01-01T00:00:00.000Z"),
      note(1, "2026-02-01T00:00:00.000Z"),
      note(2, "2026-01-15T00:00:00.000Z"),
    ],
    10,
  );
  assert.deepEqual(
    selected.map((item) => item.id),
    ["not_00000000000001", "not_00000000000002"],
  );
  assert.equal(selected[0].created_at, "2026-02-01T00:00:00.000Z");
});

test("invalid dates and unsafe limits fail closed", () => {
  assert.throws(
    () => selectMostRecentGranolaNotes([note(1, "not-a-date")], 10),
    (error) =>
      error instanceof GranolaDefaultSelectionError &&
      error.code === "invalid_note_date",
  );
  assert.throws(
    () => selectMostRecentGranolaNotes([], 21),
    (error) =>
      error instanceof GranolaDefaultSelectionError &&
      error.code === "invalid_note_limit",
  );
});

test("the client automatically invokes the default-folder sync route", async () => {
  const [app, route, granola] = await Promise.all([
    readFile(new URL("../app/receipts-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/granola/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/granola.ts", import.meta.url), "utf8"),
  ]);
  assert.match(app, /useDefaultFolder:\s*true/);
  assert.match(app, /granolaNoteLimit/);
  assert.match(app, /Refresh latest/);
  assert.match(route, /listDefaultGranolaNotes/);
  assert.match(route, /replaceActiveCorpus/);
  assert.match(granola, /listAllGranolaNotes/);
  assert.match(granola, /selectMostRecentGranolaNotes/);
});

test("fact checking and status only use the active Granola corpus", async () => {
  const [schema, judge, status, sync] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/judge/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/status/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/granola/sync/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /active_knowledge_sources/);
  assert.match(judge, /innerJoin\(\s*activeKnowledgeSources/);
  assert.match(status, /from\(activeKnowledgeSources\)/);
  assert.match(sync, /DELETE FROM active_knowledge_sources/);
  assert.match(sync, /d1\.batch\(statements\)/);
});
