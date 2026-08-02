import {
  DEMO_EVIDENCE,
  EVALUATION_CASES,
  type EvidenceRecord,
} from "./demo-corpus";

export type JudgeAction = "speak" | "silent" | "conflict";

export type JudgeDecision = {
  action: JudgeAction;
  claim: string;
  correction: string | null;
  confidence: number;
  materiality: number;
  reason: string;
  evidence: EvidenceRecord[];
  incorrectSpan?: string | null;
  correctFact?: string | null;
  evidenceExcerpt?: string | null;
  mode: "tenstorrent" | "rehearsal" | "safety-fallback";
};

const STOP_WORDS = new Set([
  "a",
  "about",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "this",
  "to",
  "was",
  "we",
  "were",
  "will",
  "with",
]);

export function normalizeClaim(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9$%]+/g, " ")
    .trim();
}

export function tokenize(value: string) {
  return normalizeClaim(value)
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function isCheckableClaim(claim: string) {
  const normalized = normalizeClaim(claim);
  if (!normalized || /\?$/.test(claim.trim())) return false;
  if (/^(i think|i feel|maybe|perhaps|what if|in my opinion)\b/.test(normalized)) {
    return false;
  }

  return (
    /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/.test(normalized) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(
      normalized,
    ) ||
    /(?:\$|\b)\d[\d,.]*(?:k|m|%| percent)?\b/.test(normalized) ||
    /\b(agreed|decided|deadline|launch|owns?|owner|committed|renewal|approved|pilot|rolled out|rollout|status|due|ship|signed)\b/.test(
      normalized,
    )
  );
}

export function scoreEvidence(claim: string, evidence: EvidenceRecord) {
  const claimTokens = new Set(tokenize(claim));
  const evidenceTokens = new Set(
    tokenize(`${evidence.title} ${evidence.summary ?? ""} ${evidence.quote}`),
  );
  let overlap = 0;
  for (const token of claimTokens) {
    if (evidenceTokens.has(token)) overlap += /\d/.test(token) ? 1.5 : 1;
  }

  const phraseBoost = [...claimTokens].some(
    (token) => token.length > 4 && evidence.quote.toLowerCase().includes(token),
  )
    ? 1.5
    : 0;
  return overlap + phraseBoost;
}

export function rankEvidence(
  claim: string,
  evidence: EvidenceRecord[],
  limit = 8,
) {
  return evidence
    .map((item) => ({ item, score: scoreEvidence(claim, item) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item }) => item);
}

export function rankEvidenceForStatements(
  statements: string[],
  evidence: EvidenceRecord[],
  perStatement = 4,
  limit = 10,
) {
  const ranked: EvidenceRecord[] = [];
  const seen = new Set<string>();

  const add = (item: EvidenceRecord) => {
    if (seen.has(item.id) || ranked.length >= limit) return;
    seen.add(item.id);
    ranked.push(item);
  };

  for (const statement of statements) {
    rankEvidence(statement, evidence, perStatement).forEach(add);
  }
  rankEvidence(statements.join(" "), evidence, limit).forEach(add);

  return ranked.slice(0, limit);
}

function rehearsalDecision(claim: string): JudgeDecision {
  const normalized = normalizeClaim(claim);
  const silent = (reason: string): JudgeDecision => ({
    action: "silent",
    claim,
    correction: null,
    confidence: 1,
    materiality: 0,
    reason,
    evidence: [],
    mode: "rehearsal",
  });

  if (!isCheckableClaim(claim)) return silent("Not a specific checkable claim.");

  if (/\blaunch\b/.test(normalized) && /\bmonday\b/.test(normalized)) {
    return {
      action: "speak",
      claim,
      correction:
        "Ahem — based on the July 28 product standup, the launch was agreed for Friday, not Monday.",
      confidence: 0.99,
      materiality: 0.96,
      reason: "The recorded launch day directly contradicts the claim.",
      evidence: [DEMO_EVIDENCE[0]],
      mode: "rehearsal",
    };
  }

  if (
    /\bnorthstar\b/.test(normalized) &&
    /(?:150[ ,]?000|150k)/.test(normalized)
  ) {
    return {
      action: "speak",
      claim,
      correction:
        "Ahem — based on the July 30 customer review, the Northstar renewal is $120,000, not $150,000.",
      confidence: 0.99,
      materiality: 0.98,
      reason: "The recorded renewal value directly contradicts the claim.",
      evidence: [DEMO_EVIDENCE[1]],
      mode: "rehearsal",
    };
  }

  if (
    /\bnimbus\b/.test(normalized) &&
    /(fully|company wide|companywide|rolled out|rollout)/.test(normalized)
  ) {
    return {
      action: "speak",
      claim,
      correction:
        "Ahem — based on the July 31 Nimbus debrief, Nimbus is still in pilot and procurement has not approved a company-wide rollout.",
      confidence: 0.97,
      materiality: 0.92,
      reason: "The latest project status directly contradicts the claim.",
      evidence: [DEMO_EVIDENCE[2]],
      mode: "rehearsal",
    };
  }

  if (
    /\batlas\b/.test(normalized) &&
    /\b(sam|sole|only)\b/.test(normalized)
  ) {
    return {
      action: "conflict",
      claim,
      correction: null,
      confidence: 0.94,
      materiality: 0.82,
      reason: "Relevant records assign ownership differently.",
      evidence: [DEMO_EVIDENCE[3], DEMO_EVIDENCE[4]],
      mode: "rehearsal",
    };
  }

  return silent("No direct, material contradiction was found.");
}

export function runRehearsalJudge(claim: string) {
  return rehearsalDecision(claim);
}

export function runEvaluationSuite() {
  const results = EVALUATION_CASES.map((testCase) => {
    const decision = rehearsalDecision(testCase.claim);
    return {
      ...testCase,
      actual: decision.action,
      passed: decision.action === testCase.expected,
      correction: decision.correction,
    };
  });

  return {
    passed: results.filter((result) => result.passed).length,
    total: results.length,
    results,
  };
}

export function safeFallback(claim: string, reason: string): JudgeDecision {
  return {
    action: "silent",
    claim,
    correction: null,
    confidence: 0,
    materiality: 0,
    reason,
    evidence: [],
    mode: "safety-fallback",
  };
}
