import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const remoteSnapshots = sqliteTable("remote_snapshots", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
  generatedAt: text("generated_at").notNull(),
  receivedAt: text("received_at").notNull(),
});

export const remoteUsageHistory = sqliteTable(
  "remote_usage_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    providerId: text("provider_id").notNull(),
    windowId: text("window_id").notNull(),
    usedPercent: real("used_percent"),
    capturedAt: text("captured_at").notNull(),
    captureBucket: integer("capture_bucket").notNull(),
  },
  (table) => [
    index("remote_usage_history_time_idx").on(table.capturedAt),
    uniqueIndex("remote_usage_history_bucket_idx").on(
      table.providerId,
      table.windowId,
      table.captureBucket,
    ),
  ],
);
