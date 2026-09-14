"use strict";

// This view uses the shared ZA form in portal.js; only the subject and schedule differ.
const branchTimeOffState = {
  employees: [], catalogGeneration: 0, scheduleGeneration: 0,
  view: "week", anchor: "", selectedDate: "", schedule: null,
};

function isBranchTimeOffAccount(user = portalUser()) {
  return isOrganizationAccount(user) && user?.accountType === "branch";
}

function timeOffOwnerKey(user = portalUser()) {
  return JSON.stringify([user?.sessionKind, user?.accountId, user?.employeeNumber,
    user?.homeLocationId, user?.permissions || [], user?.scopes || []]);
}

function configureBranchTimeOffForm() {
  const branch = isBranchTimeOffAccount();
  el.branchTimeOffEmployeeField.classList.toggle("hidden", !branch);
  el.branchTimeOffEmployee.required = branch;
  el.branchTimeOffSchedule.classList.toggle("hidden", !branch);
  el.timeOffHistoryCard.classList.toggle("hidden", branch);
  el.timeOffContextLabel.textContent = branch ? "Filialkonto" : "Selbstverwaltung";
  el.timeOffFields.disabled = portalState.timeOffSubmitting === true
    || (branch && (!el.branchTimeOffEmployee.value || el.branchTimeOffEmployee.disabled));
}

function resetBranchTimeOffState() {
  branchTimeOffState.catalogGeneration += 1;
  branchTimeOffState.scheduleGeneration += 1;
  branchTimeOffState.employees = [];
  branchTimeOffState.schedule = null;
  branchTimeOffState.view = "week";
  branchTimeOffState.anchor = "";
  branchTimeOffState.selectedDate = "";
  el.branchTimeOffEmployee.innerHTML = '<option value="">Bitte auswählen</option>';
  el.branchTimeOffEmployee.disabled = false;
  el.branchTimeOffScheduleGrid.innerHTML = "";
  el.branchTimeOffScheduleDetail.innerHTML = "";
  el.branchTimeOffSchedulePeriod.textContent = "";
  el.branchTimeOffScheduleLocation.textContent = "";
  el.timeOffRequestList.innerHTML = "";
  portalState.timeOffRequests = [];
  portalState.pendingTimeOffChanges = [];
  portalState.timeOffSlots = null;
  portalState.timeOffSlotsKey = "";
  timeOffSlotsGeneration += 1;
  portalState.timeOffSubmitting = false;
  invalidateTimeOffCheck();
  resetTimeOffForm();
  message(el.timeOffMessage, "");
}

async function loadBranchTimeOffEmployees() {
  if (!isBranchTimeOffAccount() || !portalTabAllowed("timeOff")) return;
  const owner = timeOffOwnerKey();
  const generation = ++branchTimeOffState.catalogGeneration;
  const selected = el.branchTimeOffEmployee.value;
  el.branchTimeOffEmployee.disabled = true;
  configureBranchTimeOffForm();
  try {
    const data = await api("/api/portal/v1/branch-time-off/employees");
    if (generation !== branchTimeOffState.catalogGeneration || owner !== timeOffOwnerKey()) return;
    branchTimeOffState.employees = data.employees || [];
    el.branchTimeOffEmployee.innerHTML = '<option value="">Bitte auswählen</option>'
      + branchTimeOffState.employees.map(person => `<option value="${esc(person.employeeNumber)}">${esc(person.fullName)} · ${esc(person.employeeNumber)}</option>`).join("");
    if (branchTimeOffState.employees.some(person => person.employeeNumber === selected)) el.branchTimeOffEmployee.value = selected;
    el.branchTimeOffEmployee.disabled = !branchTimeOffState.employees.length || portalState.timeOffSubmitting;
    el.branchTimeOffScheduleLocation.textContent = data.location.name;
    configureBranchTimeOffForm();
    if (!branchTimeOffState.employees.length) message(el.timeOffMessage, "Für diese Filiale sind keine aktiven Teammitglieder vorhanden.");
    await loadBranchTimeOffSchedule();
  } catch (error) {
    if (generation !== branchTimeOffState.catalogGeneration || owner !== timeOffOwnerKey()) return;
    branchTimeOffState.employees = [];
    el.branchTimeOffEmployee.innerHTML = '<option value="">Auswahl nicht verfügbar</option>';
    invalidateTimeOffCheck();
    clearBranchTimeOffSchedule(error.message);
    message(el.timeOffMessage, error.message, true);
  }
}

