import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEMO_EVIDENCE } from "../lib/demo-corpus";
import {
  isCheckableClaim,
  rankEvidence,
  runEvaluationSuite,
  runRehearsalJudge,
} from "../lib/judge-core";

test("the shipped surface is Receipts, not the starter", async () => {
  const [page, layout, app, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/receipts-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  const shipped = `${page}\n${layout}\n${app}\n${styles}`;
  assert.match(shipped, /Receipts/);
  assert.match(shipped, /Your meetings,/);
  assert.match(shipped, /Enter the demo room/);
  assert.match(shipped, /Inworld voice/);
  assert.match(shipped, /Tenstorrent Judge/);
  assert.match(shipped, /Granola memory/);
  assert.doesNotMatch(shipped, /codex-preview|Your site is taking shape|SkeletonPreview/i);
});

test("evaluation suite covers speak, silence, and conflict", () => {
  const suite = runEvaluationSuite();
  assert.equal(suite.total, 8);
  assert.equal(suite.passed, suite.total);
  assert.ok(suite.results.some((item) => item.expected === "speak"));
  assert.ok(suite.results.some((item) => item.expected === "silent"));
  assert.ok(suite.results.some((item) => item.expected === "conflict"));
});

test("rehearsal Judge creates a brief source-backed Ahem interruption", () => {
  const decision = runRehearsalJudge("We agreed to launch on Monday.");
  assert.equal(decision.action, "speak");
  assert.match(decision.correction ?? "", /^Ahem\s*[—-]/);
  assert.match(decision.correction ?? "", /based on/i);
  assert.ok((decision.correction ?? "").split(/\s+/).length <= 34);
  assert.equal(decision.evidence.length, 1);
  assert.match(decision.evidence[0].quote, /Friday, August 7/);
});

test("opinions and questions remain silent", () => {
  assert.equal(
    runRehearsalJudge("I think Monday would be a better launch day.").action,
    "silent",
  );
  assert.equal(
    runRehearsalJudge("Did we choose a launch day?").action,
    "silent",
  );
  assert.equal(isCheckableClaim("Did we choose a launch day?"), false);
});

test("conflicting records never produce spoken certainty", () => {
  const decision = runRehearsalJudge(
    "Sam is the sole owner of the Atlas migration.",
  );
  assert.equal(decision.action, "conflict");
  assert.equal(decision.correction, null);
  assert.equal(decision.evidence.length, 2);
});

test("retrieval ranks the relevant source ahead of unrelated records", () => {
  const ranked = rankEvidence(
    "The Northstar renewal is $150,000.",
    DEMO_EVIDENCE,
    3,
  );
  assert.equal(ranked[0]?.sourceId, "demo-customer-review");
});
