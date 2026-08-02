export type EvidenceRecord = {
  id: string;
  sourceId: string;
  provider: "granola" | "demo";
  title: string;
  date: string;
  url: string;
  quote: string;
  speaker?: string | null;
  summary?: string | null;
};

export type EvaluationCase = {
  id: string;
  label: string;
  claim: string;
  expected: "speak" | "silent" | "conflict";
  note: string;
};

export const DEMO_EVIDENCE: EvidenceRecord[] = [
  {
    id: "demo-launch-1",
    sourceId: "demo-product-standup",
    provider: "demo",
    title: "Product standup",
    date: "2026-07-28T09:00:00.000Z",
    url: "#demo-product-standup",
    speaker: "Maya",
    summary: "Launch timing and release ownership were finalized.",
    quote:
      "We’re locking the public launch for Friday, August 7. Maya owns the release checklist.",
  },
  {
    id: "demo-renewal-1",
    sourceId: "demo-customer-review",
    provider: "demo",
    title: "Customer success review",
    date: "2026-07-30T16:00:00.000Z",
    url: "#demo-customer-review",
    speaker: "Priya",
    summary: "The renewal amount and next step were confirmed.",
    quote:
      "The Northstar renewal is $120,000, and Priya will send the draft by Thursday.",
  },
  {
    id: "demo-nimbus-1",
    sourceId: "demo-nimbus-debrief",
    provider: "demo",
    title: "Nimbus pilot debrief",
    date: "2026-07-31T11:30:00.000Z",
    url: "#demo-nimbus-debrief",
    speaker: "Jon",
    summary: "Nimbus was still awaiting procurement approval.",
    quote:
      "Nimbus remains in pilot. Procurement has not approved a company-wide rollout.",
  },
  {
    id: "demo-atlas-1",
    sourceId: "demo-atlas-planning",
    provider: "demo",
    title: "Atlas planning",
    date: "2026-07-20T10:00:00.000Z",
    url: "#demo-atlas-planning",
    speaker: "Elena",
    summary: "Early Atlas planning assigned the migration to Sam.",
    quote: "Sam will own the Atlas migration.",
  },
  {
    id: "demo-atlas-2",
    sourceId: "demo-atlas-handoff",
    provider: "demo",
    title: "Atlas handoff",
    date: "2026-07-29T14:00:00.000Z",
    url: "#demo-atlas-handoff",
    speaker: "Elena",
    summary: "A later handoff assigned Atlas jointly to Sam and Noor.",
    quote: "Sam and Noor will jointly own the Atlas migration from here.",
  },
];

export const EVALUATION_CASES: EvaluationCase[] = [
  {
    id: "launch-day",
    label: "Wrong launch day",
    claim: "We agreed to launch on Monday.",
    expected: "speak",
    note: "A material decision is directly contradicted.",
  },
  {
    id: "renewal-number",
    label: "Wrong renewal value",
    claim: "The Northstar renewal is worth $150,000.",
    expected: "speak",
    note: "A material number conflicts with the record.",
  },
  {
    id: "project-status",
    label: "Wrong project status",
    claim: "Nimbus is fully rolled out across the company.",
    expected: "speak",
    note: "The source says the project remains in pilot.",
  },
  {
    id: "supported-owner",
    label: "Supported ownership",
    claim: "Maya owns the release checklist.",
    expected: "silent",
    note: "The claim agrees with the record.",
  },
  {
    id: "opinion",
    label: "Opinion",
    claim: "I think Monday would be a better launch day.",
    expected: "silent",
    note: "Opinions are not factual contradictions.",
  },
  {
    id: "question",
    label: "Question",
    claim: "Did we decide who owns the release checklist?",
    expected: "silent",
    note: "Questions should never trigger an interruption.",
  },
  {
    id: "conflicting-records",
    label: "Conflicting records",
    claim: "Sam is the sole owner of the Atlas migration.",
    expected: "conflict",
    note: "Two relevant records disagree, so Receipts shows uncertainty.",
  },
  {
    id: "vague",
    label: "Vague statement",
    claim: "The customer situation is basically fine.",
    expected: "silent",
    note: "The claim is too vague to verify safely.",
  },
];