function clearBranchTimeOffSchedule(status) {
  branchTimeOffState.schedule = null;
  el.branchTimeOffScheduleGrid.innerHTML = "";
  el.branchTimeOffScheduleDetail.innerHTML = "";
  el.branchTimeOffSchedulePeriod.textContent = "";
  el.branchTimeOffScheduleStatus.textContent = status;
  el.branchTimeOffSchedule.removeAttribute("aria-busy");
}

async function loadBranchTimeOffSchedule(followRequest = false) {
  if (!isBranchTimeOffAccount()) return;
  const generation = ++branchTimeOffState.scheduleGeneration;
  const employeeNumber = el.branchTimeOffEmployee.value;
  const owner = timeOffOwnerKey();
  const available = Boolean(employeeNumber);
  [el.branchTimeOffPrevious, el.branchTimeOffNext, el.branchTimeOffAnchor,
    el.branchTimeOffWeek, el.branchTimeOffMonth, el.branchTimeOffScheduleRefresh]
    .forEach(button => { button.disabled = !available; });
  el.branchTimeOffWeek.setAttribute("aria-pressed", String(branchTimeOffState.view === "week"));
  el.branchTimeOffMonth.setAttribute("aria-pressed", String(branchTimeOffState.view === "month"));
  if (!available) {
    clearBranchTimeOffSchedule("Bitte zuerst ein Teammitglied auswählen.");
    return;
  }
  if (followRequest || !branchTimeOffState.anchor) branchTimeOffState.anchor = el.timeOffDate.value || iso(new Date());
  const date = branchTimeOffState.anchor;
  const view = branchTimeOffState.view;
  clearBranchTimeOffSchedule("Dienstplan wird geladen …");
  el.branchTimeOffSchedule.setAttribute("aria-busy", "true");
  try {
    const query = new URLSearchParams({ employeeNumber, date, view });
    const data = await api(`/api/portal/v1/branch-time-off/schedule?${query}`);
    if (generation !== branchTimeOffState.scheduleGeneration || owner !== timeOffOwnerKey() || employeeNumber !== el.branchTimeOffEmployee.value) return;
    branchTimeOffState.schedule = data;
    const requested = el.timeOffDate.value;
    branchTimeOffState.selectedDate = requested >= data.from && requested <= data.to ? requested : data.from;
    renderBranchTimeOffSchedule();
  } catch (error) {
    if (generation !== branchTimeOffState.scheduleGeneration || owner !== timeOffOwnerKey()) return;
    clearBranchTimeOffSchedule(error.message);
  } finally {
    if (generation === branchTimeOffState.scheduleGeneration) el.branchTimeOffSchedule.removeAttribute("aria-busy");
  }
}

function branchTimeOffRequestedDate(date) {
  const payload = timeOffPayload();
  return Boolean(payload.dateFrom && date >= payload.dateFrom && date <= (payload.dateTo || payload.dateFrom));
}

function branchTimeOffDayContent(date, data) {
  const own = data.employeeShifts.filter(shift => shift.date === date);
  const shifts = data.shifts.filter(shift => shift.date === date);
  const ownTimes = own.length ? own.map(shift => `${shift.startTime}–${shift.endTime}`).join(", ") : "Keine Einteilung bekannt";
  return `<p class="branch-time-off-person-plan"><strong>${esc(data.employee.fullName)}</strong><span>${esc(ownTimes)}</span></p>`
    + (shifts.length ? `<ul class="branch-time-off-shifts">${shifts.map(shift => `<li><time>${esc(shift.startTime)}–${esc(shift.endTime)}</time><span>${esc(shift.employeeName)}${shift.departmentName || shift.area ? `<small>${esc([shift.departmentName, shift.area].filter(Boolean).join(" · "))}</small>` : ""}</span></li>`).join("")}</ul>`
      : '<p class="branch-time-off-empty">Für die Filiale sind keine Dienste erfasst.</p>');
}

