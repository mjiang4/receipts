import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const knowledgeSources = sqliteTable(
  "knowledge_sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    sourceDate: text("source_date").notNull(),
    webUrl: text("web_url").notNull(),
    remoteCreatedAt: text("remote_created_at").notNull(),
    remoteUpdatedAt: text("remote_updated_at").notNull(),
    chunkCount: integer("chunk_count").notNull().default(0),
    syncedAt: text("synced_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("knowledge_sources_provider_external_id_unique").on(
      table.provider,
      table.externalId
    ),
    index("knowledge_sources_provider_date_idx").on(
      table.provider,
      table.sourceDate
    ),
    index("knowledge_sources_remote_updated_at_idx").on(table.remoteUpdatedAt),
  ]
);

export const evidenceChunks = sqliteTable(
  "evidence_chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    speakerSource: text("speaker_source"),
    speakerAttribution: text("speaker_attribution"),
    speakerLabel: text("speaker_label"),
    startTime: text("start_time"),
    endTime: text("end_time"),
  },
  (table) => [
    uniqueIndex("evidence_chunks_source_chunk_unique").on(
      table.sourceId,
      table.chunkIndex
    ),
    index("evidence_chunks_source_start_time_idx").on(
      table.sourceId,
      table.startTime
    ),
  ]
);

export const meetingSessions = sqliteTable("meeting_sessions", {
  id: text("id").primaryKey(),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  endedAt: text("ended_at"),
});

export const utterances = sqliteTable(
  "utterances",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id")
      .notNull()
      .references(() => meetingSessions.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    capturedAt: text("captured_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("utterances_session_time_idx").on(table.sessionId, table.capturedAt)]
);

export const judgeReceipts = sqliteTable(
  "judge_receipts",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => meetingSessions.id, { onDelete: "cascade" }),
    normalizedClaim: text("normalized_claim").notNull(),
    action: text("action").notNull(),
    correction: text("correction"),
    confidencePermille: integer("confidence_permille").notNull(),
    evidenceJson: text("evidence_json").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("judge_receipts_session_time_idx").on(table.sessionId, table.createdAt),
    index("judge_receipts_claim_time_idx").on(table.normalizedClaim, table.createdAt),
  ]
);
