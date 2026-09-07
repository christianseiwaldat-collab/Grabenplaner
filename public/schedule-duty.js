(function initializeScheduleDuty(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GPScheduleDuty = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createScheduleDuty() {
  "use strict";

  const PRIMARY_POSITION_IDS = new Set(["teamleitung", "fl-stellvertretung"]);
  const DUTY_CODES = Object.freeze(["", "branch_supervision", "department", "general"]);
  const PLANNING_DAY_COUNT = 7;
  const MANUAL_PLANNING_HOURS = Object.freeze({ open: true, start: "07:00", end: "23:00" });
  const DEFAULT_DUTY_COLORS = Object.freeze({ FL: "#285366", HW: "#426D5B", FO: "#426D5B", AG: "#52636B" });

  function manualPlanningHours() { return MANUAL_PLANNING_HOURS; }

  function normalizeScheduleDutyColors(value, { strict = false } = {}) {
    let candidate = value;
    if (!strict && typeof candidate === "string") {
      try { candidate = JSON.parse(candidate); } catch { candidate = null; }
    }
    const validObject = candidate && typeof candidate === "object" && !Array.isArray(candidate);
    if (strict && (!validObject || Object.keys(candidate).some(key => !Object.hasOwn(DEFAULT_DUTY_COLORS, key)))) {
      throw new Error("Bitte ausschließlich Farben für FL, HW, FO und AG übermitteln.");
    }
    const colors = { ...DEFAULT_DUTY_COLORS };
    for (const code of Object.keys(colors)) {
      const color = validObject ? candidate[code] : undefined;
      if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) colors[code] = color.toUpperCase();
      else if (strict) throw new Error(`Bitte für ${code} eine RGB-Farbe im Format #RRGGBB angeben.`);
    }
    return colors;
  }

  function scheduleDutyColor(code, value) {
    return normalizeScheduleDutyColors(value)[code] || DEFAULT_DUTY_COLORS.AG;
  }

  function scheduleDutyTextColor(background) {
    const hex = /^#[0-9a-f]{6}$/i.test(String(background)) ? background : DEFAULT_DUTY_COLORS.AG;
    const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#FFFFFF";
  }

  function scheduleEmployeeInitials(employee = {}) {
    const person = typeof employee === "string" ? { full_name: employee } : (employee || {});
    const words = value => String(value || "").trim().split(/\s+/u).filter(Boolean);
    const first = person.first_name ?? person.firstName;
    const last = person.last_name ?? person.lastName;
    let parts = first && last ? [words(first)[0], words(last).at(-1)] : [];
    if (!parts.length) {
      const fullName = String(person.full_name ?? person.fullName ?? person.nickname ?? "").trim();
      const commaParts = fullName.split(",");
      if (commaParts.length === 2) parts = [words(commaParts[1])[0], words(commaParts[0]).at(-1)];
      else {
        parts = words(fullName);
        const givenName = words(person.nickname)[0];
        const matchesLast = parts.length > 1 && givenName
          && parts.at(-1).toLocaleLowerCase("de-AT") === givenName.toLocaleLowerCase("de-AT");
        if (matchesLast) parts = [parts.at(-1), parts[0]];
        else if (parts.length > 1) parts = [parts[0], parts.at(-1)];
      }
    }
    return parts.filter(Boolean).map(part => Array.from(part)[0]).join("").toLocaleUpperCase("de-AT") || "?";
  }

  function defaultScheduleDutyCode(employee = {}) {
    const positionId = String(employee?.position_id ?? employee?.positionId ?? "");
    return PRIMARY_POSITION_IDS.has(positionId) ? "branch_supervision" : "general";
  }

  function departmentDutyCode(label) {
    const normalized = String(label || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
    if (normalized === "HARDWARE") return "HW";
    if (normalized === "FOTOWELT") return "FO";
    const words = normalized.match(/[A-Z0-9]+/g) || [];
    if (!words.length) return "AB";
    return words.length > 1 ? words.slice(0, 3).map((word) => word[0]).join("") : words[0].slice(0, 2);
  }

  // Presentation only: a selected duty never grants a qualification or an access right.
  // A real, explicitly assigned department takes precedence over the legacy role default.
  function resolveScheduleDuty(shift = {}, employee = {}, departments = []) {
    const storedCode = String(shift?.duty_code ?? shift?.dutyCode ?? "");
    const departmentId = shift?.department_id ?? shift?.departmentId ?? "";
    const hasDepartment = departmentId !== "" && departmentId !== null && departmentId !== undefined;
    const kind = storedCode || (hasDepartment ? "department" : defaultScheduleDutyCode(employee));
    if (kind === "branch_supervision") {
      return { code: "FL", label: "Filialaufsicht", kind, departmentId: "" };
    }
    if (kind === "department" && hasDepartment) {
      const department = (Array.isArray(departments) ? departments : []).find((entry) => String(entry.id) === String(departmentId));
      const label = String(shift?.department_name ?? shift?.departmentName ?? department?.name ?? "").trim() || `Abteilung ${departmentId}`;
      return { code: departmentDutyCode(label), label, kind, departmentId };
    }
    return { code: "AG", label: "Allgemeiner Dienst", kind: "general", departmentId: "" };
  }

  return Object.freeze({ DUTY_CODES, defaultScheduleDutyCode, departmentDutyCode, resolveScheduleDuty,
    PLANNING_DAY_COUNT, manualPlanningHours, DEFAULT_DUTY_COLORS, normalizeScheduleDutyColors,
    scheduleDutyColor, scheduleDutyTextColor, scheduleEmployeeInitials });
}));
