import { join } from "node:path";
import * as apkpure from "./apkpure";
import { NotFoundError, PKG_RE } from "./apkpure";
import { cachedFile, jobState, QueueFullError, startBuild } from "./builder";
import { config } from "./config";
import { signerFingerprint, signerReady } from "./signer";
import * as views from "./views";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' https://image-eo.winudf.com https://*.winudf.com data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
}

function redirect(location: string, status = 303): Response {
  return new Response(null, { status, headers: { location } });
}

// Caddy appends the real client address as the last X-Forwarded-For entry.
function clientIp(req: Request, server: Bun.Server<undefined>): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",").at(-1)!.trim();
  return server.requestIP(req)?.address ?? "unknown";
}

const buildLog = new Map<string, number[]>();
function allowBuild(ip: string): boolean {
  const hourAgo = Date.now() - 3600_000;
  const recent = (buildLog.get(ip) ?? []).filter((t) => t > hourAgo);
  if (recent.length >= config.buildsPerHour) return false;
  recent.push(Date.now());
  buildLog.set(ip, recent);
  return true;
}
setInterval(() => {
  const hourAgo = Date.now() - 3600_000;
  for (const [ip, times] of buildLog) if (!times.some((t) => t > hourAgo)) buildLog.delete(ip);
}, 600_000).unref();

function apkFilename(title: string, version: string): string {
  const base = `${title}-${version}`.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${base || "app"}.apk`;
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function findVersion(pkg: string, code: string) {
  const details = await apkpure.app(pkg);
  const version = details.versions.find((v) => v.code === code);
  if (!version) throw new NotFoundError(`${pkg} ${code}`);
  return { details, version };
}

// Streams a plain APK from apkpure's CDN with a clean file name. Range requests pass through.
async function proxyApk(req: Request, pkg: string, code: string): Promise<Response> {
  const { details, version } = await findVersion(pkg, code);
  if (views.versionKind(version) !== "apk") return redirect(`/app/${pkg}`);
  const file = await apkpure.resolve(pkg, code, "APK");
  const range = req.headers.get("range");
  const upstream = await fetch(file.url, {
    headers: { "user-agent": "Mozilla/5.0", ...(range ? { range } : {}) },
    signal: req.signal,
  });
  if (!upstream.ok || !upstream.body) throw new Error(`upstream ${upstream.status}`);

  const headers = new Headers({
    "content-type": "application/vnd.android.package-archive",
    "content-disposition": contentDisposition(apkFilename(details.title, version.name)),
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
  });
  for (const h of ["content-length", "content-range", "last-modified", "etag"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function serveBuilt(req: Request, pkg: string, code: string): Promise<Response> {
  const path = await cachedFile(pkg, code);
  if (!path) return redirect(`/build/${pkg}/${code}`);
  const file = Bun.file(path);
  const size = file.size;

  let name = `${pkg}-${code}.apk`;
  try {
    const { details, version } = await findVersion(pkg, code);
    name = apkFilename(details.title, version.name);
  } catch {
    // The name is cosmetic. Serve the file even when apkpure is down.
  }

  const headers = new Headers({
    "content-type": "application/vnd.android.package-archive",
    "content-disposition": contentDisposition(name),
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
  });

  const m = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(file.slice(start, end + 1), { status: 206, headers });
  }
  headers.set("content-length", String(size));
  return new Response(file, { headers });
}

async function staticFile(name: string): Promise<Response | null> {
  if (!/^[a-z0-9.-]+$/.test(name)) return null;
  const file = Bun.file(join(PUBLIC_DIR, name));
  if (!(await file.exists())) return null;
  return new Response(file, { headers: { "cache-control": "public, max-age=3600", ...SECURITY_HEADERS } });
}

async function handle(req: Request, server: Bun.Server<undefined>): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const [route, pkg = "", code = ""] = parts;
  const versionRoute = parts.length === 3 && PKG_RE.test(pkg) && /^\d{1,12}$/.test(code);

  if (req.method === "GET" && url.pathname === "/") return html(views.homePage());

  if (req.method === "GET" && url.pathname === "/search") {
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
    if (!q) return redirect("/");
    if (PKG_RE.test(q) && q.split(".").length >= 2 && !q.includes(" ")) {
      // A package name goes straight to its page when apkpure knows it.
      try {
        await apkpure.app(q);
        return redirect(`/app/${q}`);
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
      }
    }
    return html(views.searchPage(q, await apkpure.search(q)));
  }

  if (req.method === "GET" && route === "app" && parts.length === 2 && PKG_RE.test(pkg)) {
    return html(views.appPage(await apkpure.app(pkg)));
  }

  if (req.method === "GET" && route === "get" && versionRoute) return proxyApk(req, pkg, code);

  if (route === "build" && versionRoute) {
    if (req.method === "POST") {
      if (await cachedFile(pkg, code)) return redirect(`/file/${pkg}/${code}`);
      const state = jobState(pkg, code);
      if (!state || state.step === "failed") {
        await findVersion(pkg, code); // only versions apkpure lists
        if (!allowBuild(clientIp(req, server))) {
          return html(views.errorPage(429, `You started ${config.buildsPerHour} builds in the last hour. Try again later.`), 429);
        }
        try {
          startBuild(pkg, code);
        } catch (err) {
          if (err instanceof QueueFullError) return html(views.errorPage(503, "The build queue is full. Try again in a few minutes."), 503);
          throw err;
        }
      }
      return redirect(`/build/${pkg}/${code}`);
    }
    if (req.method === "GET") {
      const { details, version } = await findVersion(pkg, code);
      return html(views.buildPage(pkg, code, details.title, version.name));
    }
  }

  if (req.method === "GET" && route === "api" && pkg === "build" && parts.length === 4) {
    const [, , p, c] = parts as [string, string, string, string];
    if (!PKG_RE.test(p) || !/^\d{1,12}$/.test(c)) return Response.json({ error: "bad request" }, { status: 400 });
    if (await cachedFile(p, c)) return Response.json({ step: "done" });
    return Response.json(jobState(p, c) ?? { step: "none" }, { headers: { "cache-control": "no-store" } });
  }

  if ((req.method === "GET" || req.method === "HEAD") && route === "file" && versionRoute) return serveBuilt(req, pkg, code);

  if (req.method === "GET" && url.pathname === "/about") return html(views.aboutPage(signerFingerprint));
  if (req.method === "GET" && url.pathname === "/healthz") return new Response("ok");
  if (req.method === "GET" && url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /get/\nDisallow: /build/\nDisallow: /file/\nDisallow: /api/\n");
  }
  if (req.method === "GET" && parts.length === 1) {
    const res = await staticFile(parts[0]!);
    if (res) return res;
  }
  return html(views.errorPage(404, "This page does not exist."), 404);
}

await signerReady;

const server = Bun.serve({
  port: config.port,
  idleTimeout: 120,
  async fetch(req, server) {
    try {
      return await handle(req, server);
    } catch (err) {
      if (err instanceof NotFoundError) return html(views.errorPage(404, "apkpure has no such app or version."), 404);
      if (req.signal.aborted) return new Response(null, { status: 499 });
      console.error(req.method, req.url, err);
      return html(views.errorPage(502, "apkpure did not answer. Try again in a moment."), 502);
    }
  },
});

console.log(`apk.yiin.lt on :${server.port}`);
