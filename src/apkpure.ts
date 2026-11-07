// Scrapes apkpure.net pages and resolves its download links.
// Every value that comes out of here is untrusted text: views must escape it.

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const SITE = "https://apkpure.net";
const DL = "https://d.apkpure.net/b";
const PAGE_TTL_MS = 10 * 60 * 1000;

export const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

export type SearchHit = {
  pkg: string;
  title: string;
  developer: string;
  icon: string;
  rating: string;
};

export type Version = {
  name: string;
  code: string;
  types: string[]; // "APK" and/or "XAPK"
  date: string;
  size: string;
  minAndroid: string;
  latest: boolean;
};

export type AppDetails = {
  pkg: string;
  title: string;
  developer: string;
  icon: string;
  summary: string;
  description: string[];
  screenshots: string[];
  versions: Version[];
};

export type ResolvedFile = {
  type: "APK" | "XAPK";
  url: string;
  filename: string;
  size: number;
};

export class NotFoundError extends Error {}

const pageCache = new Map<string, { at: number; html: string }>();

async function fetchPage(url: string): Promise<string> {
  const hit = pageCache.get(url);
  if (hit && Date.now() - hit.at < PAGE_TTL_MS) return hit.html;

  const res = await fetch(url, {
    headers: { "user-agent": UA, "accept-language": "en" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) throw new NotFoundError(url);
  if (!res.ok) throw new Error(`apkpure ${res.status} for ${url}`);
  const html = await res.text();

  pageCache.set(url, { at: Date.now(), html });
  if (pageCache.size > 500) {
    const oldest = pageCache.keys().next().value;
    if (oldest) pageCache.delete(oldest);
  }
  return html;
}

// Runs HTMLRewriter over a page for its side effects (the handlers collect data).
async function scan(html: string, rewriter: HTMLRewriter): Promise<void> {
  await rewriter.transform(new Response(html)).text();
}

function clean(text: string): string {
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function imageUrl(raw: string | null): string {
  if (!raw) return "";
  const url = decodeEntities(raw).split(" ")[0] ?? "";
  return url.startsWith("https://") ? url : "";
}

export async function search(query: string): Promise<SearchHit[]> {
  const html = await fetchPage(`${SITE}/search?q=${encodeURIComponent(query)}`);
  const hits: SearchHit[] = [];
  let cur: SearchHit | null = null;
  let field: "title" | "developer" | "rating" | null = null;

  await scan(
    html,
    new HTMLRewriter()
      .on(".apk-list a.apk-item", {
        element(el) {
          const pkg = el.getAttribute("data-dt-pkg") ?? "";
          cur = PKG_RE.test(pkg) ? { pkg, title: "", developer: "", icon: "", rating: "" } : null;
          if (cur) hits.push(cur);
        },
      })
      .on(".apk-list a.apk-item img", {
        element(el) {
          if (cur) cur.icon = imageUrl(el.getAttribute("data-original"));
        },
      })
      .on(".apk-list a.apk-item .title", { element: () => void (field = "title"), text: collect })
      .on(".apk-list a.apk-item .dev", { element: () => void (field = "developer"), text: collect })
      .on(".apk-list a.apk-item .stars", { element: () => void (field = "rating"), text: collect }),
  );

  function collect(t: HTMLRewriterTypes.Text) {
    if (cur && field) cur[field] += t.text;
  }

  for (const h of hits) {
    h.title = clean(h.title);
    h.developer = clean(h.developer);
    h.rating = clean(h.rating);
  }
  return hits;
}

export async function app(pkg: string): Promise<AppDetails> {
  if (!PKG_RE.test(pkg)) throw new NotFoundError(pkg);
  // apkpure redirects any slug to the right one, so "x" works for every package.
  const [page, versionsPage] = await Promise.all([
    fetchPage(`${SITE}/x/${pkg}`),
    fetchPage(`${SITE}/x/${pkg}/versions`),
  ]);

  const d: AppDetails = {
    pkg,
    title: "",
    developer: "",
    icon: "",
    summary: "",
    description: [],
    screenshots: [],
    versions: [],
  };
  let into: "title" | "developer" | "summary" | null = null;
  let para: string | null = null;

  await scan(
    page,
    new HTMLRewriter()
      .on(".apk-info-text h1", { element: () => void (into = "title"), text: (t) => add(t) })
      .on(".apk-info-text a.developer", { element: () => void (into = "developer"), text: (t) => add(t) })
      .on("img.app-icon-img", {
        element(el) {
          if (!d.icon) d.icon = imageUrl(el.getAttribute("src"));
        },
      })
      .on(".description-short", { element: () => void (into = "summary"), text: (t) => add(t) })
      .on(".description-content p, .description-content li, .description-content h3", {
        element(el) {
          para = "";
          el.onEndTag(() => {
            const text = clean(para ?? "");
            if (text) d.description.push(text);
            para = null;
          });
        },
        text(t) {
          if (para !== null) para += t.text;
        },
      })
      .on(".screen-swiper-list a.screen-pswp", {
        element(el) {
          const url = imageUrl(el.getAttribute("href"));
          if (url && d.screenshots.length < 8) d.screenshots.push(url);
        },
      }),
  );

  function add(t: HTMLRewriterTypes.Text) {
    if (into) d[into] += t.text;
    if (t.lastInTextNode) into = null;
  }

  d.title = clean(d.title) || pkg;
  d.developer = clean(d.developer);
  d.summary = clean(d.summary);
  d.description = d.description.slice(0, 40);
  d.versions = await parseVersions(versionsPage);
  return d;
}

async function parseVersions(html: string): Promise<Version[]> {
  const versions: Version[] = [];
  let cur: Version | null = null;
  let info: string[] = [];
  let span: string | null = null;

  await scan(
    html,
    new HTMLRewriter()
      .on("li.dt-version-item", {
        element(el) {
          const code = el.getAttribute("data-dt-version-code") ?? "";
          if (!/^\d+$/.test(code)) {
            cur = null;
            return;
          }
          cur = {
            name: clean(el.getAttribute("data-dt-version") ?? ""),
            code,
            types: [],
            date: "",
            size: "",
            minAndroid: "",
            latest: false,
          };
          info = [];
          versions.push(cur);
          const v = cur;
          el.onEndTag(() => {
            // The info spans come in order: date, size, Android requirement.
            [v.date = "", v.size = "", v.minAndroid = ""] = info;
          });
        },
      })
      .on("li.dt-version-item .apk-type-tag", {
        element(el) {
          const tag = el.getAttribute("data-tag");
          if (cur && (tag === "APK" || tag === "XAPK") && !cur.types.includes(tag)) cur.types.push(tag);
        },
      })
      .on("li.dt-version-item .apk-version-tag.latest", {
        element() {
          if (cur) cur.latest = true;
        },
      })
      .on("li.dt-version-item .additional-info > span", {
        element(el) {
          span = "";
          el.onEndTag(() => {
            if (span !== null) info.push(clean(span));
            span = null;
          });
        },
        text(t) {
          if (span !== null) span += t.text;
        },
      }),
  );
  return versions;
}

// Asks apkpure's download endpoint for a file and reads the redirect target.
// It never downloads the body here.
export async function resolve(pkg: string, code: string, type: "APK" | "XAPK"): Promise<ResolvedFile> {
  if (!PKG_RE.test(pkg) || !/^\d+$/.test(code)) throw new NotFoundError(pkg);
  const res = await fetch(`${DL}/${type}/${pkg}?versionCode=${code}`, {
    headers: { "user-agent": UA },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const location = res.headers.get("location");
  if (res.status === 404 || !location) throw new NotFoundError(`${pkg} ${code}`);

  const url = new URL(location);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".winudf.com")) {
    throw new Error(`unexpected download host ${url.hostname}`);
  }
  const actual = url.pathname.startsWith("/XAPK/") ? "XAPK" : "APK";
  return {
    type: actual,
    url: url.toString(),
    filename: url.searchParams.get("filename") ?? `${pkg}.${actual.toLowerCase()}`,
    size: Number(url.searchParams.get("full_size") ?? 0),
  };
}

export function fetchFile(url: string, signal?: AbortSignal): Promise<Response> {
  return fetch(url, { headers: { "user-agent": UA }, signal });
}
