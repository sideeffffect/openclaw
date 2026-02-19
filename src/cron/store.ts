import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { expandHomePrefix } from "../infra/home-dir.js";
import { CONFIG_DIR } from "../utils.js";
import type { CronStoreFile } from "./types.js";

export const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
export const DEFAULT_CRON_STORE_PATH = path.join(DEFAULT_CRON_DIR, "jobs.json");

function resolvePathWithTilde(raw: string): string {
  if (raw.startsWith("~")) {
    return path.resolve(expandHomePrefix(raw));
  }
  return path.resolve(raw);
}

export function resolveCronStorePath(storePath?: string) {
  if (storePath?.trim()) {
    return resolvePathWithTilde(storePath.trim());
  }
  return DEFAULT_CRON_STORE_PATH;
}

/**
 * Resolve the jobs.d/ directory path from config. Returns `undefined` when
 * no `storeDir` is configured.
 */
export function resolveJobsDir(storeDir?: string): string | undefined {
  if (storeDir?.trim()) {
    return resolvePathWithTilde(storeDir.trim());
  }
  return undefined;
}

export type JobDirEntry = {
  /** Parsed job declaration. */
  job: CronStoreFile["jobs"][number];
  /** Absolute path of the file this job was loaded from (may be a symlink). */
  filePath: string;
};

/**
 * Load all `*.json` files from a jobs.d/ directory. Each file must contain a
 * single job declaration object (same schema as an entry in jobs.json). Files
 * that fail to parse are skipped with a warning logged to stderr.
 *
 * Returns an empty array if the directory does not exist.
 */
export async function loadJobsDir(dir: string): Promise<JobDirEntry[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const result: JobDirEntry[] = [];
  const jsonFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of jsonFiles) {
    const filePath = path.join(dir, entry.name);
    try {
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const parsed: unknown = JSON5.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        process.stderr.write(
          `cron storeDir: skipping ${entry.name} — expected a job object, got ${Array.isArray(parsed) ? "array" : typeof parsed}\n`,
        );
        continue;
      }
      result.push({ job: parsed as never, filePath });
    } catch (err) {
      process.stderr.write(`cron storeDir: skipping ${entry.name} — ${String(err)}\n`);
    }
  }

  return result;
}

/**
 * Atomically write a single job back to `filePath`, following any symlink so
 * the symlink itself is not replaced by a regular file.
 */
export async function saveJobFile(filePath: string, job: CronStoreFile["jobs"][number]) {
  // Follow symlink to get the real on-disk path so the atomic rename targets
  // the actual file rather than replacing the symlink with a new inode.
  const realPath = await fs.promises.realpath(filePath).catch(() => filePath);
  const { randomBytes } = await import("node:crypto");
  const tmp = `${realPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(job, null, 2), "utf-8");
  await fs.promises.rename(tmp, realPath);
}

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON5.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse cron store at ${storePath}: ${String(err)}`, {
        cause: err,
      });
    }
    const parsedRecord =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const jobs = Array.isArray(parsedRecord.jobs) ? (parsedRecord.jobs as never[]) : [];
    return {
      version: 1,
      jobs: jobs.filter(Boolean) as never as CronStoreFile["jobs"],
    };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return { version: 1, jobs: [] };
    }
    throw err;
  }
}

export async function saveCronStore(storePath: string, store: CronStoreFile) {
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const { randomBytes } = await import("node:crypto");
  const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const json = JSON.stringify(store, null, 2);
  await fs.promises.writeFile(tmp, json, "utf-8");
  await fs.promises.rename(tmp, storePath);
  try {
    await fs.promises.copyFile(storePath, `${storePath}.bak`);
  } catch {
    // best-effort
  }
}
