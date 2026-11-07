// Turns an apkpure XAPK bundle into one signed, installable APK.
// One build runs at a time. Finished APKs stay in a size-capped disk cache.

import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { fetchFile, resolve } from "./apkpure";
import { config } from "./config";
import { run } from "./exec";
import { signerReady, signApk } from "./signer";

export type JobState =
  | { step: "queued"; position: number }
  | { step: "downloading"; done: number; total: number }
  | { step: "merging" }
  | { step: "signing" }
  | { step: "done"; size: number }
  | { step: "failed"; reason: string };

type Job = { id: string; pkg: string; code: string; state: JobState; startedAt: number };

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running: Job | null = null;

export class QueueFullError extends Error {}

export function jobId(pkg: string, code: string): string {
  return `${pkg}-${code}`;
}

export function cachedPath(pkg: string, code: string): string {
  return join(config.cacheDir, `${jobId(pkg, code)}.apk`);
}

export async function cachedFile(pkg: string, code: string): Promise<string | null> {
  const path = cachedPath(pkg, code);
  try {
    await stat(path);
    const now = new Date();
    await utimes(path, now, now); // marks it as recently used for eviction
    return path;
  } catch {
    return null;
  }
}

export function jobState(pkg: string, code: string): JobState | null {
  const job = jobs.get(jobId(pkg, code));
  if (!job) return null;
  if (job.state.step === "queued") return { step: "queued", position: queue.indexOf(job) + 1 };
  return job.state;
}

// Starts a build, or returns the build that already runs for this version.
export function startBuild(pkg: string, code: string): JobState {
  const id = jobId(pkg, code);
  const existing = jobs.get(id);
  if (existing && existing.state.step !== "failed") return jobState(pkg, code)!;
  if (queue.length >= config.maxQueue) throw new QueueFullError();

  const job: Job = { id, pkg, code, state: { step: "queued", position: 0 }, startedAt: Date.now() };
  jobs.set(id, job);
  queue.push(job);
  void pump();
  return jobState(pkg, code)!;
}

async function pump(): Promise<void> {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = job;
  try {
    await build(job);
    await evict();
  } catch (err) {
    job.state = { step: "failed", reason: err instanceof BuildError ? err.message : "The build failed." };
    if (!(err instanceof BuildError)) console.error(`build ${job.id} failed:`, err);
  } finally {
    running = null;
    forgetLater(job);
    void pump();
  }
}

function forgetLater(job: Job) {
  setTimeout(() => {
    if (jobs.get(job.id) === job) jobs.delete(job.id);
  }, 30 * 60 * 1000).unref();
}

class BuildError extends Error {}

async function build(job: Job): Promise<void> {
  await signerReady;
  const work = join(config.workDir, job.id);
  await rm(work, { recursive: true, force: true });
  await mkdir(join(work, "splits"), { recursive: true });

  try {
    const file = await resolve(job.pkg, job.code, "XAPK");
    if (file.size > config.maxBundleBytes) {
      throw new BuildError(`This bundle is ${Math.round(file.size / 1e6)} MB. The limit is ${Math.round(config.maxBundleBytes / 1e6)} MB.`);
    }

    const bundle = join(work, "bundle.zip");
    await download(job, file.url, file.size, bundle);

    const entries = (await run(["unzip", "-Z1", bundle])).split("\n").filter(Boolean);
    if (entries.some((e) => e.toLowerCase().endsWith(".obb"))) {
      throw new BuildError("This app needs extra game data (OBB files). One APK cannot hold that data.");
    }
    const apks = entries.filter((e) => e.endsWith(".apk") && !e.includes("/"));
    if (apks.length === 0) throw new BuildError("The bundle has no APK files.");

    job.state = { step: "merging" };
    await run(["unzip", "-q", "-o", bundle, ...apks, "-d", join(work, "splits")]);
    await rm(bundle, { force: true });

    const merged = join(work, "merged.apk");
    if (apks.length === 1) {
      await rename(join(work, "splits", apks[0]!), merged);
    } else {
      await run(["java", `-Xmx${config.javaHeap}`, "-jar", config.apkEditorJar, "m", "-i", join(work, "splits"), "-o", merged, "-f"]);
    }

    job.state = { step: "signing" };
    const aligned = join(work, "aligned.apk");
    await run(["zipalign", "-f", "-p", "4", merged, aligned]);
    const signed = join(work, "signed.apk");
    await signApk(aligned, signed);

    await mkdir(config.cacheDir, { recursive: true });
    const dest = cachedPath(job.pkg, job.code);
    await rename(signed, dest);
    job.state = { step: "done", size: (await stat(dest)).size };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function download(job: Job, url: string, total: number, dest: string): Promise<void> {
  const res = await fetchFile(url, AbortSignal.timeout(30 * 60 * 1000));
  if (!res.ok || !res.body) throw new BuildError(`apkpure refused the download (HTTP ${res.status}).`);
  const out = Bun.file(dest).writer();
  let done = 0;
  job.state = { step: "downloading", done, total };
  for await (const chunk of res.body) {
    done += chunk.byteLength;
    if (done > config.maxBundleBytes) throw new BuildError("The bundle is larger than the limit.");
    out.write(chunk);
    job.state = { step: "downloading", done, total };
  }
  await out.end();
}

// Deletes the least recently used APKs until the cache fits its cap.
async function evict(): Promise<void> {
  const names = await readdir(config.cacheDir);
  const files = await Promise.all(
    names
      .filter((n) => n.endsWith(".apk"))
      .map(async (n) => {
        const path = join(config.cacheDir, n);
        const s = await stat(path);
        return { path, size: s.size, used: s.mtimeMs };
      }),
  );
  files.sort((a, b) => a.used - b.used);
  let total = files.reduce((sum, f) => sum + f.size, 0);
  for (const f of files) {
    if (total <= config.cacheMaxBytes) break;
    await rm(f.path, { force: true });
    total -= f.size;
  }
}
