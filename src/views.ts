import type { AppDetails, SearchHit, Version } from "./apkpure";
import type { BuildResult } from "./builder";

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Lucide icons (ISC license), inlined so the page loads nothing from third parties.
const ICONS = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
} as const;

export function icon(name: keyof typeof ICONS, size = 20): string {
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

function searchForm(q = "", big = false): string {
  return `<form class="search${big ? " search-big" : ""}" action="/search" method="get" role="search">
  <label class="sr-only" for="q">Search apps</label>
  ${icon("search")}
  <input id="q" name="q" type="search" value="${esc(q)}" placeholder="App name or package, e.g. org.mozilla.firefox" autocomplete="off" required maxlength="100" ${big ? "autofocus" : ""}>
  <button type="submit" class="btn btn-primary">Search</button>
</form>`;
}

export function layout(title: string, body: string, opts: { q?: string; home?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark light">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${opts.home ? "" : `<header class="top"><div class="wrap top-inner"><a class="brand" href="/">apk<span>.yiin.lt</span></a>${searchForm(opts.q)}</div></header>`}
<main id="main" class="wrap">
${body}
</main>
<footer class="wrap foot">
  <p>Files come from apkpure.net. Plain APKs keep their original signature. <a href="/about">How it works</a></p>
</footer>
</body>
</html>`;
}

export function homePage(): string {
  return layout(
    "apk.yiin.lt",
    `<section class="hero">
  <h1>apk<span>.yiin.lt</span></h1>
  <p class="lede">Search Android apps and get one APK file you can install directly.</p>
  ${searchForm("", true)}
  <ul class="points">
    <li>${icon("ban")}<span><strong>No ads.</strong> No trackers, no popups, no countdowns.</span></li>
    <li>${icon("layers")}<span><strong>No bundles.</strong> Split XAPK bundles become one APK on the server.</span></li>
    <li>${icon("shield")}<span><strong>No installer apps.</strong> Open the file on your phone and install.</span></li>
  </ul>
</section>`,
    { home: true },
  );
}

function appIcon(src: string, alt: string, size: number): string {
  return src
    ? `<img class="app-icon" src="${esc(src)}" alt="${esc(alt)}" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="app-icon app-icon-empty s${size}" aria-hidden="true"></div>`;
}

export function searchPage(q: string, hits: SearchHit[]): string {
  const list = hits.length
    ? `<ul class="results">${hits
        .map(
          (h) => `<li><a class="result" href="/app/${esc(h.pkg)}">
  ${appIcon(h.icon, "", 56)}
  <span class="result-text">
    <span class="result-title">${esc(h.title)}</span>
    <span class="result-dev">${esc(h.developer)}</span>
    <span class="result-pkg">${esc(h.pkg)}</span>
  </span>
</a></li>`,
        )
        .join("")}</ul>`
    : `<div class="empty"><p>No apps match “${esc(q)}”.</p><p class="muted">Try a shorter name, or paste the package name from the Play Store link.</p></div>`;
  return layout(`${q} · apk.yiin.lt`, `<h1 class="page-title">Results for “${esc(q)}”</h1>${list}`, { q });
}

export function versionKind(v: Version): "apk" | "bundle" {
  return v.types.includes("APK") ? "apk" : "bundle";
}

function downloadControl(pkg: string, v: Version, primary: boolean): string {
  const cls = `btn ${primary ? "btn-primary btn-lg" : "btn-ghost"}`;
  const label = primary ? `${icon("download")} Download APK` : `${icon("download")} APK`;
  const aria = `Download version ${esc(v.name)}`;
  if (versionKind(v) === "apk") {
    return `<a class="${cls}" href="/get/${esc(pkg)}/${esc(v.code)}" rel="nofollow" aria-label="${aria}">${label}</a>`;
  }
  // A bundle starts a server build, so it goes through POST (crawlers and link prefetch skip it).
  return `<form method="post" action="/build/${esc(pkg)}/${esc(v.code)}" class="inline"><button class="${cls}" type="submit" aria-label="${aria}">${label}</button></form>`;
}

function kindBadge(v: Version): string {
  return versionKind(v) === "apk"
    ? `<span class="badge badge-ok" title="The file is the original APK, signed by the developer">${icon("check", 14)} Original</span>`
    : `<span class="badge badge-build" title="The server turns the bundle into one APK">${icon("layers", 14)} Bundle</span>`;
}

export function appPage(d: AppDetails): string {
  const latest = d.versions[0];
  const versions = d.versions
    .map(
      (v) => `<li class="version">
  <div class="version-main">
    <span class="version-name">${esc(v.name)}${v.latest ? ' <span class="badge">Latest</span>' : ""}</span>
    <span class="version-meta">${[v.date, v.size, v.minAndroid].filter(Boolean).map(esc).join(" · ")}</span>
  </div>
  ${kindBadge(v)}
  ${downloadControl(d.pkg, v, false)}
</li>`,
    )
    .join("");

  const note = latest
    ? versionKind(latest) === "apk"
      ? `<p class="note note-ok">${icon("check", 16)} <span>The latest version is a plain APK. You get the developer's original file.</span></p>`
      : `<p class="note">${icon("layers", 16)} <span>The latest version ships as a bundle. The server turns it into one APK for you. <a href="/about">How it works</a></span></p>`
    : `<p class="note">${icon("alert", 16)} <span>apkpure lists no downloadable versions for this app.</span></p>`;

  return layout(
    `${d.title} · apk.yiin.lt`,
    `<section class="app-head">
  ${appIcon(d.icon, `${d.title} icon`, 96)}
  <div class="app-head-text">
    <h1>${esc(d.title)}</h1>
    <p class="muted">${esc(d.developer)}</p>
    <p class="pkg">${esc(d.pkg)}</p>
  </div>
</section>
<div class="cta">
  ${latest ? downloadControl(d.pkg, latest, true) : ""}
  ${latest ? `<span class="muted">Version ${esc(latest.name)}${latest.size ? ` · ${esc(latest.size)}` : ""}</span>` : ""}
</div>
${note}
${d.summary ? `<p class="summary">${esc(d.summary)}</p>` : ""}
${
  d.screenshots.length
    ? `<div class="shots" role="list" aria-label="Screenshots">${d.screenshots
        .map((s, i) => `<img role="listitem" src="${esc(s)}" alt="Screenshot ${i + 1}" loading="lazy" referrerpolicy="no-referrer">`)
        .join("")}</div>`
    : ""
}
<h2>Versions</h2>
<ul class="versions">${versions}</ul>
${
  d.description.length
    ? `<details class="desc"><summary>Description</summary>${d.description.map((p) => `<p>${esc(p)}</p>`).join("")}</details>`
    : ""
}`,
  );
}

export function buildPage(pkg: string, code: string, title: string, version: string): string {
  return layout(
    `Building ${title} · apk.yiin.lt`,
    `<a class="back" href="/app/${esc(pkg)}">${icon("back", 16)} ${esc(title)}</a>
<section class="build" data-pkg="${esc(pkg)}" data-code="${esc(code)}">
  <h1 class="page-title">Building one APK</h1>
  <p class="muted">${esc(title)} ${esc(version)}. The server downloads the bundle and turns it into one APK. Big games take a few minutes. Keep this page open.</p>
  <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Build progress"><div class="progress-bar"></div></div>
  <p class="build-status" aria-live="polite">Starting…</p>
  <div class="build-failed" hidden>
    <p class="note note-bad" role="alert">${icon("alert", 16)} <span><span class="reason"></span></span></p>
    <form method="post" action="/build/${esc(pkg)}/${esc(code)}"><button class="btn btn-ghost" type="submit">Try again</button></form>
  </div>
</section>
<script src="/build.js" defer></script>`,
  );
}

const fmt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);

export function readyPage(pkg: string, code: string, title: string, version: string, build: BuildResult, autostart: boolean): string {
  const signature =
    build.signature === "original"
      ? `<p class="note note-ok">${icon("check", 16)} <span>This is the developer's original APK. It installs over a Play Store copy and updates normally.</span></p>`
      : `<p class="note">${icon("shield", 16)} <span>The server merged the bundle and signed the APK with the <a href="/about#signature">apk.yiin.lt key</a>. Uninstall a Play Store copy first.</span></p>`;

  const obb = build.obb.length
    ? `<h2>This game also needs its data files</h2>
<p class="muted">Android lets no app on the phone put these files in place, so this step needs a computer and a USB cable. You do it once per game version.</p>
<ul class="files">${build.obb
        .map(
          (f) => `<li><a class="btn btn-ghost" href="/file/${esc(pkg)}/${esc(code)}/obb/${esc(f.name)}" rel="nofollow">${icon("download", 18)} <span class="file-name">${esc(f.name)}</span></a><span class="muted">${fmt(f.size)}</span></li>`,
        )
        .join("")}</ul>
<ol class="steps">
  <li>Install the APK on your phone. Do not open the game yet.</li>
  <li>Download the data files above on a computer.</li>
  <li>Connect the phone to the computer with a USB cable. On the phone, pick <strong>File transfer</strong>.</li>
  <li>On the computer, open the phone's internal storage, then <code>Android</code> › <code>obb</code>. Make a folder named <code>${esc(pkg)}</code> if it is not there.</li>
  <li>Copy the data files into that folder. Then start the game.</li>
</ol>
<p class="muted">On Android 10 and older, a file manager on the phone can do steps 3 to 5.</p>`
    : "";

  return layout(
    `${title} ${version} · apk.yiin.lt`,
    `<a class="back" href="/app/${esc(pkg)}">${icon("back", 16)} ${esc(title)}</a>
<section class="ready"${autostart ? ` data-autostart="/file/${esc(pkg)}/${esc(code)}"` : ""}>
  <h1 class="page-title">${esc(title)} ${esc(version)} is ready</h1>
  <div class="cta">
    <a class="btn btn-primary btn-lg" href="/file/${esc(pkg)}/${esc(code)}" rel="nofollow">${icon("download")} Download APK</a>
    <span class="muted">${fmt(build.apkSize)}</span>
  </div>
  ${signature}
  ${obb}
</section>
<script src="/build.js" defer></script>`,
  );
}

export function aboutPage(fingerprint: string): string {
  return layout(
    "How it works · apk.yiin.lt",
    `<article class="prose">
<h1 class="page-title">How it works</h1>
<p>apk.yiin.lt is a plain front end for apkpure.net. It reads app pages and download links from apkpure and shows them without ads.</p>
<h2>Plain APKs</h2>
<p>When apkpure has a plain APK for a version, the server passes the file through unchanged. It keeps the developer's signature, so it installs over a Play Store copy and updates normally.</p>
<h2 id="signature">Bundles</h2>
<p>Many apps only ship as bundles (XAPK). A bundle holds a base APK plus parts for CPU type, screen density, language and game assets. Android cannot install a bundle from a file manager.</p>
<p>When a bundle holds one APK, the server hands out that APK unchanged, with the developer's signature. When it holds several, the server merges them into one APK with <a href="https://github.com/REAndroid/APKEditor">APKEditor</a>. A merge changes the file, so the developer's signature no longer fits. The server signs merged APKs with its own key:</p>
<p class="fingerprint"><span class="muted">SHA-256</span><br><code>${esc(fingerprint || "not ready")}</code></p>
<p>What this means for you:</p>
<ul>
<li>Uninstall a Play Store copy first. Android refuses to replace an app that carries a different signature.</li>
<li>Later merged versions use the same key, so they install over each other.</li>
<li>The Play Store cannot update a merged app. Come back here for new versions.</li>
<li>Some older games keep their data in separate OBB files. The server hands out those files too, with steps to copy them from a computer.</li>
</ul>
<h2>Privacy</h2>
<p>The site sets no cookies and runs no analytics. Icons and screenshots load from apkpure's image server.</p>
</article>`,
  );
}

export function errorPage(status: number, message: string, q?: string): string {
  return layout(
    `${status} · apk.yiin.lt`,
    `<div class="empty"><h1 class="page-title">${status === 404 ? "Not found" : "Something went wrong"}</h1><p>${esc(message)}</p><p><a href="/">Go to search</a></p></div>`,
    { q },
  );
}