function renderBranchTimeOffSchedule() {
  const data = branchTimeOffState.schedule;
  if (!data) return;
  const days = [];
  for (let date = data.from; date <= data.to; date = addDays(date, 1)) days.push(date);
  const month = data.view === "month";
  el.branchTimeOffSchedulePeriod.textContent = month
    ? new Intl.DateTimeFormat("de-AT", { month: "long", year: "numeric" }).format(new Date(`${data.from}T12:00:00`))
    : `${dateText(data.from)} – ${dateText(data.to)}`;
  el.branchTimeOffScheduleStatus.textContent = data.shifts.length
    ? `Geplante Zeiten für ${data.employee.fullName} und das Filialteam. Markierung: beantragter Zeitraum.`
    : "Für diesen Zeitraum sind noch keine Dienste der Filiale erfasst. Der ZA-Antrag kann bei fehlender Planung zur manuellen Prüfung eingereicht werden.";
  if (!month) {
    el.branchTimeOffScheduleGrid.className = "branch-time-off-week-grid";
    el.branchTimeOffScheduleGrid.innerHTML = days.map(date => `<section class="branch-time-off-day${branchTimeOffRequestedDate(date) ? " requested" : ""}"><h4>${esc(new Intl.DateTimeFormat("de-AT", { weekday: "short", day: "2-digit", month: "2-digit" }).format(new Date(`${date}T12:00:00`)))}${branchTimeOffRequestedDate(date) ? '<span class="branch-time-off-request-label">ZA-Antrag</span>' : ""}</h4>${branchTimeOffDayContent(date, data)}</section>`).join("");
    el.branchTimeOffScheduleDetail.innerHTML = "";
    return;
  }
  const offset = (new Date(`${data.from}T12:00:00`).getDay() + 6) % 7;
  el.branchTimeOffScheduleGrid.className = "branch-time-off-month-grid";
  el.branchTimeOffScheduleGrid.innerHTML = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map(day => `<span class="branch-time-off-weekday">${day}</span>`).join("")
    + '<span aria-hidden="true"></span>'.repeat(offset)
    + days.map(date => {
      const own = data.employeeShifts.filter(shift => shift.date === date);
      const count = data.shifts.filter(shift => shift.date === date).length;
      const requested = branchTimeOffRequestedDate(date);
      const selected = date === branchTimeOffState.selectedDate;
      const label = `${dateText(date)}: ${count} Dienste der Filiale. ${data.employee.fullName}: ${own.length ? own.map(shift => `${shift.startTime} bis ${shift.endTime}`).join(", ") : "Keine Einteilung bekannt"}.${requested ? " ZA-Antrag." : ""}`;
      return `<button type="button" class="branch-time-off-month-day${requested ? " requested" : ""}" data-branch-time-off-date="${date}" aria-pressed="${selected}" aria-label="${esc(label)}"><strong>${Number(date.slice(-2))}</strong><small>${count ? `${count}×` : "–"}${own.length ? '<span aria-hidden="true"> ●</span>' : ""}</small></button>`;
    }).join("");
  const selected = branchTimeOffState.selectedDate;
  el.branchTimeOffScheduleDetail.innerHTML = `<p class="branch-time-off-calendar-legend">× Dienste der Filiale · ● ${esc(data.employee.fullName)} eingeteilt · Umrandung: ZA-Antrag</p><section class="branch-time-off-day${branchTimeOffRequestedDate(selected) ? " requested" : ""}"><h4>${esc(dateText(selected))}${branchTimeOffRequestedDate(selected) ? '<span class="branch-time-off-request-label">ZA-Antrag</span>' : ""}</h4>${branchTimeOffDayContent(selected, data)}</section>`;
}

function bindBranchTimeOffEvents() {
  el.branchTimeOffEmployee.addEventListener("change", () => {
    message(el.timeOffMessage, "");
    configureBranchTimeOffForm();
    loadTimeOffSlots();
    updateTimeOffMode();
    loadBranchTimeOffSchedule(true);
  });
  el.timeOffDate.addEventListener("change", () => loadBranchTimeOffSchedule(true));
  el.timeOffDateTo.addEventListener("change", renderBranchTimeOffSchedule);
  el.branchTimeOffScheduleRefresh.addEventListener("click", () => loadBranchTimeOffSchedule());
  el.branchTimeOffAnchor.addEventListener("click", () => loadBranchTimeOffSchedule(true));
  [[el.branchTimeOffWeek, "week"], [el.branchTimeOffMonth, "month"]].forEach(([button, view]) => {
    button.addEventListener("click", () => {
      branchTimeOffState.view = view;
      loadBranchTimeOffSchedule();
    });
  });
  [[el.branchTimeOffPrevious, -1], [el.branchTimeOffNext, 1]].forEach(([button, direction]) => {
    button.addEventListener("click", () => {
      const anchor = branchTimeOffState.anchor || el.timeOffDate.value || iso(new Date());
      branchTimeOffState.anchor = branchTimeOffState.view === "month" ? addMonths(anchor, direction) : addDays(anchor, direction * 7);
      loadBranchTimeOffSchedule();
    });
  });
  el.branchTimeOffScheduleGrid.addEventListener("click", event => {
    const day = event.target.closest("[data-branch-time-off-date]");
    if (!day) return;
    branchTimeOffState.selectedDate = day.dataset.branchTimeOffDate;
    renderBranchTimeOffSchedule();
    el.branchTimeOffScheduleGrid.querySelector(`[data-branch-time-off-date="${branchTimeOffState.selectedDate}"]`)?.focus();
  });
}
