import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import {
  evidenceChunks,
  judgeReceipts,
  knowledgeSources,
  meetingSessions,
} from "@/db/schema";
import type { EvidenceRecord } from "@/lib/demo-corpus";
import { segmentEvidenceText } from "@/lib/evidence-text";
import {
  normalizeClaim,
  rankEvidenceForStatements,
  runRehearsalJudge,
  safeFallback,
  type JudgeDecision,
} from "@/lib/judge-core";
import { hasTenstorrentConfiguration } from "@/lib/runtime-env";
import { factCheckWithTenstorrent } from "@/lib/tenstorrent";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEDUPE_WINDOW_MS = 45_000;

type JudgeRequest = {
  sessionId: string;
  claim: string;
  sentences: string[];
  utterances: string[];
  manual: boolean;
  demoOnly: boolean;
};

function parseRequest(value: unknown): JudgeRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sessionId = record.sessionId;
  const claim = record.claim;
  const sentences = record.sentences;
  const utterances = record.utterances;
  if (
    typeof sessionId !== "string" ||
    !SESSION_ID.test(sessionId) ||
    typeof claim !== "string" ||
    !claim.trim() ||
    claim.length > 6_000 ||
    !Array.isArray(sentences) ||
    sentences.length < 1 ||
    sentences.length > 5 ||
    !sentences.every(
      (item) => typeof item === "string" && item.trim() && item.length <= 6_000,
    ) ||
    !Array.isArray(utterances) ||
    utterances.length > 5 ||
    !utterances.every((item) => typeof item === "string" && item.length <= 2_000)
  ) {
    return null;
  }
  return {
    sessionId,
    claim: claim.trim(),
    sentences: sentences.map((item) => item.trim()),
    utterances: utterances.map((item) => item.trim()).filter(Boolean),
    manual: record.manual === true,
    demoOnly: record.demoOnly === true,
  };
}

async function loadEvidence(): Promise<EvidenceRecord[]> {
  const db = getDb();
  const rows = await db
    .select({
      chunkId: evidenceChunks.id,
      sourceExternalId: knowledgeSources.externalId,
      title: knowledgeSources.title,
      sourceDate: knowledgeSources.sourceDate,
      webUrl: knowledgeSources.webUrl,
      content: evidenceChunks.content,
      speakerAttribution: evidenceChunks.speakerAttribution,
      speakerLabel: evidenceChunks.speakerLabel,
      speakerSource: evidenceChunks.speakerSource,
    })
    .from(evidenceChunks)
    .innerJoin(knowledgeSources, eq(evidenceChunks.sourceId, knowledgeSources.id))
    .limit(1_500);

  return rows.flatMap((row) =>
    segmentEvidenceText(row.content).map((quote, segmentIndex) => ({
      id: `granola-${row.chunkId}-${segmentIndex}`,
      sourceId: row.sourceExternalId,
      provider: "granola" as const,
      title: row.title,
      date: row.sourceDate,
      url: row.webUrl,
      quote,
      speaker:
        row.speakerLabel ?? row.speakerAttribution ?? row.speakerSource ?? null,
    })),
  );
}

async function recentlyChecked(sessionId: string, claim: string) {
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
    const [match] = await db
      .select({ id: judgeReceipts.id })
      .from(judgeReceipts)
      .where(
        and(
          eq(judgeReceipts.sessionId, sessionId),
          eq(judgeReceipts.normalizedClaim, normalizeClaim(claim)),
          gt(judgeReceipts.createdAt, cutoff),
        ),
      )
      .limit(1);
    return Boolean(match);
  } catch {
    return false;
  }
}

async function persistReceipt(sessionId: string, decision: JudgeDecision) {
  if (decision.action === "silent") return;
  try {
    const db = getDb();
    await db
      .insert(meetingSessions)
      .values({ id: sessionId })
      .onConflictDoNothing({ target: meetingSessions.id });
    await db.insert(judgeReceipts).values({
      id: crypto.randomUUID(),
      sessionId,
      normalizedClaim: normalizeClaim(decision.claim),
      action: decision.action,
      correction: decision.correction,
      confidencePermille: Math.round(decision.confidence * 1_000),
      evidenceJson: JSON.stringify(
        decision.evidence.map((item) => ({
          sourceId: item.sourceId,
          quote: item.quote,
          title: item.title,
          date: item.date,
          url: item.url,
        })),
      ),
      createdAt: new Date().toISOString(),
    });
  } catch {
    // A correction can still be delivered if persistence has a transient failure.
  }
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = parseRequest(payload);
  if (!parsed) {
    return Response.json({ error: "Invalid fact-check request." }, { status: 400 });
  }

  if (!parsed.manual && (await recentlyChecked(parsed.sessionId, parsed.claim))) {
    return Response.json(safeFallback(parsed.claim, "Duplicate claim in cooldown."));
  }

  if (parsed.demoOnly || !hasTenstorrentConfiguration()) {
    const decision = runRehearsalJudge(parsed.claim);
    await persistReceipt(parsed.sessionId, decision);
    return Response.json(decision);
  }

  let evidence: EvidenceRecord[];
  try {
    evidence = rankEvidenceForStatements(
      parsed.sentences,
      await loadEvidence(),
      4,
      10,
    );
  } catch {
    return Response.json(
      safeFallback(parsed.claim, "The knowledge index is unavailable."),
    );
  }
  if (!evidence.length) {
    return Response.json(safeFallback(parsed.claim, "No relevant evidence found."));
  }

  let decision: JudgeDecision;
  try {
    decision = await factCheckWithTenstorrent({
      claim: parsed.claim,
      sentences: parsed.sentences,
      recentUtterances: parsed.utterances,
      evidence,
    });
  } catch {
    decision = safeFallback(
      parsed.claim,
      "The fact-checker stayed silent after a provider error.",
    );
  }
  await persistReceipt(parsed.sessionId, decision);
  return Response.json(decision);
}
