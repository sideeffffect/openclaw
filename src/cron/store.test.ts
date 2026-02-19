import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadCronStore,
  loadJobsDir,
  resolveCronStorePath,
  resolveJobsDir,
  saveJobFile,
} from "./store.js";
import type { CronJob } from "./types.js";

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-store-"));
  return {
    dir,
    storePath: path.join(dir, "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

async function makeJobsDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-jobs-d-"));
  return {
    dir,
    writeJob: (name: string, content: unknown) =>
      fs.writeFile(path.join(dir, name), JSON.stringify(content), "utf-8"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("resolveCronStorePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses OPENCLAW_HOME for tilde expansion", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    const result = resolveCronStorePath("~/cron/jobs.json");
    expect(result).toBe(path.resolve("/srv/openclaw-home", "cron", "jobs.json"));
  });
});

describe("resolveJobsDir", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns undefined when no storeDir is configured", () => {
    expect(resolveJobsDir(undefined)).toBeUndefined();
    expect(resolveJobsDir("")).toBeUndefined();
    expect(resolveJobsDir("   ")).toBeUndefined();
  });

  it("resolves an absolute path as-is", () => {
    expect(resolveJobsDir("/srv/cron/jobs.d")).toBe(path.resolve("/srv/cron/jobs.d"));
  });

  it("expands tilde using OPENCLAW_HOME", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    const result = resolveJobsDir("~/cron/jobs.d");
    expect(result).toBe(path.resolve("/srv/openclaw-home", "cron", "jobs.d"));
  });
});

describe("loadJobsDir", () => {
  it("returns empty array when directory does not exist", async () => {
    const result = await loadJobsDir("/nonexistent/path/jobs.d");
    expect(result).toEqual([]);
  });

  it("returns empty array for an empty directory", async () => {
    const { dir, cleanup } = await makeJobsDir();
    const result = await loadJobsDir(dir);
    expect(result).toEqual([]);
    await cleanup();
  });

  it("loads a single job from a .json file, returning job and filePath", async () => {
    const { dir, writeJob, cleanup } = await makeJobsDir();
    const job = {
      id: "test-id-1",
      name: "Test job",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "hello" },
    };
    await writeJob("test.json", job);

    const result = await loadJobsDir(dir);
    expect(result).toHaveLength(1);
    expect(result[0].job).toMatchObject({ id: "test-id-1", name: "Test job" });
    expect(result[0].filePath).toBe(path.join(dir, "test.json"));
    await cleanup();
  });

  it("loads multiple jobs sorted alphabetically by filename", async () => {
    const { dir, writeJob, cleanup } = await makeJobsDir();
    await writeJob("b-job.json", { id: "b", name: "B job", schedule: { kind: "cron", expr: "0 9 * * *" }, sessionTarget: "isolated", payload: { kind: "agentTurn", message: "b" } });
    await writeJob("a-job.json", { id: "a", name: "A job", schedule: { kind: "cron", expr: "0 8 * * *" }, sessionTarget: "isolated", payload: { kind: "agentTurn", message: "a" } });

    const result = await loadJobsDir(dir);
    expect(result).toHaveLength(2);
    expect(result[0].job).toMatchObject({ id: "a" });
    expect(result[0].filePath).toBe(path.join(dir, "a-job.json"));
    expect(result[1].job).toMatchObject({ id: "b" });
    expect(result[1].filePath).toBe(path.join(dir, "b-job.json"));
    await cleanup();
  });

  it("skips non-.json files", async () => {
    const { dir, writeJob, cleanup } = await makeJobsDir();
    await writeJob("job.json", { id: "keep", name: "keep", schedule: { kind: "cron", expr: "0 9 * * *" }, sessionTarget: "isolated", payload: { kind: "agentTurn", message: "hi" } });
    await fs.writeFile(path.join(dir, "README.md"), "docs", "utf-8");
    await fs.writeFile(path.join(dir, "job.toml"), "not-json", "utf-8");

    const result = await loadJobsDir(dir);
    expect(result).toHaveLength(1);
    expect(result[0].job).toMatchObject({ id: "keep" });
    await cleanup();
  });

  it("skips files with invalid JSON and continues", async () => {
    const { dir, writeJob, cleanup } = await makeJobsDir();
    await fs.writeFile(path.join(dir, "bad.json"), "{ not valid json", "utf-8");
    await writeJob("good.json", { id: "good", name: "good", schedule: { kind: "cron", expr: "0 9 * * *" }, sessionTarget: "isolated", payload: { kind: "agentTurn", message: "hi" } });

    const result = await loadJobsDir(dir);
    expect(result).toHaveLength(1);
    expect(result[0].job).toMatchObject({ id: "good" });
    await cleanup();
  });

  it("skips files whose content is not an object", async () => {
    const { dir, writeJob, cleanup } = await makeJobsDir();
    await fs.writeFile(path.join(dir, "array.json"), JSON.stringify([{ id: "x" }]), "utf-8");
    await writeJob("good.json", { id: "good", name: "good", schedule: { kind: "cron", expr: "0 9 * * *" }, sessionTarget: "isolated", payload: { kind: "agentTurn", message: "hi" } });

    const result = await loadJobsDir(dir);
    expect(result).toHaveLength(1);
    expect(result[0].job).toMatchObject({ id: "good" });
    await cleanup();
  });
});

describe("saveJobFile", () => {
  it("writes job to a new file", async () => {
    const { dir, cleanup } = await makeJobsDir();
    const filePath = path.join(dir, "my-job.json");
    const job = {
      id: "job-1",
      name: "My job",
      enabled: true,
      createdAtMs: 1000,
      updatedAtMs: 2000,
      schedule: { kind: "cron" as const, expr: "0 9 * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "hi" },
      state: {},
    } satisfies CronJob;

    await saveJobFile(filePath, job);

    const written = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(written).toMatchObject({ id: "job-1", name: "My job" });
    await cleanup();
  });

  it("follows symlinks and writes to the real file", async () => {
    const { dir, cleanup } = await makeJobsDir();
    const realFile = path.join(dir, "real.json");
    const linkFile = path.join(dir, "link.json");

    // Write initial content to the real file and create a symlink to it.
    await fs.writeFile(realFile, JSON.stringify({ id: "original" }), "utf-8");
    await fs.symlink(realFile, linkFile);

    const job = {
      id: "updated",
      name: "Updated",
      enabled: true,
      createdAtMs: 1000,
      updatedAtMs: 2000,
      schedule: { kind: "cron" as const, expr: "0 9 * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "hi" },
      state: {},
    } satisfies CronJob;

    await saveJobFile(linkFile, job);

    // The symlink must still be a symlink (not replaced by a regular file).
    const linkStat = await fs.lstat(linkFile);
    expect(linkStat.isSymbolicLink()).toBe(true);

    // The real file must contain the updated content.
    const realContent = JSON.parse(await fs.readFile(realFile, "utf-8"));
    expect(realContent).toMatchObject({ id: "updated" });

    await cleanup();
  });
});

describe("cron store", () => {
  it("returns empty store when file does not exist", async () => {
    const store = await makeStorePath();
    const loaded = await loadCronStore(store.storePath);
    expect(loaded).toEqual({ version: 1, jobs: [] });
    await store.cleanup();
  });

  it("throws when store contains invalid JSON", async () => {
    const store = await makeStorePath();
    await fs.writeFile(store.storePath, "{ not json", "utf-8");
    await expect(loadCronStore(store.storePath)).rejects.toThrow(/Failed to parse cron store/i);
    await store.cleanup();
  });
});
