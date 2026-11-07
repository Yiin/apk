import { join } from "node:path";

const dataDir = process.env.DATA_DIR ?? "./data";
const gb = (name: string, fallback: number) => Number(process.env[name] ?? fallback) * 1024 ** 3;

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dataDir,
  cacheDir: join(dataDir, "cache"),
  workDir: join(dataDir, "work"),
  keyDir: join(dataDir, "keys"),
  cacheMaxBytes: gb("CACHE_MAX_GB", 8),
  maxBundleBytes: gb("MAX_BUNDLE_GB", 4),
  // Builds refuse to start when they would leave less than this free on the disk.
  minFreeBytes: gb("MIN_FREE_GB", 8),
  maxQueue: Number(process.env.MAX_QUEUE ?? 8),
  buildsPerHour: Number(process.env.BUILDS_PER_HOUR ?? 6),
  javaHeap: process.env.JAVA_HEAP ?? "1500m",
  apkEditorJar: process.env.APKEDITOR_JAR ?? "/opt/apkeditor.jar",
};
