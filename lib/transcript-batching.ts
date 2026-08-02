export type SentenceBatchUpdate = {
  batches: string[][];
  pending: string[];
};

export function splitFinalizedSentences(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    const sentences = Array.from(segmenter.segment(normalized), ({ segment }) =>
      segment.trim(),
    ).filter(Boolean);
    if (sentences.length) return sentences;
  }

  return (
    normalized.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [normalized]
  )
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function appendFinalizedTranscript(
  pending: string[],
  finalizedTranscript: string,
): SentenceBatchUpdate {
  const queue = [
    ...pending,
    ...splitFinalizedSentences(finalizedTranscript),
  ];
  const batches: string[][] = [];

  while (queue.length >= 3) {
    batches.push(queue.splice(0, 3));
  }

  return { batches, pending: queue };
}

export function flushIdleSentenceBatch(pending: string[]) {
  if (pending.length < 2) {
    return { batch: null, pending: [...pending] };
  }

  const size = Math.min(3, pending.length);
  return {
    batch: pending.slice(0, size),
    pending: pending.slice(size),
  };
}
