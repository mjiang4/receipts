import assert from "node:assert/strict";
import test from "node:test";
import { evidenceExcerpt, segmentEvidenceText } from "../lib/evidence-text";

test("long transcript blocks become retrieval-sized evidence segments", () => {
  const input = Array.from(
    { length: 12 },
    (_, index) => `Sentence ${index + 1} records an important company fact.`,
  ).join(" ");
  const segments = segmentEvidenceText(input, 140);
  assert.ok(segments.length > 1);
  assert.ok(segments.every((segment) => segment.length <= 140));
  assert.match(segments.join(" "), /Sentence 12/);
});

test("evidence excerpts center the corrected fact instead of dumping a note", () => {
  const input = `${"context ".repeat(30)}the team has 14 people ${"followup ".repeat(30)}`;
  const excerpt = evidenceExcerpt(input, ["14 people"], 18);
  assert.match(excerpt, /14 people/);
  assert.ok(excerpt.split(/\s+/).length <= 18);
});
