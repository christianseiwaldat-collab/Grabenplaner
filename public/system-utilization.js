(function (root) {
  "use strict";
  const RANGES = Object.freeze([1, 6, 24, 72, 168, 720, 2160, 4320]);
  const RANGE_LABELS = ["1 Stunde", "6 Stunden", "1 Tag", "3 Tage", "1 Woche", "1 Monat (30 Tage)", "3 Monate (90 Tage)", "180 Tage"];
  const RANGE_SHORT = ["1 Std.", "6 Std.", "1 T", "3 T", "1 W", "1 M", "3 M", "180 T"];
  const percent = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
  const stamp = value => typeof value === "string" ? Date.parse(value) : NaN;
  const escape = value => String(value ?? "").replace(/[&<>"']/gu, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const number = value => new Intl.NumberFormat("de-AT", { maximumFractionDigits: 1 }).format(value);
  let serial = 0;

  function buildSeries(history, kind) {
    const result = { segments: [], summary: null };
    const from = stamp(history?.from), to = stamp(history?.to);
    if (!["cpu", "memory"].includes(kind) || history?.integrityVerified === false || !Number.isFinite(from) || !Number.isFinite(to) || from >= to || !Array.isArray(history.points) || history.points.length > 1200) return result;
    let segment = [], previousUntil = from, sum = 0, count = 0, minimum = Infinity, maximum = 0;
    const flush = () => { if (segment.length) result.segments.push(segment); segment = []; };
    for (const point of history.points) {
      const at = stamp(point?.at), until = stamp(point?.until), value = point?.[kind];
      if (!Number.isFinite(at) || !Number.isFinite(until) || at < previousUntil || at < from || until <= at || until > to) { flush(); continue; }
      if (at > previousUntil) flush();
      previousUntil = until;
      const samples = point.sampleCount, measured = value?.count ?? samples;
      const valid = point.isGap !== true && Number.isSafeInteger(samples) && samples > 0 && Number.isSafeInteger(measured) && measured > 0 && measured <= samples
        && percent(value?.avg) && percent(value?.min) && percent(value?.max) && value.min <= value.avg && value.avg <= value.max;
      if (!valid) { flush(); continue; }
      const hasGap = point.hasGap === true || measured < samples;
      if (hasGap) flush();
      segment.push({ at, until, avg: value.avg, min: value.min, max: value.max, count: measured });
      sum += value.avg * measured; count += measured; minimum = Math.min(minimum, value.min); maximum = Math.max(maximum, value.max);
      if (hasGap) flush();
    }
    flush();
    if (count) result.summary = { count, avg: sum / count, min: minimum, max: maximum };
    return result;
  }

  function dialIndex(clientX, clientY, rect, count, current) {
    if (!Number.isInteger(count) || count < 2 || !rect || ![clientX, clientY, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return current;
    const x = clientX - rect.left - rect.width / 2, y = clientY - rect.top - rect.height / 2;
    if (Math.hypot(x, y) < 10) return current;
    const angle = Math.atan2(x, -y) * 180 / Math.PI;
    if (Math.abs(angle) > 135 + 1e-8) return current;
    return Math.max(0, Math.min(count - 1, Math.round((angle + 135) / 270 * (count - 1))));
  }

  function knob(count, fixed = false) {
    return `<svg viewBox="0 0 116 116" aria-hidden="true"><circle class="gp-utilization-dial-outer" cx="58" cy="58" r="51"/>${Array.from({ length: count }, (_, index) => `<path class="gp-utilization-dial-tick" d="M58 9v7" transform="rotate(${index * 270 / (count - 1) - 135} 58 58)"/>`).join("")}<circle class="gp-utilization-dial-face" cx="58" cy="58" r="36"/><circle class="gp-utilization-dial-inner" cx="58" cy="58" r="27"/><g class="gp-utilization-dial-pointer"${fixed ? ' style="--dial-angle:35deg"' : ""}><path d="M55 35v-7h6v7Z"/><circle cx="58" cy="58" r="3"/></g></svg>`;
  }

  function validHistory(value, hours) {
    return value && value.schemaVersion === 1 && value.scope === "host" && value.intervalSeconds === 10 && RANGES.includes(hours) && value.hours === hours
      && ["ready", "warming-up", "stale", "unavailable"].includes(value.status) && Number.isFinite(stamp(value.generatedAt)) && Number.isFinite(stamp(value.from)) && Number.isFinite(stamp(value.to))
      && stamp(value.to) > stamp(value.from) && stamp(value.to) - stamp(value.from) <= hours * 3600000 + 1000
      && Number.isFinite(value.resolutionSeconds) && value.resolutionSeconds > 0 && Array.isArray(value.points) && value.points.length <= 1200;
  }

  function mount(host, { api, isActive = () => true, onSnapshot = () => {} }) {
    const doc = host.ownerDocument, win = doc.defaultView, id = `gp-utilization-${++serial}`;
    let history = null, hours = 24, wanted = false, active = false, actorKey = null, destroyed = false, generation = 0;
    let controller = null, timer = null, loading = false, readError = false, pending = null, followup = false, drag = null, preview = null, plotWidth = 760, selectedIndex = -1;
    host.innerHTML = `<section class="gp-utilization" aria-labelledby="${id}-title" aria-live="off" data-state="empty">
      <span class="gp-utilization-screw gp-utilization-nw" aria-hidden="true"></span><span class="gp-utilization-screw gp-utilization-ne" aria-hidden="true"></span><span class="gp-utilization-screw gp-utilization-sw" aria-hidden="true"></span><span class="gp-utilization-screw gp-utilization-se" aria-hidden="true"></span>
      <header class="gp-utilization-heading"><div><p class="gp-utilization-caption">DER PAPIERSTREIFEN DER MASCHINEN</p><h2 id="${id}-title">CPU und Arbeitsspeicher im Verlauf</h2></div><span class="gp-utilization-model" aria-hidden="true">GP · SYSTEM</span></header>
      <div class="gp-utilization-legend"><span data-series="cpu">CPU · Prozessoren</span><span data-series="memory">RAM · Arbeitsspeicher</span><small>Linie: Mittelwert · Band: Minimum–Maximum · Lücken bleiben offen</small></div>
      <div class="gp-utilization-paper"><svg class="gp-utilization-chart" role="img" aria-describedby="${id}-summary" preserveAspectRatio="none"></svg></div>
      <div class="gp-utilization-summary" id="${id}-summary"></div>
      <div class="gp-utilization-inspector"><label for="${id}-point">Messpunkt erkunden</label><input id="${id}-point" data-utilization-point type="range" min="0" max="0" value="0" step="1" disabled /><output class="gp-utilization-inspection" for="${id}-point"></output></div>
      <div class="gp-utilization-console">
        <div class="gp-utilization-control"><div class="gp-utilization-dial-wrap"><div class="gp-utilization-fixed-dial" aria-hidden="true">${knob(6, true)}</div><span class="gp-utilization-readout">10 s</span></div><div><h3>Messtakt</h3><p>Alle 10 Sekunden am Server aufgezeichnet, auch wenn das System-Center geschlossen ist.</p><small>Die Aufzeichnung beginnt mit dieser Version. Frühere Werte werden nicht ergänzt.</small></div></div>
        <div class="gp-utilization-control"><div class="gp-utilization-dial-wrap"><button class="gp-utilization-dial" type="button" role="slider" aria-valuemin="0" aria-valuemax="7" aria-labelledby="${id}-range-label">${knob(8)}</button><output class="gp-utilization-range-readout gp-utilization-readout"></output></div><div><h3 id="${id}-range-label">Zeitfenster</h3><p>Bis zu 180 Tage. Längere Zeitfenster fassen Messwerte zusammen.</p><div class="gp-utilization-choices" role="group" aria-labelledby="${id}-range-label">${RANGES.map((value, index) => `<button type="button" data-utilization-hours="${value}" aria-pressed="false" aria-label="${RANGE_LABELS[index]}">${RANGE_SHORT[index]}</button>`).join("")}</div></div></div>
      </div>
      <footer class="gp-utilization-footer"><p class="gp-utilization-status" role="status"></p><button type="button" class="gp-utilization-refresh">Neu ablesen</button></footer>
    </section>`;
    const $ = selector => host.querySelector(selector), panel = $(".gp-utilization"), dial = $(".gp-utilization-dial"), chart = $(".gp-utilization-chart"), pointControl = $("[data-utilization-point]");
    const timestamp = value => new Intl.DateTimeFormat("de-AT", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
    function setText(selector, value) { const node = $(selector); if (node.textContent !== value) node.textContent = value; }
    function draw() {
      const series = ["cpu", "memory"].map(kind => [kind, buildSeries(history, kind)]), width = Math.max(250, plotWidth), left = width < 430 ? 35 : 46, right = width - 13, top = 25, bottom = 244;
      const from = stamp(history?.from), to = stamp(history?.to), usable = Number.isFinite(from) && Number.isFinite(to) && to > from;
      const x = value => left + (value - from) / (to - from) * (right - left), y = value => bottom - value / 100 * (bottom - top), n = value => Number(value.toFixed(2));
      let markup = `<title>${escape("CPU und Arbeitsspeicher: 0 bis 100 Prozent. " + RANGE_LABELS[RANGES.indexOf(history?.hours ?? hours)])}</title>`;
      markup += [0, 25, 50, 75, 100].map(value => `<path class="gp-utilization-grid" d="M${left} ${y(value)}H${right}"/><text class="gp-utilization-axis" x="${left - 8}" y="${y(value) + 4}" text-anchor="end">${value}</text>`).join("");
      markup += `<text class="gp-utilization-axis" x="${left}" y="14">%</text>`;
      const known = series.some(([, values]) => values.summary);
      if (usable) {
        for (const [kind, values] of series) for (const segment of values.segments) {
          const center = point => x((point.at + point.until) / 2);
          if (segment.length === 1) {
            const point = segment[0], span = Math.min(6, Math.max(1.5, x(point.until) - x(point.at)));
            markup += `<rect class="gp-utilization-spread" data-series="${kind}" x="${n(center(point) - span / 2)}" y="${n(y(point.max))}" width="${n(span)}" height="${n(Math.max(.8, y(point.min) - y(point.max)))}"/><path class="gp-utilization-mean" data-series="${kind}" data-points="1" d="M${n(center(point) - span / 2)} ${n(y(point.avg))}h${n(span)}"/>`;
          } else {
            const upper = segment.map(point => `${n(center(point))},${n(y(point.max))}`), lower = [...segment].reverse().map(point => `${n(center(point))},${n(y(point.min))}`);
            markup += `<polygon class="gp-utilization-spread" data-series="${kind}" points="${upper.concat(lower).join(" ")}"/><path class="gp-utilization-mean" data-series="${kind}" data-points="${segment.length}" d="${segment.map((point, index) => `${index ? "L" : "M"}${n(center(point))} ${n(y(point.avg))}`).join("")}"/>`;
          }
        }
        const ticks = width < 430 ? [from, to] : [from, (from + to) / 2, to];
        const format = new Intl.DateTimeFormat("de-AT", history.hours <= 24 ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" });
        markup += ticks.map((value, index) => `<text class="gp-utilization-axis" x="${n(x(value))}" y="274" text-anchor="${index === 0 ? "start" : index === ticks.length - 1 ? "end" : "middle"}">${escape(format.format(new Date(value)))}</text>`).join("");
      }
      if (!known) markup += `<text class="gp-utilization-empty" x="${(left + right) / 2}" y="134" text-anchor="middle">${loading ? "Messverlauf wird geladen …" : "Noch keine Messwerte"}</text>`;
      const selected = history?.points?.[selectedIndex], selectedAt = stamp(selected?.at), selectedUntil = stamp(selected?.until);
      if (usable && known && Number.isFinite(selectedAt) && Number.isFinite(selectedUntil) && selectedAt >= from && selectedUntil <= to) markup += `<path class="gp-utilization-cursor" d="M${n(x((selectedAt + selectedUntil) / 2))} ${top}V${bottom}"/>`;
      chart.setAttribute("viewBox", `0 0 ${width} 290`); chart.innerHTML = markup;
      $(".gp-utilization-summary").innerHTML = series.map(([kind, values]) => `<p data-series="${kind}"><strong>${kind === "cpu" ? "CPU" : "RAM"}</strong> ${values.summary ? `Ø ${number(values.summary.avg)} % <span>· Spitze ${number(values.summary.max)} % · Minimum ${number(values.summary.min)} %</span>` : "Noch keine gültigen Messwerte"}</p>`).join("");
      return known;
    }
    function inspect() {
      const points = history?.integrityVerified === false ? [] : history?.points || [], point = points[selectedIndex];
      pointControl.disabled = !active || !points.length;
      pointControl.max = String(Math.max(0, points.length - 1)); pointControl.value = String(Math.max(0, selectedIndex));
      if (!point) { setText(".gp-utilization-inspection", "Sobald Messwerte vorliegen, lassen sich einzelne Zeitpunkte hier ablesen."); pointControl.removeAttribute("aria-valuetext"); return; }
      const at = stamp(point.at), until = stamp(point.until);
      const time = Number.isFinite(at) && Number.isFinite(until) ? `${timestamp(point.at)}–${new Intl.DateTimeFormat("de-AT", { timeStyle: "medium" }).format(new Date(until))}` : "Ungültiger Messzeitpunkt";
      const values = ["cpu", "memory"].map(kind => {
        const value = point[kind], samples = point.sampleCount, measured = value?.count ?? samples;
        const valid = point.isGap !== true && Number.isSafeInteger(samples) && samples > 0 && Number.isSafeInteger(measured) && measured > 0 && measured <= samples && percent(value?.avg) && percent(value?.min) && percent(value?.max) && value.min <= value.avg && value.avg <= value.max;
        return `${kind === "cpu" ? "CPU" : "RAM"}: ${valid ? `${number(value.avg)} % (${number(value.min)}–${number(value.max)} %${point.hasGap || measured < samples ? "; Messlücke im Raster" : ""})` : "keine Messung"}`;
      }).join(" · ");
      const text = `${time} · ${values}`; setText(".gp-utilization-inspection", text); pointControl.setAttribute("aria-valuetext", text);
    }
    function paintRange(value) {
      const index = RANGES.indexOf(value); dial.style.setProperty("--dial-angle", `${index * 270 / (RANGES.length - 1) - 135}deg`);
      dial.setAttribute("aria-valuenow", String(index)); dial.setAttribute("aria-valuetext", RANGE_LABELS[index]);
      setText(".gp-utilization-range-readout", RANGE_SHORT[index]);
      for (const button of host.querySelectorAll("[data-utilization-hours]")) button.setAttribute("aria-pressed", String(Number(button.dataset.utilizationHours) === value));
    }
    function render() {
      host.hidden = !active; panel.setAttribute("aria-busy", String(loading)); paintRange(preview ?? hours);
      dial.disabled = !active; for (const button of host.querySelectorAll("[data-utilization-hours]")) button.disabled = !active;
      $(".gp-utilization-refresh").disabled = !active || loading;
      const known = draw(), stale = readError || history?.status === "stale" || history?.status === "unavailable" || history?.integrityVerified === false || history?.persistence?.writeFailed === true, switching = loading && history && history.hours !== hours;
      inspect();
      panel.dataset.state = switching ? "loading" : stale ? "stale" : !history ? loading ? "loading" : "empty" : known ? "ready" : "empty";
      panel.dataset.hours = String(hours);
      const readAt = Number.isFinite(stamp(history?.generatedAt)) ? timestamp(history.generatedAt) : Number.isFinite(stamp(history?.to)) ? timestamp(history.to) : null;
      const status = switching ? `Zeitfenster wird geladen · angezeigt bleibt ${RANGE_LABELS[RANGES.indexOf(history.hours)]} vom ${readAt}.`
        : readError ? history ? `Verlauf nicht aktualisiert · letzter erfolgreicher Stand: ${readAt}.` : "Der Messverlauf ist derzeit nicht erreichbar."
        : !history ? loading ? "Messverlauf wird geladen …" : "Noch keine Messwerte aufgezeichnet."
        : `Abgelesen: ${readAt} · Raster: ${number(history.resolutionSeconds)} s${history.integrityVerified === false ? " · Gespeicherter Messverlauf ist nicht verifizierbar." : history.persistence?.writeFailed === true ? " · Aktuelle Messwerte konnten nicht gespeichert werden." : stale ? " · Aufzeichnung derzeit nicht aktuell." : !known ? " · Der Papierstreifen füllt sich nach und nach." : ""}`;
      setText(".gp-utilization-status", status); $(".gp-utilization-status").classList.toggle("error", Boolean(stale));
    }
    function cancel() { generation++; controller?.abort(); clearTimeout(timer); timer = null; loading = false; followup = false; }
    function allowed() { return !destroyed && wanted && Boolean(isActive()) && doc.visibilityState !== "hidden"; }
    function schedule() {
      clearTimeout(timer); timer = null;
      if (active && allowed()) timer = setTimeout(() => { timer = null; void load(); }, 10000);
    }
    async function load() {
      if (!active || !allowed()) return;
      clearTimeout(timer); timer = null;
      if (pending) { followup = true; return; }
      const token = generation, chosenHours = hours, readController = new AbortController(); controller = readController; loading = true; render();
      let timedOut = false, onAbort;
      const interrupted = new Promise((resolve, reject) => { onAbort = () => reject(Object.assign(new Error("Utilization read aborted"), { name: "AbortError" })); readController.signal.addEventListener("abort", onAbort, { once: true }); });
      const timeout = setTimeout(() => { timedOut = true; readController.abort(); }, 9000);
      const network = Promise.resolve().then(() => api(`/api/portal/v1/system-center/utilization?hours=${chosenHours}`, { signal: readController.signal }));
      const operation = Promise.race([network, interrupted]); pending = operation;
      try {
        const value = await operation;
        if (token !== generation || !active || !allowed() || chosenHours !== hours) return;
        if (!validHistory(value, chosenHours)) throw new Error("Invalid utilization history");
        const selectedAt = history?.points?.[selectedIndex]?.at;
        history = value; readError = false;
        const retained = selectedAt ? value.points.findIndex(point => point.at === selectedAt) : -1;
        selectedIndex = retained >= 0 ? retained : value.points.length - 1;
        onSnapshot(value);
      } catch (error) {
        if (token !== generation || !active) return;
        if ([401, 403].includes(error.status)) { wanted = false; active = false; drag?.cancel(); cancel(); history = null; selectedIndex = -1; readError = false; render(); }
        else if (error.name !== "AbortError" || timedOut) readError = true;
      }
      finally {
        clearTimeout(timeout); readController.signal.removeEventListener("abort", onAbort);
        if (pending === operation) { pending = null; controller = null; }
        if (token === generation) { loading = false; render(); }
        if (active && allowed()) {
          if (followup) { followup = false; void load(); }
          else if (token === generation) schedule();
        }
      }
    }
    function choose(value) {
      if (!active || !allowed() || !RANGES.includes(value) || value === hours) { preview = null; paintRange(hours); return; }
      hours = value; preview = null; cancel(); render(); void load();
    }
    function onClick(event) {
      const choice = event.target.closest("[data-utilization-hours]");
      if (choice && !choice.disabled) choose(Number(choice.dataset.utilizationHours));
      if (event.target.closest(".gp-utilization-refresh") && !$(".gp-utilization-refresh").disabled) void load();
      if (event.target.closest(".gp-utilization-chart") && history?.integrityVerified !== false && history?.points?.length && active && allowed()) {
        const rect = chart.getBoundingClientRect(), left = Math.max(250, plotWidth) < 430 ? 35 : 46, right = Math.max(250, plotWidth) - 13;
        const relative = (event.clientX - rect.left) / rect.width * Math.max(250, plotWidth), at = stamp(history.from) + Math.max(0, Math.min(1, (relative - left) / (right - left))) * (stamp(history.to) - stamp(history.from));
        let best = Infinity; history.points.forEach((point, index) => { const distance = Math.abs((stamp(point.at) + stamp(point.until)) / 2 - at); if (Number.isFinite(distance) && distance < best) { best = distance; selectedIndex = index; } });
        inspect(); draw();
      }
    }
    function onInput(event) { if (event.target === pointControl && !pointControl.disabled) { selectedIndex = Number(pointControl.value); inspect(); draw(); } }
    function onKey(event) {
      if (event.target !== dial || dial.disabled || !["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const index = RANGES.indexOf(hours), next = event.key === "Home" ? 0 : event.key === "End" ? RANGES.length - 1 : Math.max(0, Math.min(RANGES.length - 1, index + (["ArrowRight", "ArrowUp"].includes(event.key) ? 1 : -1)));
      choose(RANGES[next]);
    }
    function onPointer(event) {
      if (event.target.closest(".gp-utilization-dial") !== dial || dial.disabled || event.button !== 0 || drag || !allowed()) return;
      event.preventDefault(); dial.focus({ preventScroll: true }); const rect = dial.getBoundingClientRect(); let index = RANGES.indexOf(hours);
      const controller = new AbortController(), options = { signal: controller.signal };
      const update = move => { index = dialIndex(move.clientX, move.clientY, rect, RANGES.length, index); preview = RANGES[index]; paintRange(preview); };
      const finish = aborted => {
        if (!drag) return; controller.abort(); drag = null; if (dial.hasPointerCapture(event.pointerId)) dial.releasePointerCapture(event.pointerId);
        preview = null; if (aborted) paintRange(hours); else choose(RANGES[index]);
      };
      drag = { cancel: () => finish(true) }; dial.setPointerCapture(event.pointerId); update(event);
      dial.addEventListener("pointermove", move => { if (move.pointerId === event.pointerId) update(move); }, options);
      dial.addEventListener("pointerup", up => { if (up.pointerId === event.pointerId) finish(false); }, options);
      dial.addEventListener("pointercancel", () => finish(true), options); dial.addEventListener("lostpointercapture", () => finish(true), options);
      doc.addEventListener("keydown", key => { if (key.key === "Escape") { key.preventDefault(); finish(true); } }, options);
    }
    function updateActivity() {
      const next = allowed(); if (next === active) return;
      active = next; drag?.cancel(); cancel(); render(); if (active) void load();
    }
    host.addEventListener("click", onClick); host.addEventListener("input", onInput); host.addEventListener("keydown", onKey); host.addEventListener("pointerdown", onPointer); doc.addEventListener("visibilitychange", updateActivity);
    const observer = win?.ResizeObserver ? new win.ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width > 0 && Math.abs(width - plotWidth) >= 1) { plotWidth = width; draw(); } }) : null;
    observer?.observe($(".gp-utilization-paper")); render();
    return {
      synchronize(input = {}) {
        if (destroyed) return;
        const nextKey = input.actorKey ?? null;
        if (nextKey !== actorKey) { drag?.cancel(); cancel(); history = null; selectedIndex = -1; readError = false; actorKey = nextKey; active = false; }
        wanted = input.active === true; updateActivity(); if (!active) render();
      },
      refresh() { if (active && allowed()) void load(); },
      destroy() { if (destroyed) return; destroyed = true; wanted = false; active = false; drag?.cancel(); cancel(); history = null; observer?.disconnect(); host.removeEventListener("click", onClick); host.removeEventListener("input", onInput); host.removeEventListener("keydown", onKey); host.removeEventListener("pointerdown", onPointer); doc.removeEventListener("visibilitychange", updateActivity); host.replaceChildren(); },
    };
  }
  const exported = { RANGES, buildSeries, dialIndex, validHistory, mount };
  root.GpSystemUtilization = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})(typeof globalThis !== "undefined" ? globalThis : this);
