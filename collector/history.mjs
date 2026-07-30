import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DB_PATH = join(homedir(), ".usage-hub", "usage.db");

export class HistoryStore {
  constructor(path = process.env.USAGE_HUB_DB || DEFAULT_DB_PATH) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS usage_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        window_id TEXT NOT NULL,
        used_percent REAL,
        used_value REAL,
        limit_value REAL,
        remaining_value REAL,
        resets_at TEXT,
        captured_at TEXT NOT NULL,
        capture_bucket INTEGER NOT NULL,
        UNIQUE(provider_id, window_id, capture_bucket)
      );
      CREATE INDEX IF NOT EXISTS usage_history_time_idx
        ON usage_history(captured_at);
    `);
    this.insert = this.database.prepare(`
      INSERT OR REPLACE INTO usage_history (
        provider_id, window_id, used_percent, used_value, limit_value,
        remaining_value, resets_at, captured_at, capture_bucket
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.query = this.database.prepare(`
      SELECT
        provider_id AS providerId,
        window_id AS windowId,
        used_percent AS usedPercent,
        captured_at AS capturedAt
      FROM usage_history
      WHERE captured_at >= ?
      ORDER BY captured_at ASC
    `);
    this.prune = this.database.prepare(`
      DELETE FROM usage_history WHERE captured_at < ?
    `);
  }

  save(providers, capturedAt = new Date()) {
    // Drop rows older than 31 days so local history stays bounded.
    this.prune.run(new Date(Date.now() - 31 * 24 * 3600_000).toISOString());
    const fallbackTime =
      capturedAt instanceof Date && !Number.isNaN(capturedAt.getTime())
        ? capturedAt
        : new Date();
    for (const provider of providers) {
      if (provider.state !== "ready") continue;
      const providerTime = new Date(provider.updatedAt);
      const observationTime =
        !Number.isNaN(providerTime.getTime()) && providerTime <= fallbackTime
          ? providerTime
          : fallbackTime;
      const capturedIso = observationTime.toISOString();
      const fiveMinuteBucket = Math.floor(observationTime.getTime() / 300_000);
      for (const window of provider.windows) {
        this.insert.run(
          provider.id,
          window.id,
          window.usedPercent,
          window.used,
          window.limit,
          window.remaining,
          window.resetsAt,
          capturedIso,
          fiveMinuteBucket,
        );
      }
    }
  }

  recent(hours = 168) {
    const boundedHours = Math.max(1, Math.min(24 * 31, Number(hours) || 168));
    const since = new Date(Date.now() - boundedHours * 3600_000).toISOString();
    return this.query.all(since);
  }

  close() {
    this.database.close();
  }
}
