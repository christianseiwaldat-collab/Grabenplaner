"use strict";

const PAYROLL_LAYOUTS = Object.freeze({
  daily_journal: {
    label: "Tagesjournal",
    description: "Eine Zeile je Teammitglied und Kalendertag.",
    columns: [
      ["personnelNumber", "Personalnummer", "identifier"],
      ["fullName", "Name", "text"],
      ["workDate", "Datum", "text"],
      ["locationId", "Standort", "identifier"],
      ["departmentId", "Abteilung", "identifier"],
      ["plannedMinutes", "Soll (Min.)", "number"],
      ["actualMinutes", "Ist (Min.)", "number"],
      ["breakMinutes", "Pause (Min.)", "number"],
      ["saturdayBonusMinutes", "Samstagszuschlag (Min.)", "number"],
      ["valuedMinutes", "Gewertet (Min.)", "number"],
      ["differenceMinutes", "Abweichung (Min.)", "number"],
      ["absenceCodes", "Abwesenheiten", "text"],
      ["reviewState", "Pr\u00fcfstatus", "text"],
      ["correctionState", "Korrekturstatus", "text"],
      ["issueCodes", "Hinweise", "text"],
    ],
  },
  movement_lines: {
    label: "Lohnarten",
    description: "Eine Zeile je Arbeitszeit-, Zuschlags- oder Abwesenheitsbewegung.",
    columns: [
      ["schemaVersion", "Schema", "text"],
      ["personnelNumber", "Personalnummer", "identifier"],
      ["fullName", "Name", "text"],
      ["workDate", "Datum", "text"],
      ["locationId", "Standort", "identifier"],
      ["departmentId", "Abteilung", "identifier"],
      ["lineType", "Zeilentyp", "text"],
      ["internalCode", "Interner Code", "text"],
      ["payrollCode", "Lohnart", "text"],
      ["quantityMinutes", "Menge (Min.)", "number"],
      ["quantityHours", "Menge (Std.)", "number"],
      ["quantityDays", "Menge (Tage)", "number"],
      ["factor", "Faktor", "number"],
      ["unit", "Einheit", "text"],
      ["sourceMode", "Quelle", "text"],
      ["reviewState", "Pr\u00fcfstatus", "text"],
      ["correctionState", "Korrekturstatus", "text"],
      ["issueCodes", "Hinweise", "text"],
    ],
  },
});

const defaultColumns = Object.freeze({
  daily_journal: ["personnelNumber", "fullName", "workDate", "locationId", "departmentId", "plannedMinutes", "actualMinutes", "breakMinutes", "saturdayBonusMinutes", "valuedMinutes", "differenceMinutes", "absenceCodes", "reviewState", "correctionState", "issueCodes"],
  movement_lines: ["schemaVersion", "personnelNumber", "fullName", "workDate", "locationId", "departmentId", "lineType", "internalCode", "payrollCode", "quantityMinutes", "quantityHours", "quantityDays", "factor", "unit", "sourceMode", "reviewState", "correctionState", "issueCodes"],
});

const ABSENCE_CODES = new Set([
  "vacation", "sickness", "time_off", "branch_assignment", "vocational_school", "training",
  "special_leave", "external_appointment", "team_meeting", "public_holiday", "other",
]);

function layoutColumns(layout) {
  const definition = PAYROLL_LAYOUTS[layout] || PAYROLL_LAYOUTS.daily_journal;
  return definition.columns.map(([id, label, type]) => ({ id, label, type }));
}

function normalizePayrollConfiguration(value = {}) {
  const layout = PAYROLL_LAYOUTS[value.layout] ? value.layout : "daily_journal";
  const available = new Set(layoutColumns(layout).map((column) => column.id));
  const submittedColumns = Array.isArray(value.columns) ? value.columns.map(String).filter((column) => available.has(column)) : [];
  const columns = [...new Set(submittedColumns.length ? submittedColumns : defaultColumns[layout])];
  const wageCodeMap = {};
  if (value.wageCodeMap && typeof value.wageCodeMap === "object" && !Array.isArray(value.wageCodeMap)) {
    for (const [internalCode, payrollCode] of Object.entries(value.wageCodeMap)) {
      if ((ABSENCE_CODES.has(internalCode) || ["regular_work", "saturday_bonus"].includes(internalCode))
        && /^[A-Za-z0-9._-]{1,40}$/.test(String(payrollCode || ""))) wageCodeMap[internalCode] = String(payrollCode);
    }
  }
  return {
    version: 1,
    layout,
    sourceMode: value.sourceMode === "planned" ? "planned" : "actual_reviewed",
    format: value.format === "xlsx" ? "xlsx" : "csv",
    delimiter: [";", ",", "tab"].includes(value.delimiter) ? value.delimiter : ";",
    decimalSeparator: value.decimalSeparator === "comma" ? "comma" : "dot",
    columns,
    wageCodeMap,
  };
}

