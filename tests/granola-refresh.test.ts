import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Granola notes refresh on page load and follow pagination", async () => {
  const app = await readFile(
    new URL("../app/receipts-app.tsx", import.meta.url),
    "utf8",
  );

  assert.match(app, /initialGranolaRefreshStartedRef/);
  assert.match(app, /void refreshGranola\(\)/);
  assert.match(app, /page_size: String\(GRANOLA_PAGE_SIZE\)/);
  assert.match(app, /query\.set\("cursor", cursor\)/);
  assert.match(app, /cache: "no-store"/);
});
