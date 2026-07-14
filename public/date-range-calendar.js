(function attachDateRangeCalendar(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.GrabenplanerDateRangeCalendar = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createDateRangeCalendarModule() {
  "use strict";

  function isoDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function dateFromIso(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? new Date(`${value}T12:00:00`) : null;
  }

  function monthStart(value) {
    const date = dateFromIso(value) || new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
  }

  function shiftMonth(value, amount) {
    const date = dateFromIso(monthStart(value));
    date.setMonth(date.getMonth() + Number(amount || 0));
    return monthStart(isoDate(date));
  }

  function addIsoDays(value, amount) {
    const date = dateFromIso(value);
    if (!date) return "";
    date.setDate(date.getDate() + Number(amount || 0));
    return isoDate(date);
  }

  function selectionMaximum(selection = {}) {
    if (!selection.start || selection.end) return selection.maxStart || selection.max || "";
    const candidates = [selection.maxEnd || selection.max || ""];
    if (Number.isFinite(selection.maxEndDays)) {
      candidates.push(addIsoDays(selection.start, selection.maxEndDays));
    }
    return candidates.filter(Boolean).sort()[0] || "";
  }

  function selectionCanCommit(selection = {}) {
    return Boolean(selection.start && (selection.end || (selection.allowOpenEnd && selection.openEndSelected)));
  }

  function calendarDays(value) {
    const first = dateFromIso(monthStart(value));
    const offset = (first.getDay() + 6) % 7;
    const cursor = new Date(first);
    cursor.setDate(cursor.getDate() - offset);
    return Array.from({ length: 42 }, () => {
      const result = isoDate(cursor);
      cursor.setDate(cursor.getDate() + 1);
      return result;
    });
  }

  function selectRangeDate(selection, value) {
    const date = String(value || "");
    const current = { start: String(selection?.start || ""), end: String(selection?.end || "") };
    if (!date) return current;
    if (!current.start || current.end) return { start: date, end: "" };
    if (date < current.start) return { start: date, end: "" };
    return { start: current.start, end: date };
  }

  function displayDate(value) {
    const date = dateFromIso(value);
    return date ? new Intl.DateTimeFormat("de-AT", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date) : "";
  }

  function rangeLabel(start, end, openLabel = "Ende offen") {
    if (!start) return "Zeitraum auswählen";
    return end ? `${displayDate(start)} – ${displayDate(end)}` : `${displayDate(start)} · ${openLabel}`;
  }

  function createDateRangeCalendar(options = {}) {
    const dialog = options.dialog;
    const grid = options.grid;
    const title = options.title;
    const summary = options.summary;
    const startText = options.startText;
    const endText = options.endText;
    const applyButton = options.applyButton;
    const openEndButton = options.openEndButton;
    const openEndCheckbox = options.openEndCheckbox;
    if (!dialog || !grid || !title || (!summary && (!startText || !endText)) || !applyButton || (!openEndButton && !openEndCheckbox)) {
      throw new Error("Der Zeitraumskalender ist unvollständig eingebunden.");
    }
    let state = null;

    function render() {
      if (!state) return;
      const cursor = dateFromIso(state.month);
      title.textContent = new Intl.DateTimeFormat("de-AT", { month: "long", year: "numeric" }).format(cursor);
      const currentMonth = state.month.slice(0, 7);
      const today = isoDate(new Date());
      const maximum = selectionMaximum(state);
      grid.innerHTML = calendarDays(state.month).map((date) => {
        const disabled = (state.min && date < state.min) || (maximum && date > maximum);
        const classes = ["date-range-day", date.slice(0, 7) === currentMonth ? "" : "outside"];
        if (date === state.start) classes.push("range-start");
        if (date === state.end) classes.push("range-end");
        if (date === state.start || date === state.end) classes.push("selected");
        if (state.start && state.end && date > state.start && date < state.end) classes.push("in-range");
        if (date === today) classes.push("today");
        return `<button type="button" data-range-date="${date}" class="${classes.filter(Boolean).join(" ")}" ${disabled ? "disabled" : ""} aria-label="${displayDate(date)}">${Number(date.slice(-2))}</button>`;
      }).join("");
      if (summary) {
        summary.textContent = state.start && !state.end && !state.openEndSelected
          ? `${displayDate(state.start)} · Ende auswählen`
          : rangeLabel(state.start, state.end, state.openLabel);
      }
      if (startText) startText.textContent = state.start ? displayDate(state.start) : "Noch nicht gewählt";
      if (endText) {
        endText.textContent = state.end
          ? displayDate(state.end)
          : state.start && state.openEndSelected ? state.openLabel : state.start ? "Ende auswählen" : "Noch nicht gewählt";
      }
      applyButton.disabled = !selectionCanCommit(state);
      openEndButton?.classList.toggle("hidden", !state.allowOpenEnd);
      if (openEndCheckbox) {
        openEndCheckbox.closest("label")?.classList.toggle("hidden", !state.allowOpenEnd);
        openEndCheckbox.checked = Boolean(state.allowOpenEnd && state.openEndSelected);
        openEndCheckbox.disabled = !state.start;
      }
    }

    function open(config = {}) {
      const allowOpenEnd = config.allowOpenEnd !== false;
      state = {
        start: String(config.start || ""),
        end: String(config.end || ""),
        min: String(config.min || ""),
        max: String(config.max || ""),
        maxStart: String(config.maxStart || ""),
        maxEnd: String(config.maxEnd || ""),
        maxEndDays: Number.isFinite(Number(config.maxEndDays)) ? Math.max(0, Number(config.maxEndDays)) : null,
        allowOpenEnd,
        openEndSelected: Boolean(allowOpenEnd && config.start && !config.end),
        openLabel: String(config.openLabel || "Ende offen"),
        month: monthStart(config.start || config.month || isoDate(new Date())),
        onCommit: typeof config.onCommit === "function" ? config.onCommit : () => {},
      };
      render();
      dialog.showModal();
    }

    grid.addEventListener("click", (event) => {
      const button = event.target.closest("[data-range-date]");
      if (!button || button.disabled || !state) return;
      const startingFresh = !state.start || Boolean(state.end) || button.dataset.rangeDate < state.start;
      const next = selectRangeDate(state, button.dataset.rangeDate);
      state.start = next.start;
      state.end = next.end;
      state.openEndSelected = next.end ? false : (startingFresh ? state.allowOpenEnd : state.openEndSelected);
      render();
    });
    options.previousButton?.addEventListener("click", () => { if (state) { state.month = shiftMonth(state.month, -1); render(); } });
    options.nextButton?.addEventListener("click", () => { if (state) { state.month = shiftMonth(state.month, 1); render(); } });
    openEndButton?.addEventListener("click", () => {
      if (!state?.start) return;
      state.end = "";
      state.openEndSelected = true;
      state.onCommit(state.start, state.end);
      dialog.close();
    });
    openEndCheckbox?.addEventListener("change", () => {
      if (!state?.start) return;
      state.openEndSelected = Boolean(openEndCheckbox.checked);
      if (state.openEndSelected) state.end = "";
      render();
    });
    const apply = (event) => {
      event?.preventDefault?.();
      if (!selectionCanCommit(state)) return;
      state.onCommit(state.start, state.end);
      dialog.close();
    };
    if (options.form) options.form.addEventListener("submit", apply);
    else applyButton.addEventListener("click", apply);
    [...dialog.querySelectorAll("[data-close-range-calendar]"), ...(options.closeButtons || [])]
      .forEach((button) => button?.addEventListener("click", () => dialog.close()));

    return Object.freeze({ open });
  }

  return Object.freeze({
    createDateRangeCalendar, calendarDays, selectRangeDate, rangeLabel, shiftMonth, selectionMaximum, selectionCanCommit,
  });
}));
