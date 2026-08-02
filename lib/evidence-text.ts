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
