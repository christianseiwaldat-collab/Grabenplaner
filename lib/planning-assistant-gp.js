"use strict";
const { assessPlanning, subtract, minutes, clock, addDays } = require("./planning-assistant");
const settingsModule = require("./planning-assistant-settings");

function createPlanningAssistantReader({ getSchedule, settings, loadShifts, loadOptions, loadPositions, loadDepartments,
  settingsForLocation, plannedShiftBreaks, dayConfiguration, optionIsAllDay, optionLabel, employeeCanWorkOnDate,
  assessBranchSupervision, loadQualifications = async () => ({ available: false, checks: [] }) }) {
  return async function read(week, contextInput, actor, { includeFacts = false } = {}) {
    const schedule = await getSchedule(week, contextInput, actor);
    const { context, weekStart, weekEnd } = schedule;
    const configurationState = settingsModule.read(settings(), context), configuration = configurationState.configuration;
    const employeeNumbers = new Set(schedule.employees.map(item => String(item.personnel_number)));
    const [allShifts, positions, allDepartments, optionGroups] = await Promise.all([
      loadShifts(weekStart, weekEnd), loadPositions(), loadDepartments(),
      Promise.all([...employeeNumbers].map(id => loadOptions(id, weekStart, weekEnd))),
    ]);
    const rows = allShifts.filter(item => employeeNumbers.has(String(item.employee_number)));
    if (rows.length > 4000 || employeeNumbers.size > 500) throw Object.assign(new Error("Der Prüfumfang ist zu groß. Bitte eine Abteilung auswählen."), { status: 422, code: "PLANNING_ASSISTANT_SCOPE_LIMIT" });
    const locationSettings = new Map([[context.locationId, Promise.resolve(schedule.settings)]]);
    const shifts = await Promise.all(rows.map(async row => {
      const locationId = String(row.location_id), departmentId = Number(row.department_id || 0) || null;
      if (!locationSettings.has(locationId)) locationSettings.set(locationId, settingsForLocation(locationId));
      const { start, end, breakMinutes, lunchBreakMinutes, dayConfig } = await plannedShiftBreaks(row, await locationSettings.get(locationId));
      return { id: String(row.id), employeeId: String(row.employee_number), date: row.shift_date,
        startTime: row.start_time, endTime: row.end_time, locationId, departmentId, dutyCode: String(row.duty_code || ""),
        visible: locationId === context.locationId && (!context.departmentId || context.departmentId === departmentId),
        breaks: lunchBreakMinutes > 0 ? [{ startTime: clock(Math.max(start, minutes(dayConfig.lunchStart))), endTime: clock(Math.min(end, minutes(dayConfig.lunchEnd))) }] : [],
        unlocatedBreakMinutes: Math.max(0, breakMinutes - lunchBreakMinutes) };
    }));
    const unavailable = [], gaps = [];
    for (const option of optionGroups.flat()) {
      if (option.soft_pending || !employeeNumbers.has(String(option.employee_number))) continue;
      for (let date = option.date_from < weekStart ? weekStart : option.date_from; date <= weekEnd && date <= option.date_to; date = addDays(date, 1)) {
        // Same full-day and invalid-time semantics as GP's optionOverlapsTime.
        const fullDay = optionIsAllDay(option) || minutes(option.start_time) === null || minutes(option.end_time) === null;
        unavailable.push({ employeeId: String(option.employee_number), date,
          startTime: fullDay ? "00:00" : option.start_time, endTime: fullDay ? "24:00" : option.end_time,
          label: option.option_type === "sick" ? "Nicht verfügbar" : optionLabel(option.option_type) });
      }
    }
    for (const item of schedule.sicknessCredits || []) {
      if (!employeeNumbers.has(String(item.employee_number))) continue;
      if (!unavailable.some(row => row.employeeId === String(item.employee_number) && row.date === item.date && row.startTime === "00:00" && row.endTime === "24:00")) {
        unavailable.push({ employeeId: String(item.employee_number), date: item.date, startTime: "00:00", endTime: "24:00", label: "Nicht verfügbar" });
      }
    }
    for (const employee of schedule.employees) for (let date = weekStart; date <= weekEnd; date = addDays(date, 1)) {
      if (!employeeCanWorkOnDate(employee, date)) unavailable.push({ employeeId: String(employee.personnel_number), date,
        startTime: "00:00", endTime: "24:00", label: "Kein vereinbarter Arbeitstag" });
    }
    const blocked = new Set(schedule.globalBlockDates);
    // Follow the existing branch-supervision calendar for coverage requirements.
    // A holiday assignment itself is still evaluated by GP's work-rule profiles.
    const coverageClosedDates = new Set([...blocked, ...(schedule.publicHolidays || []).map(item => item.date)]);
    for (const shift of shifts.filter(row => row.visible && blocked.has(row.date))) unavailable.push({ employeeId: shift.employeeId,
      date: shift.date, startTime: "00:00", endTime: "24:00", label: "Gesperrter Planungstag" });
    const requirements = [], optimizationBlockers = [];
    const departments = allDepartments.filter(item => String(item.location_id) === context.locationId && Boolean(item.active));
    const configuredScopes = [{ departmentId: context.departmentId || null, state: configurationState },
      ...(!context.departmentId ? departments.map(d => ({ departmentId: Number(d.id), state: settingsModule.read(settings(), { ...context, departmentId: Number(d.id) }) })) : [])];
    if (configuredScopes.some(s => !s.state.valid)) optimizationBlockers.push("Gespeicherte Prüfeinstellungen sind ungültig. Bitte die Einstellungen der Filiale und ihrer Abteilungen korrigieren.");
    for (let date = weekStart; date <= weekEnd; date = addDays(date, 1)) {
      const day = await dayConfiguration(date, schedule.settings, context);
      if (!day?.open || coverageClosedDates.has(date)) continue;
      const start = minutes(day.minFrom), end = minutes(day.minTo);
      if (start === null || end === null || end <= start) {
        optimizationBlockers.push(`Für ${date} fehlt ein gültiges Besetzungsfenster.`);
        gaps.push({ message: `Für ${date} fehlt ein gültiges Besetzungsfenster.`, suggestion: "Besetzungszeiten in den Filialeinstellungen festlegen." }); continue;
      }
      const lunchStart = minutes(day.lunchStart), lunchEnd = minutes(day.lunchEnd);
      const windows = day.lunchEnabled && lunchStart !== null && lunchEnd > lunchStart
        ? subtract([{ start, end }], [{ start: lunchStart, end: lunchEnd }]) : [{ start, end }];
      for (const window of windows) {
        const common = { date, startTime: clock(window.start), endTime: clock(window.end), departmentId: context.departmentId || null };
        // In a department view, the branch-wide minimum cannot be tested on a
        // partial staff set. Its own existing department floor remains valid.
        const department = departments.find(item => Number(item.id) === context.departmentId);
        const minimum = context.departmentId ? Number(department?.min_staff || 0) : day.minStaff;
        if (minimum > 0) requirements.push({ ...common, kind: "staffing", label: context.departmentName || context.locationName, minimum });
        if (!context.departmentId) for (const item of departments.filter(item => Number(item.min_staff) > 0)) requirements.push({
          ...common, kind: "staffing", departmentId: Number(item.id), label: item.name, minimum: Number(item.min_staff) });
        for (const scope of configuredScopes) {
          for (const item of scope.state.configuration.requiredPositions) requirements.push({ ...common, departmentId: scope.departmentId, kind: "position", positionId: item.positionId,
            label: positions.find(position => position.id === item.positionId)?.name || item.positionId, minimum: item.count });
          if (scope.state.configuration.keyPersonNumbers.length) requirements.push({ ...common, departmentId: scope.departmentId, kind: "key_person", label: "Mindestens eine hinterlegte Schlüsselperson",
            employeeIds: scope.state.configuration.keyPersonNumbers, minimum: 1 });
        }
      }
    }
    if (context.departmentId) gaps.push({ message: "Die filialweite Mindestbesetzung wird im Abteilungsausschnitt nicht vollständig geprüft.", suggestion: "Für die Filialprüfung den Gesamtplan öffnen." });
    if (!configuration.keyPersonNumbers.length) gaps.push({ rule: "key_person", message: "Es sind keine zusätzlichen Schlüsselpersonen für diesen Bereich festgelegt.", suggestion: "Bei Bedarf Schlüsselpersonen in den Prüfeinstellungen auswählen; die bestehende Filialaufsicht bleibt separat wirksam." });
    if (!configurationState.valid) gaps.push({ message: "Gespeicherte Prüfeinstellungen sind ungültig; zusätzliche Vorgaben können fehlen.", suggestion: "Prüfeinstellungen korrigieren und speichern." });
    const employeeRows = schedule.employees.map(item => ({ id: String(item.personnel_number), label: String(item.nickname || item.full_name || item.personnel_number), positionId: String(item.position_id || ""),
      targetMinutes: item.contracted_hours !== null && item.contracted_hours !== undefined && Number.isFinite(Number(item.contracted_hours)) ? Math.round(Number(item.contracted_hours) * 60) : null,
      creditedMinutes: schedule.totals[item.personnel_number], hoursComplete: !context.departmentId && String(item.home_location_id) === context.locationId }));
    // Reuse the branch-supervision evaluator with effective attendance, after
    // known absence/break windows. Never infer qualification from a duty label.
    let supervision = schedule.branchSupervisionAssessment;
    if (!context.departmentId && supervision?.mode !== "off") {
      const effectiveShifts = shifts.filter(item => item.visible).flatMap(shift => {
        const start = minutes(shift.startTime), end = minutes(shift.endTime);
        if (start === null || end === null || end <= start) return [];
        const masks = [...unavailable.filter(item => item.employeeId === shift.employeeId && item.date === shift.date), ...shift.breaks]
          .map(item => ({ start: minutes(item.startTime), end: minutes(item.endTime) }));
        const elsewhere = shifts.filter(item => item.employeeId === shift.employeeId && item.date === shift.date && item.locationId !== context.locationId)
          .map(item => ({ start: minutes(item.startTime), end: minutes(item.endTime) }));
        return subtract([{ start, end }], [...masks, ...elsewhere]).map(part => ({ employee_number: shift.employeeId, shift_date: shift.date,
          location_id: context.locationId, start_time: clock(part.start), end_time: clock(part.end), duty_code: shift.dutyCode }));
      });
      supervision = assessBranchSupervision({ weekStart, weekEnd, locationId: context.locationId, settings: schedule.settings,
        employees: schedule.employees, shifts: effectiveShifts, blockedDates: [...coverageClosedDates] });
      if (shifts.some(shift => shift.visible && shift.unlocatedBreakMinutes > 0)) gaps.push({ rule: "supervision", message: "Pauschale Pausen ohne Lage können die Filialaufsicht zusätzlich unterbrechen.", suggestion: "Pausen der Aufsichtspersonen konkret abstimmen." });
    }
    let qualifications;
    try { qualifications = await loadQualifications(schedule, actor, { departmentIds: context.departmentId ? [context.departmentId]
      : [...new Set([null, ...departments.map(d => Number(d.id)), ...shifts.filter(s => s.visible).map(s => s.departmentId)])] }); }
    catch { qualifications = { available: false, checks: [], reason: "Die Qualifikationsquelle ist derzeit nicht verlässlich auswertbar." }; }
    const facts = { period: { from: weekStart, to: weekEnd }, context, employees: employeeRows, shifts,
      unavailable: [...new Map(unavailable.map(item => [JSON.stringify(item), item])).values()], requirements,
      configuration, optimizationBlockers, workRuleAssessment: schedule.workRuleAssessment, supervision, qualifications, gaps };
    return { assessment: assessPlanning(facts), configuration: configurationState,
      choices: { positions: positions.filter(item => Boolean(item.active)).map(item => ({ id: item.id, name: item.name })),
        employees: employeeRows.map(({ id, label }) => ({ id, label })) },
      ...(includeFacts ? { facts, schedule, rawShifts: rows } : {}) };
  };
}
module.exports = { createPlanningAssistantReader };
