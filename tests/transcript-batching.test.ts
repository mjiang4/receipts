import assert from "node:assert/strict";
import test from "node:test";
import {
  appendFinalizedTranscript,
  flushIdleSentenceBatch,
  splitFinalizedSentences,
} from "../lib/transcript-batching";

test("one finalized sentence waits for more context", () => {
  const update = appendFinalizedTranscript([], "The launch is Monday.");
  assert.deepEqual(update.batches, []);
  assert.deepEqual(update.pending, ["The launch is Monday."]);
});

test("two sentences flush together after the idle boundary", () => {
  const update = appendFinalizedTranscript(
    ["The launch is Monday."],
    "Maya owns the checklist.",
  );
  assert.deepEqual(update.batches, []);
  const flushed = flushIdleSentenceBatch(update.pending);
  assert.deepEqual(flushed.batch, [
    "The launch is Monday.",
    "Maya owns the checklist.",
  ]);
  assert.deepEqual(flushed.pending, []);
});

test("three sentences become an immediate non-overlapping batch", () => {
  const update = appendFinalizedTranscript(
    [],
    "First fact. Second fact. Third fact.",
  );
  assert.deepEqual(update.batches, [[
    "First fact.",
    "Second fact.",
    "Third fact.",
  ]]);
  assert.deepEqual(update.pending, []);
});

test("five sentences produce a batch of three and an idle batch of two", () => {
  const update = appendFinalizedTranscript(
    [],
    "One. Two. Three. Four. Five.",
  );
  assert.equal(update.batches.length, 1);
  assert.deepEqual(update.batches[0], ["One.", "Two.", "Three."]);
  const flushed = flushIdleSentenceBatch(update.pending);
  assert.deepEqual(flushed.batch, ["Four.", "Five."]);
});

test("an unpunctuated finalized STT turn counts as one sentence", () => {
  assert.deepEqual(splitFinalizedSentences("launch is monday"), [
    "launch is monday",
  ]);
});

test("sentence segmentation keeps decimals inside their sentence", () => {
  assert.deepEqual(
    splitFinalizedSentences("Revenue was 2.5 million. Launch is Friday."),
    ["Revenue was 2.5 million.", "Launch is Friday."],
  );
});
