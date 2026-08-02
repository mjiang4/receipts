import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("only the latest three Granola notes replace the active index on page load", async () => {
  const [app, syncRoute] = await Promise.all([
    readFile(new URL("../app/receipts-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/granola/sync/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(app, /initialGranolaRefreshStartedRef/);
  assert.match(app, /void refreshGranola\(\)/);
  assert.match(app, /ACTIVE_GRANOLA_NOTE_COUNT = 3/);
  assert.match(app, /page_size: String\(ACTIVE_GRANOLA_NOTE_COUNT\)/);
  assert.match(app, /replaceExisting: true/);
  assert.match(app, /cache: "no-store"/);
  assert.match(syncRoute, /notInArray\(knowledgeSources\.externalId/);
  assert.match(syncRoute, /MAX_REPLACEMENT_NOTES = 3/);
});
