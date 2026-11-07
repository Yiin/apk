// Turns an apkpure XAPK bundle into one installable APK, plus any OBB data files.
// One build runs at a time. Results stay in a size-capped disk cache:
//   cache/<pkg>-<code>/app.apk
//   cache/<pkg>-<code>/obb/<name>.obb
//   cache/<pkg>-<code>/meta.json

import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import { fetchFile, resolve } from "./apkpure";
import { config } from "./config";
import { run } from "./exec";
import { signerReady, signApk } from "./signer";

export type ObbFile = { name: string; size: number };

export type BuildResult = {
  // "original" keeps the developer's signature. "rebuilt" carries the server key.
  signature: "original" | "rebuilt";
  apkSize: number;
  obb: ObbFile[];
};

export type JobState =
  | { step: "queued"; position: number }
  | { step: "downloading"; done: number; total: number }
  | { step: "merging" }
  | { step: "signing" }
  | { step: "done" }
  | { step: "failed"; reason: string };

type Job = { id: string; pkg: string; code: string; state: JobState };

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running: Job | null = null;

// The zip format inside an APK tops out at 4 GiB.
const MAX_APK_BYTES = 4 * 1024 ** 3 - 64 * 1024 ** 2;

export class QueueFullError extends Error {}
class BuildError extends Error {}

function jobId(pkg: string, code: string): string {
  return `${pkg}-${code}`;
}

function cacheDir(pkg: string, code: string): string {
  return join(config.cacheDir, jobId(pkg, code));
}

export function apkPath(pkg: string, code: string): string {
  return join(cacheDir(pkg, code), "app.apk");
}

export function obbPath(pkg: string, code: string, name: string): string {
  return join(cacheDir(pkg, code), "obb", basename(name));
}

// Returns the finished build and marks it as recently used, or null.
export async function cachedBuild(pkg: string, code: string): Promise<BuildResult | null> {
  const dir = cacheDir(pkg, code);
  try {
    const meta = (await Bun.file(join(dir, "meta.json")).json()) as BuildResult;
    const now = new Date();
    await utimes(dir, now, now);
    return meta;
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

  const job: Job = { id, pkg, code, state: { step: "queued", position: 0 } };
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
    await evict(job.id);
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

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

async function freeBytes(dir: string): Promise<number> {
  const out = await run(["df", "-B1", "--output=avail", dir]);
  return Number(out.trim().split("\n").at(-1));
}

async function build(job: Job): Promise<void> {
  await signerReady;
  const work = join(config.workDir, job.id);
  await rm(work, { recursive: true, force: true });
  await mkdir(join(work, "splits"), { recursive: true });

  try {
    const file = await resolve(job.pkg, job.code, "XAPK");
    if (file.size > config.maxBundleBytes) {
      throw new BuildError(`This bundle is ${mb(file.size)}. The limit is ${mb(config.maxBundleBytes)}.`);
    }
    // A build holds about two copies of the bundle on disk at its peak.
    const free = await freeBytes(config.dataDir);
    if (free - file.size * 2.2 < config.minFreeBytes) {
      throw new BuildError("The server is short on disk space right now. Try again later.");
    }

    const bundle = join(work, "bundle.zip");
    await download(job, file.url, file.size, bundle);

    const entries = (await run(["unzip", "-Z1", bundle])).split("\n").filter(Boolean);
    const apks = entries.filter((e) => e.endsWith(".apk") && !e.includes("/"));
    const obbs = entries.filter((e) => e.toLowerCase().endsWith(".obb"));
    if (apks.length === 0) throw new BuildError("The bundle has no APK files.");

    job.state = { step: "merging" };
    const out = join(work, "out");
    await mkdir(join(out, "obb"), { recursive: true });
    // -j drops the folders, so Android/obb/<pkg>/main.1.pkg.obb lands as main.1.pkg.obb.
    if (obbs.length) await run(["unzip", "-q", "-o", "-j", bundle, ...obbs, "-d", join(out, "obb")]);
    await run(["unzip", "-q", "-o", bundle, ...apks, "-d", join(work, "splits")]);
    await rm(bundle, { force: true });

    let signature: BuildResult["signature"];
    if (apks.length === 1) {
      // One APK needs no merge, so it keeps the developer's signature.
      await rename(join(work, "splits", apks[0]!), join(out, "app.apk"));
      signature = "original";
    } else {
      const merged = join(work, "merged.apk");
      await run(["java", `-Xmx${config.javaHeap}`, "-jar", config.apkEditorJar, "m", "-i", join(work, "splits"), "-o", merged, "-f"]);
      await rm(join(work, "splits"), { recursive: true, force: true });
      if ((await stat(merged)).size > MAX_APK_BYTES) {
        throw new BuildError("The merged app is larger than 4 GB, the most one APK file can hold.");
      }

      job.state = { step: "signing" };
      const aligned = join(work, "aligned.apk");
      await run(["zipalign", "-f", "-p", "4", merged, aligned]);
      await rm(merged, { force: true });
      await signApk(aligned, join(out, "app.apk"));
      await rm(aligned, { force: true });
      signature = "rebuilt";
    }

    const obb: ObbFile[] = [];
    for (const name of (await readdir(join(out, "obb"))).sort()) {
      obb.push({ name, size: (await stat(join(out, "obb", name))).size });
    }
    const result: BuildResult = { signature, apkSize: (await stat(join(out, "app.apk"))).size, obb };
    await Bun.write(join(out, "meta.json"), JSON.stringify(result));

    await mkdir(config.cacheDir, { recursive: true });
    const dest = cacheDir(job.pkg, job.code);
    await rm(dest, { recursive: true, force: true });
    await rename(out, dest);
    job.state = { step: "done" };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function download(job: Job, url: string, total: number, dest: string): Promise<void> {
  const res = await fetchFile(url, AbortSignal.timeout(60 * 60 * 1000));
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

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
}

// Deletes the least recently used builds until the cache fits its cap.
// The build that just finished always stays.
async function evict(keep: string): Promise<void> {
  const entries = await readdir(config.cacheDir, { withFileTypes: true });
  const builds = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const path = join(config.cacheDir, e.name);
        return { name: e.name, path, size: await dirSize(path), used: (await stat(path)).mtimeMs };
      }),
  );
  builds.sort((a, b) => a.used - b.used);
  let total = builds.reduce((sum, b) => sum + b.size, 0);
  for (const b of builds) {
    if (total <= config.cacheMaxBytes) break;
    if (b.name === keep) continue;
    await rm(b.path, { recursive: true, force: true });
    total -= b.size;
  }
}
