export type CronConfig = {
  enabled?: boolean;
  store?: string;
  /**
   * Optional directory of per-job JSON files (jobs.d/ pattern).
   * Each `*.json` file in the directory contains a single job declaration —
   * same schema as a jobs.json entry. Jobs are loaded read-only from this
   * directory and merged into the in-memory store at startup.
   *
   * If a dir job's `id` matches an existing jobs.json entry, the dir file's
   * config fields take precedence while runtime state (nextRunAtMs, lastRunAtMs,
   * etc.) is preserved from jobs.json. Useful for NixOS / GitOps declarative setups:
   *
   * ```json5
   * { cron: { storeDir: "~/.openclaw/cron/jobs.d" } }
   * ```
   */
  storeDir?: string;
  maxConcurrentRuns?: number;
  /**
   * Deprecated legacy fallback webhook URL used only for stored jobs with notify=true.
   * Prefer per-job delivery.mode="webhook" with delivery.to.
   */
  webhook?: string;
  /** Bearer token for cron webhook POST delivery. */
  webhookToken?: string;
  /**
   * How long to retain completed cron run sessions before automatic pruning.
   * Accepts a duration string (e.g. "24h", "7d", "1h30m") or `false` to disable pruning.
   * Default: "24h".
   */
  sessionRetention?: string | false;
};
