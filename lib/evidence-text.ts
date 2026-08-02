import { splitFinalizedSentences } from "./transcript-batching";

const DEFAULT_SEGMENT_CHARS = 560;

function splitLongText(value: string, maxChars: number) {
  const words = value.split(/\s+/).filter(Boolean);
  const segments: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      segments.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) segments.push(current);
  return segments;
}

export function segmentEvidenceText(
  value: string,
  maxChars = DEFAULT_SEGMENT_CHARS,
) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const units = splitFinalizedSentences(normalized).flatMap((sentence) =>
    sentence.length > maxChars ? splitLongText(sentence, maxChars) : [sentence],
  );
  const segments: string[] = [];
  let current = "";

  for (const unit of units) {
    const candidate = current ? `${current} ${unit}` : unit;
    if (candidate.length > maxChars && current) {
      segments.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) segments.push(current);
  return segments;
}

export function evidenceExcerpt(
  value: string,
  anchors: Array<string | null | undefined>,
  maxWords = 38,
) {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");

  const normalized = words.join(" ").toLowerCase();
  const anchor = anchors
    .map((item) => item?.trim().toLowerCase())
    .find((item) => item && normalized.includes(item));
  const matchIndex = anchor ? normalized.indexOf(anchor) : 0;
  const wordIndex = normalized.slice(0, matchIndex).split(" ").length - 1;
  const start = Math.max(0, Math.min(words.length - maxWords, wordIndex - 12));
  const excerpt = words.slice(start, start + maxWords).join(" ");
  return `${start > 0 ? "…" : ""}${excerpt}${start + maxWords < words.length ? "…" : ""}`;
}
