declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    INGEST_TOKEN?: string;
    VIEW_TOKEN?: string;
  }
}
