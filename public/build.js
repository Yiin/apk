// Polls the build status and updates the progress bar until the APK is ready.
// On the ready page it starts the APK download once, right after a build.
(() => {
  const ready = document.querySelector(".ready[data-autostart]");
  if (ready) {
    history.replaceState(null, "", location.pathname); // a reload must not download again
    window.location.assign(ready.dataset.autostart);
    return;
  }

  const root = document.querySelector(".build");
  if (!root) return;
  const { pkg, code } = root.dataset;
  const progress = root.querySelector(".progress");
  const bar = root.querySelector(".progress-bar");
  const status = root.querySelector(".build-status");
  const failed = root.querySelector(".build-failed");

  const mb = (n) => (n / 1e6).toFixed(1);

  function show(pct, text) {
    progress.classList.toggle("indeterminate", pct === null);
    if (pct !== null) {
      bar.style.transform = `scaleX(${pct / 100})`;
      progress.setAttribute("aria-valuenow", String(Math.round(pct)));
    }
    status.textContent = text;
  }

  async function tick() {
    let s;
    try {
      const res = await fetch(`/api/build/${pkg}/${code}`, { cache: "no-store" });
      s = await res.json();
    } catch {
      show(null, "Lost the connection. Retrying…");
      return setTimeout(tick, 3000);
    }

    switch (s.step) {
      case "queued":
        show(null, s.position > 1 ? `Waiting in line. ${s.position - 1} build(s) ahead.` : "Starting…");
        break;
      case "downloading": {
        const pct = s.total ? (s.done / s.total) * 70 : null;
        show(pct, s.total ? `Downloading bundle: ${mb(s.done)} of ${mb(s.total)} MB` : `Downloading bundle: ${mb(s.done)} MB`);
        break;
      }
      case "merging":
        show(80, "Merging the split parts into one APK…");
        break;
      case "signing":
        show(95, "Signing the APK…");
        break;
      case "done":
        show(100, "Ready.");
        window.location.replace(`/build/${pkg}/${code}?fresh=1`);
        return;
      case "failed":
        show(0, "The build stopped.");
        failed.querySelector(".reason").textContent = s.reason;
        failed.hidden = false;
        return;
      default:
        show(0, "No build runs for this version.");
        failed.querySelector(".reason").textContent = "The build is gone. Start it again.";
        failed.hidden = false;
        return;
    }
    setTimeout(tick, 1000);
  }

  tick();
})();