function payrollCatalog() {
  return {
    layouts: Object.entries(PAYROLL_LAYOUTS).map(([id, definition]) => ({
      id,
      label: definition.label,
      description: definition.description,
      columns: layoutColumns(id),
      defaultColumns: [...defaultColumns[id]],
    })),
    sourceModes: [
      { id: "actual_reviewed", label: "Gepr\u00fcfte Ist-Zeit", description: "Nur belastbare, aktuell gepr\u00fcfte Tageswerte; offene Fehler blockieren den finalen Export." },
      { id: "planned", label: "Planwerte", description: "Dienstplan und eingetragene Abwesenheiten; als Planungs-/Vorbereitungsdatei gekennzeichnet." },
    ],
    formats: ["csv", "xlsx"],
    internalCodes: ["regular_work", "saturday_bonus", ...ABSENCE_CODES],
  };
}

function dailyJournalRow(day) {
  return {
    personnelNumber: day.personnelNumber,
    fullName: day.fullName,
    workDate: day.workDate,
    locationId: day.locationId,
    departmentId: day.departmentId || "",
    plannedMinutes: Number(day.plannedMinutes || 0),
    actualMinutes: Number(day.actualMinutes || 0),
    breakMinutes: Number(day.breakMinutes || 0),
    saturdayBonusMinutes: Number(day.saturdayBonusMinutes || 0),
    valuedMinutes: Number(day.valuedMinutes || 0),
    differenceMinutes: Number(day.differenceMinutes || 0),
    absenceCodes: (day.absences || []).map((absence) => absence.internalCode).join(", "),
    reviewState: day.reviewState,
    correctionState: day.correctionState,
    issueCodes: (day.issueCodes || []).join(", "),
  };
}

function movementBase(day, config) {
  return {
    schemaVersion: "grabenplaner-payroll-v1",
    personnelNumber: day.personnelNumber,
    fullName: day.fullName,
    workDate: day.workDate,
    locationId: day.locationId,
    departmentId: day.departmentId || "",
    sourceMode: day.sourceMode,
    reviewState: day.reviewState,
    correctionState: day.correctionState,
    issueCodes: (day.issueCodes || []).join(", "),
  };
}

function movementRow(day, config, values) {
  const quantityMinutes = Number(values.quantityMinutes || 0);
  return {
    ...movementBase(day, config),
    lineType: values.lineType,
    internalCode: values.internalCode,
    payrollCode: config.wageCodeMap[values.internalCode] || values.internalCode,
    quantityMinutes,
    quantityHours: Math.round((quantityMinutes / 60) * 100) / 100,
    quantityDays: Number(values.quantityDays || 0),
    factor: Number(values.factor || 1),
    unit: values.unit || (quantityMinutes ? "minutes" : "days"),
  };
}

function movementRows(day, config) {
  const rows = [];
  const workMinutes = day.sourceMode === "planned" ? Number(day.plannedMinutes || 0) : Number(day.actualMinutes || 0);
  if (workMinutes > 0) rows.push(movementRow(day, config, {
    lineType: "work",
    internalCode: "regular_work",
    quantityMinutes: workMinutes,
    factor: 1,
    unit: "minutes",
  }));
  if (Number(day.saturdayEligibleMinutes || 0) > 0) rows.push(movementRow(day, config, {
    lineType: "supplement",
    internalCode: "saturday_bonus",
    quantityMinutes: Number(day.saturdayEligibleMinutes),
    factor: Number(day.saturdayFactor || 1),
    unit: "minutes",
  }));
  for (const absence of day.absences || []) {
    rows.push(movementRow(day, config, {
      lineType: absence.internalCode === "public_holiday" ? "holiday" : "absence",
      internalCode: ABSENCE_CODES.has(absence.internalCode) ? absence.internalCode : "other",
      quantityMinutes: Number(absence.quantityMinutes || 0),
      quantityDays: Number(absence.quantityDays || 0),
      factor: 1,
      unit: absence.unit || (absence.quantityMinutes ? "minutes" : "days"),
    }));
  }
  return rows;
}

function buildPayrollRows(days, configuration) {
  const config = normalizePayrollConfiguration(configuration);
  const sourceRows = config.layout === "movement_lines"
    ? days.flatMap((day) => movementRows(day, config))
    : days.map(dailyJournalRow);
  const availableColumns = new Map(layoutColumns(config.layout).map((column) => [column.id, column]));
  const columns = config.columns.map((id) => availableColumns.get(id)).filter(Boolean);
  const rows = sourceRows.map((row) => Object.fromEntries(columns.map((column) => [column.id, row[column.id] ?? ""])));
  return { config, columns, rows };
}

module.exports = {
  PAYROLL_LAYOUTS,
  normalizePayrollConfiguration,
  payrollCatalog,
  buildPayrollRows,
};
