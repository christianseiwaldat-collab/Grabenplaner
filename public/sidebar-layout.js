(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.GrabenplanerSidebarLayout = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const DEFAULT_WIDTH = 240, MIN_WIDTH = 200, MAX_WIDTH = 380;
  const STORAGE_KEY = "grabenplaner-sidebar-width";
  const GROUPS_STORAGE_KEY = "grabenplaner:sidebar-groups-v1:";
  const GROUP_KEYS = ["filialManagement", "planning", "vacations", "personnelAdministration", "salesAdministration", "logistics", "privacyOrganization"];

  function navigationPath(view) {
    if (["filialAdministration", "personnel", "planning", "vacations", "loans", "branchOrders"].includes(view)) {
      return ["filialManagement", ...(["planning", "vacations"].includes(view) ? [view] : [])];
    }
    if (["personnelAdministration", "requests", "timeTracking"].includes(view)) return ["personnelAdministration"];
    if (view === "logistics") return ["logistics"];
    if (view === "privacyOrganization") return ["privacyOrganization"];
    if (["salesAdministration", "salesAnalytics", "receiptSearch", "tradeInsights", "articleCatalog", "articleReport", "salesBwl", "priceLabels", "crm"].includes(view)) return ["salesAdministration"];
    return [];
  }

  // A navigation reveals every ancestor of its target. Manual disclosures of
  // other groups remain account-scoped; background renders never reopen them.
  function createGroups({ storage, account = () => "" } = {}) {
    let route = null, actor = null, expanded = new Set(), disclosures = {};
    function currentAccount() {
      try { return String(account() || "").slice(0, 240); } catch { return ""; }
    }
    function restore(nextActor) {
      actor = nextActor;
      disclosures = {};
      if (!actor || !storage) return;
      try {
        const raw = storage.getItem(GROUPS_STORAGE_KEY + encodeURIComponent(actor));
        if (!raw || raw.length > 4096) return;
        const saved = JSON.parse(raw);
        if (saved?.version !== 1 || !saved.disclosures || typeof saved.disclosures !== "object" || Array.isArray(saved.disclosures)) return;
        for (const key of GROUP_KEYS) if (typeof saved.disclosures[key] === "boolean") disclosures[key] = saved.disclosures[key];
      } catch {}
    }
    function persist() {
      if (!actor || !storage) return;
      try { storage.setItem(GROUPS_STORAGE_KEY + encodeURIComponent(actor), JSON.stringify({ version: 1, disclosures })); } catch {}
    }
    return {
      navigationPath,
      sync(nextRoute, view) {
        const nextActor = currentAccount();
        if (nextRoute === route && nextActor === actor) return false;
        if (nextActor !== actor) restore(nextActor);
        route = nextRoute;
        expanded = new Set(GROUP_KEYS.filter(key => disclosures[key] === true));
        for (const key of navigationPath(view)) expanded.add(key);
        return true;
      },
      isOpen(key) { return expanded.has(key); },
      setOpen(key, open) {
        if (!GROUP_KEYS.includes(key) || typeof open !== "boolean") return;
        const nextActor = currentAccount();
        if (nextActor !== actor) { restore(nextActor); route = null; expanded = new Set(GROUP_KEYS.filter(group => disclosures[group] === true)); }
        disclosures[key] = open;
        if (open) expanded.add(key); else expanded.delete(key);
        persist();
      },
      reset() { route = null; actor = null; expanded.clear(); disclosures = {}; },
    };
  }

  function mount({ window: win, document: doc, sidebar, handle, mobileMedia }) {
    if (!sidebar || !handle) return null;
    let preferred = DEFAULT_WIDTH, width = DEFAULT_WIDTH, drag = null;
    try {
      const stored = Number(win.localStorage.getItem(STORAGE_KEY));
      if (Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH) preferred = stored;
    } catch {}
    const scale = () => {
      const value = Number.parseFloat(win.getComputedStyle(doc.body).zoom);
      return Number.isFinite(value) && value > 0 ? value : 1;
    };
    function refreshViewport() {
      const zoom = scale();
      const viewportHeight = win.visualViewport?.height || win.innerHeight;
      const bannerHeight = Number.parseFloat(win.getComputedStyle(doc.documentElement)
        .getPropertyValue("--deployment-banner-height")) || 0;
      // CSS viewport units also change with zoom in some browser versions. Use
      // the visible viewport once, then convert to the GP's zoomed coordinates.
      doc.documentElement.style.setProperty("--sidebar-top", `${bannerHeight / zoom}px`);
      doc.documentElement.style.setProperty("--sidebar-height", `${Math.max(0, viewportHeight - bannerHeight) / zoom}px`);
      doc.documentElement.style.setProperty("--sidebar-mobile-width", `${Math.min(320, Math.max(0, win.innerWidth - 42) / zoom)}px`);
    }
    const maximum = () => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(win.innerWidth / scale() * .45)));
    const clamp = value => Math.round(Math.max(MIN_WIDTH, Math.min(maximum(), value)));
    function render(value) {
      width = clamp(value);
      doc.documentElement.style.setProperty("--sidebar-width", `${width}px`);
      handle.setAttribute("aria-valuemin", String(MIN_WIDTH));
      handle.setAttribute("aria-valuemax", String(maximum()));
      handle.setAttribute("aria-valuenow", String(width));
      handle.setAttribute("aria-valuetext", `${width} Pixel`);
    }
    function persist() {
      preferred = width;
      try { win.localStorage.setItem(STORAGE_KEY, String(preferred)); } catch {}
    }
    function finish(cancel = false) {
      if (!drag) return;
      const previous = drag;
      drag = null;
      doc.body.classList.remove("sidebar-resizing");
      if (cancel) render(preferred);
      else persist();
      if (handle.hasPointerCapture?.(previous.id)) handle.releasePointerCapture(previous.id);
    }
    function refresh() {
      finish(true);
      refreshViewport();
      render(preferred);
    }
    function onPointerDown(event) {
      if (event.button !== 0 || mobileMedia.matches || drag) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      drag = { id: event.pointerId, x: event.clientX, width, scale: scale() };
      handle.setPointerCapture(event.pointerId);
      doc.body.classList.add("sidebar-resizing");
    }
    function onPointerMove(event) {
      if (drag && event.pointerId === drag.id) render(drag.width + (event.clientX - drag.x) / drag.scale);
    }
    function onPointerUp(event) { if (drag?.id === event.pointerId) finish(); }
    function onPointerCancel(event) { if (drag?.id === event.pointerId) finish(true); }
    function onKeyDown(event) {
      if (event.key === "Escape" && drag) { event.preventDefault(); finish(true); return; }
      if (mobileMedia.matches || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      finish(true);
      const step = event.shiftKey ? 1 : 10;
      render(event.key === "Home" ? MIN_WIDTH : event.key === "End" ? maximum()
        : width + (event.key === "ArrowRight" ? step : -step));
      persist();
    }
    function resetWidth() { if (!mobileMedia.matches) { finish(true); render(DEFAULT_WIDTH); persist(); } }
    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerCancel);
    handle.addEventListener("lostpointercapture", onPointerCancel);
    handle.addEventListener("keydown", onKeyDown);
    handle.addEventListener("dblclick", resetWidth);
    win.addEventListener("resize", refresh);
    win.visualViewport?.addEventListener("resize", refresh);
    win.addEventListener("blur", () => finish(true));
    mobileMedia.addEventListener("change", refresh);
    refresh();
    return { refresh, refreshViewport };
  }
  return { navigationPath, createGroups, mount };
});
