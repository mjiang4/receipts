import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evidenceExcerpt } from "../lib/evidence-text";

test("receipt evidence is reduced to a short supporting excerpt", () => {
  const note = Array.from({ length: 80 }, (_, index) =>
    index === 44 ? "the team has fourteen people" : `word${index}`,
  ).join(" ");
  const excerpt = evidenceExcerpt(note, ["fourteen people"]);

  assert.ok(excerpt.split(/\s+/).length <= 38);
  assert.match(excerpt, /fourteen people/);
  assert.notEqual(excerpt, note);
});

test("the client uses the server-side Inworld route instead of the missing websocket", async () => {
  const [app, voiceRoute] = await Promise.all([
    readFile(new URL("../app/receipts-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/voice/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(app, /fetch\("\/api\/voice"/);
  assert.doesNotMatch(app, /\/api\/inworld\/tts/);
  assert.match(voiceRoute, /api\.inworld\.ai\/tts\/v1\/voice/);
  assert.match(voiceRoute, /modelId: "inworld-tts-2"/);
  assert.match(voiceRoute, /Authorization: `Basic/);
});
