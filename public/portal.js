const portalState = {
  session: null,
  weekStart: mondayOf(new Date()),
  timeOffCheck: null,
  vacationCheck: null,
  vacationChange: null,
  absenceHistory: [],
  notifications: [],
  unreadNotifications: 0,
  amuReports: [],
};

const optionNames = {
  vacation: "Urlaub",
  sick: "Krankenstand",
  branch: "Andere Filiale",
  vocational_school: "Berufsschule",
  school: "Schulung",
  time_off: "Zeitausgleich",
  special_leave: "Sonderurlaub",
  external_appointment: "Außer-Haus-Termin",
  team_meeting: "Teamsitzung",
  other: "Sonstiges",
};
const weekdayNames = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const statusLabels = { pending: "Offen", submitted: "Übermittelt", pending_local: "Offen", preliminary_local: "Vorläufig genehmigt", pending_hr: "Wartet auf Personalleitung", approved: "Genehmigt", rejected: "Abgelehnt", cancelled: "Storniert", withdrawn: "Zurückgezogen", reviewed: "Geprüft", returned: "Ergänzung erforderlich" };

function applyDeviceMode() {
  const compact = window.matchMedia("(max-width: 720px)").matches;
  const touch = window.matchMedia("(pointer: coarse)").matches;
  const mobileHint = navigator.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  document.documentElement.dataset.uiMode = compact || (touch && mobileHint) ? "mobile" : "desktop";
  document.documentElement.dataset.inputMode = touch ? "touch" : "pointer";
}
applyDeviceMode();
window.addEventListener("resize", applyDeviceMode, { passive: true });

const el = Object.fromEntries([
  "portalLogin", "portalLoginForm", "loginPersonnelNumber", "loginPassword", "loginError", "portalApp", "portalLogo", "portalAccessModeLabel",
  "portalUserName", "portalUserRole", "adminAppLink", "changePasswordButton", "logoutButton", "notificationsButton", "notificationBadge", "scheduleView", "timeOffView",
  "vacationView", "historyView", "amuView", "scheduleHeading", "scheduleGrid", "previousWeek", "currentWeek", "nextWeek",
  "timeOffRequestForm", "timeOffDate", "timeOffStart", "timeOffEnd", "timeOffNote", "timeOffCheck", "timeOffMessage",
  "timeOffSubmitButton", "timeOffRequestList", "vacationRequestForm", "vacationDateFrom", "vacationDateTo", "vacationNote",
  "vacationCheck", "vacationMessage", "vacationSubmitButton", "vacationRequestList", "approvedVacationList", "passwordDialog",
  "passwordForm", "currentPassword", "newPassword", "repeatPassword", "passwordMessage", "vacationChangeDialog",
  "vacationChangeForm", "vacationChangeTitle", "vacationChangeOriginal", "vacationChangeDates", "vacationChangeFrom",
  "vacationChangeTo", "vacationChangeNote", "vacationChangeMessage", "historyTypeFilter", "historyStatusFilter", "absenceHistoryList",
  "historyDetailDialog", "historyDetailTitle", "historyDetailSummary", "historyDecisionTimeline", "notificationsDialog", "notificationList",
  "markAllNotificationsRead", "amuReportForm", "amuIncapacityFrom", "amuIncapacityTo", "amuEmployeeNote", "amuDocuments",
  "amuMessage", "amuSubmitButton", "amuReportList",
].map((id) => [id, document.querySelector(`#${id}`)]));

function mondayOf(value) {
  const date = new Date(value);
  date.setHours(12, 0, 0, 0);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return iso(date);
}

function iso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(value, amount) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return iso(date);
}

function dateText(value, options = { day: "2-digit", month: "2-digit", year: "numeric" }) {
  return new Intl.DateTimeFormat("de-AT", options).format(new Date(`${value}T12:00:00`));
}

function esc(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function csrf() {
  const part = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("grabenplaner_csrf="));
  return part ? decodeURIComponent(part.split("=").slice(1).join("=")) : "";
}

async function api(url, options = {}) {
  const formData = options.body instanceof FormData;
  const headers = { ...(formData ? {} : { "Content-Type": "application/json" }), ...options.headers };
  const token = csrf();
  if (token && !["GET", "HEAD"].includes(String(options.method || "GET").toUpperCase())) headers["X-CSRF-Token"] = token;
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    let payload = {};
    try { payload = await response.json(); } catch {}
    const error = new Error(payload.error || "Die Aktion konnte nicht ausgeführt werden.");
    error.status = response.status;
    error.code = payload.code || "";
    if (response.status === 401) showLogin("Die Anmeldung ist abgelaufen. Bitte erneut anmelden.");
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function message(node, text, error = false) {
  node.textContent = text;
  node.classList.toggle("hidden", !text);
  node.classList.toggle("error", error);
}

function applyPortalBranding(branding = {}) {
  const logoUrl = branding.logoUrl || "/assets/grabenplaner-logo.svg";
  const logoAlt = branding.logoAlt || branding.companyName || "Grabenplaner";
  document.querySelectorAll(".login-card img,#portalLogo").forEach((image) => { image.src = logoUrl; image.alt = logoAlt; });
  document.querySelectorAll("[data-brand-icon]").forEach((link) => { link.href = branding.iconUrl || "/assets/webicon.svg"; });
}

function applyRequestedTab() {
  const requested = new URLSearchParams(location.search).get("tab");
  const tab = requested === "requests" ? "history" : requested;
  if (["schedule", "timeOff", "vacation", "history", "amu"].includes(tab)) setTab(tab);
}

async function initialize() {
  try {
    const status = await api("/api/portal/v1/status");
    portalState.status = status;
    applyPortalBranding(status.branding);
    const minimum = Number(status.passwordMinLength || 6);
    [el.loginPassword, el.newPassword, el.repeatPassword].forEach((input) => { if (input) input.minLength = minimum; });
    if (el.portalAccessModeLabel) el.portalAccessModeLabel.textContent = status.operationMode === "server" ? "Mitarbeiterportal · HTTPS" : "Mitarbeiterportal";
    if (!status.portalEnabled) {
      message(el.loginError, "Das Mitarbeiterportal ist auf diesem Gerät nicht als LAN-Host oder Server aktiv.", true);
      return;
    }
    const session = await api("/api/portal/v1/session");
    if (!session.authenticated) {
      showLogin();
      return;
    }
    showPortal(session);
    if (!session.user.mustChangePassword) {
      await loadPortalData();
      applyRequestedTab();
    }
  } catch (error) {
    showLogin(error.message);
  }
}

async function loadPortalData() {
  await Promise.allSettled([
    loadSchedule(), loadVacationRequests(), loadTimeOffRequests(), loadApprovedVacations(),
    loadAbsenceHistory(), loadNotifications(), loadAmuReports(),
  ]);
}

function showLogin(error = "") {
  el.portalLogin.classList.remove("hidden");
  el.portalApp.classList.add("hidden");
  message(el.loginError, error, Boolean(error));
}

function showPortal(session) {
  portalState.session = session;
  el.portalLogin.classList.add("hidden");
  el.portalApp.classList.remove("hidden");
  el.portalUserName.textContent = `${session.user.employeeNumber} · ${session.user.nickname || session.user.fullName}`;
  el.portalUserRole.textContent = session.user.roleName;
  el.adminAppLink.classList.toggle("hidden", !session.user.permissions.includes("schedule:read"));
  el.passwordDialog.dataset.required = session.user.mustChangePassword ? "true" : "false";
  if (session.user.mustChangePassword) setTimeout(() => el.passwordDialog.showModal(), 100);
}

async function login(event) {
  event.preventDefault();
  try {
    const result = await api("/api/portal/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ employeeNumber: el.loginPersonnelNumber.value, password: el.loginPassword.value }),
    });
    el.loginPassword.value = "";
    showPortal(result);
    if (!result.user.mustChangePassword) {
      await loadPortalData();
      applyRequestedTab();
    }
  } catch (error) {
    message(el.loginError, error.message, true);
  }
}

async function logout() {
  try { await api("/api/portal/v1/auth/logout", { method: "POST", body: "{}" }); } catch {}
  location.reload();
}

function setTab(tab) {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  el.scheduleView.classList.toggle("active", tab === "schedule");
  el.timeOffView.classList.toggle("active", tab === "timeOff");
  el.vacationView.classList.toggle("active", tab === "vacation");
  el.historyView.classList.toggle("active", tab === "history");
  el.amuView.classList.toggle("active", tab === "amu");
  if (tab === "timeOff") loadTimeOffRequests();
  if (tab === "vacation") loadVacationRequests();
  if (tab === "history") Promise.allSettled([loadAbsenceHistory(), loadApprovedVacations()]);
  if (tab === "amu") loadAmuReports();
}

async function loadSchedule() {
  const data = await api(`/api/portal/v1/me/schedule?week=${portalState.weekStart}`);
  portalState.weekStart = data.weekStart;
  el.scheduleHeading.textContent = `KW ${data.calendarWeek} · ${dateText(data.weekStart)} – ${dateText(data.weekEnd)}`;
  const today = iso(new Date());
  el.scheduleGrid.innerHTML = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(data.weekStart, index);
    const shifts = data.shifts.filter((item) => item.shift_date === date);
    const options = data.options.filter((item) => item.date_from <= date && item.date_to >= date);
    return `<article class="schedule-day ${date === today ? "today" : ""} ${index > 4 ? "weekend" : ""}">
      <header><strong>${weekdayNames[index]}</strong><span>${dateText(date, { day: "2-digit", month: "2-digit" })}</span></header>
      ${shifts.map((shift) => `<div class="shift-card"><strong>${esc(shift.start_time)}–${esc(shift.end_time)}</strong>${shift.department_name ? `<br>${esc(shift.department_name)}` : ""}${shift.area ? `<br>${esc(shift.area)}` : ""}</div>`).join("")}
      ${options.map((option) => `<div class="option-card"><strong>${esc(optionNames[option.option_type] || option.option_type)}</strong>${!option.all_day && option.start_time ? `<br>${esc(option.start_time)}–${esc(option.end_time)}` : ""}${option.note ? `<br>${esc(option.note)}` : ""}</div>`).join("")}
      ${!shifts.length && !options.length ? '<span class="empty-day">Kein Eintrag</span>' : ""}
    </article>`;
  }).join("");
}

function updateTraffic(node, result, emptyText) {
  const traffic = result?.trafficLight || "neutral";
  node.classList.remove("neutral", "green", "yellow", "red");
  node.classList.add(traffic);
  node.querySelector("strong").textContent = ({ green: "Nach aktuellem Stand möglich", yellow: "Manuelle Prüfung erforderlich", red: "Derzeit nicht möglich" })[traffic] || "Zeitraum eingeben";
  node.querySelector("small").textContent = result?.reason || emptyText;
}

let timeOffCheckTimer;
async function checkTimeOff() {
  clearTimeout(timeOffCheckTimer);
  if (!el.timeOffDate.value || !el.timeOffStart.value || !el.timeOffEnd.value) {
    portalState.timeOffCheck = null;
    el.timeOffSubmitButton.disabled = true;
    updateTraffic(el.timeOffCheck, null, "Danach wird die aktuelle Planung geprüft.");
    return;
  }
  timeOffCheckTimer = setTimeout(async () => {
    try {
      const result = await api("/api/portal/v1/me/time-off-check", {
        method: "POST",
        body: JSON.stringify({ date: el.timeOffDate.value, startTime: el.timeOffStart.value, endTime: el.timeOffEnd.value }),
      });
      portalState.timeOffCheck = result;
      el.timeOffSubmitButton.disabled = !result.allowed;
      updateTraffic(el.timeOffCheck, result, "");
    } catch (error) {
      portalState.timeOffCheck = { trafficLight: "red", allowed: false, reason: error.message };
      el.timeOffSubmitButton.disabled = true;
      updateTraffic(el.timeOffCheck, portalState.timeOffCheck, "");
    }
  }, 180);
}

async function loadTimeOffSlots() {
  const date = el.timeOffDate.value;
  el.timeOffStart.disabled = true;
  el.timeOffEnd.disabled = true;
  el.timeOffStart.innerHTML = '<option value="">Zeiten werden geladen</option>';
  el.timeOffEnd.innerHTML = '<option value="">Zuerst Von wählen</option>';
  if (!date) return;
  try {
    const data = await api(`/api/portal/v1/me/time-off-slots?date=${encodeURIComponent(date)}`);
    if (data.closed) {
      updateTraffic(el.timeOffCheck, { trafficLight: "red", allowed: false, reason: data.reason }, "");
      return;
    }
    portalState.timeOffSlots = data;
    el.timeOffStart.innerHTML = `<option value="">Von wählen</option>${data.startTimes.map((time) => `<option value="${esc(time)}">${esc(time)}</option>`).join("")}`;
    el.timeOffStart.disabled = false;
    updateTraffic(el.timeOffCheck, null, `Möglicher Zeitraum: ${data.start}–${data.end} Uhr.`);
  } catch (error) {
    updateTraffic(el.timeOffCheck, { trafficLight: "red", allowed: false, reason: error.message }, "");
  }
}

function updateTimeOffEndSlots() {
  const start = el.timeOffStart.value;
  const times = (portalState.timeOffSlots?.endTimes || []).filter((time) => time > start);
  el.timeOffEnd.innerHTML = `<option value="">Bis wählen</option>${times.map((time) => `<option value="${esc(time)}">${esc(time)}</option>`).join("")}`;
  el.timeOffEnd.disabled = !start;
  checkTimeOff();
}

async function loadTimeOffRequests() {
  const data = await api("/api/portal/v1/me/time-off-requests");
  el.timeOffRequestList.innerHTML = data.requests.length ? data.requests.map((item) => `
    <article class="request-item" data-time-off-request-id="${item.id}"><div>
      <strong>${dateText(item.request_date)} · ${esc(item.start_time)}–${esc(item.end_time)}</strong>
      <span>${item.approval_type === "hr" ? "Verbindlicher PL-ZA" : "Filialinterner ZA"}</span>
      ${item.note ? `<span>${esc(item.note)}</span>` : ""}
      <span class="status ${item.status}">${statusLabels[item.status] || esc(item.status)}</span>
      ${["pending","pending_local","preliminary_local","pending_hr"].includes(item.status) ? `<span>${esc(item.check_reason)}</span>` : ""}
      ${item.local_approved_by ? `<span>Filiale: ${esc(item.local_approved_by)}</span>` : ""}${item.hr_approved_by ? `<span>Personalleitung: ${esc(item.hr_approved_by)}</span>` : ""}
    </div>${["pending","pending_local","preliminary_local","pending_hr"].includes(item.status) ? '<button class="cancel-request" type="button">Zurückziehen</button>' : ""}</article>
  `).join("") : "<p>Noch keine ZA-Anträge vorhanden.</p>";
}

async function submitTimeOff(event) {
  event.preventDefault();
  if (!portalState.timeOffCheck?.allowed) return;
  try {
    await api("/api/portal/v1/me/time-off-requests", {
      method: "POST",
      body: JSON.stringify({
        date: el.timeOffDate.value,
        startTime: el.timeOffStart.value,
        endTime: el.timeOffEnd.value,
        note: el.timeOffNote.value,
        approvalType: document.querySelector('input[name="timeOffApprovalType"]:checked')?.value || "local",
      }),
    });
    el.timeOffRequestForm.reset();
    portalState.timeOffCheck = null;
    el.timeOffSubmitButton.disabled = true;
    el.timeOffStart.disabled = true;
    el.timeOffEnd.disabled = true;
    updateTraffic(el.timeOffCheck, null, "Danach wird die aktuelle Planung geprüft.");
    message(el.timeOffMessage, "Der ZA-Antrag wurde übermittelt.");
    await loadTimeOffRequests();
  } catch (error) {
    message(el.timeOffMessage, error.message, true);
    await checkTimeOff();
  }
}

async function cancelTimeOff(id) {
  if (!confirm("Offenen ZA-Antrag wirklich zurückziehen?")) return;
  try {
    await api(`/api/portal/v1/me/time-off-requests/${id}`, { method: "DELETE", body: "{}" });
    await loadTimeOffRequests();
  } catch (error) { message(el.timeOffMessage, error.message, true); }
}

let vacationCheckTimer;
async function checkVacation() {
  clearTimeout(vacationCheckTimer);
  if (!el.vacationDateFrom.value || !el.vacationDateTo.value) {
    portalState.vacationCheck = null;
    el.vacationSubmitButton.disabled = true;
    updateTraffic(el.vacationCheck, null, "Antragssperren werden sofort geprüft.");
    return;
  }
  vacationCheckTimer = setTimeout(async () => {
    try {
      const result = await api("/api/portal/v1/me/vacation-check", {
        method: "POST",
        body: JSON.stringify({ dateFrom: el.vacationDateFrom.value, dateTo: el.vacationDateTo.value }),
      });
      portalState.vacationCheck = result;
      el.vacationSubmitButton.disabled = !result.allowed;
      updateTraffic(el.vacationCheck, result, "");
    } catch (error) {
      portalState.vacationCheck = { trafficLight: "red", allowed: false, reason: error.message };
      el.vacationSubmitButton.disabled = true;
      updateTraffic(el.vacationCheck, portalState.vacationCheck, "");
    }
  }, 180);
}

async function loadVacationRequests() {
  const data = await api("/api/portal/v1/me/vacation-requests");
  el.vacationRequestList.innerHTML = data.requests.length ? data.requests.map((item) => `
    <article class="request-item" data-request-id="${item.id}"><div><strong>${dateText(item.date_from)} – ${dateText(item.date_to)}</strong>
      ${item.note ? `<span>${esc(item.note)}</span>` : ""}<span class="status ${item.status}">${statusLabels[item.status] || esc(item.status)}</span>
      ${item.local_approved_by ? `<span>Filiale: ${esc(item.local_approved_by)}</span>` : ""}${item.hr_approved_by ? `<span>Personalleitung: ${esc(item.hr_approved_by)}</span>` : ""}
    </div>${["pending","pending_local","preliminary_local","pending_hr"].includes(item.status) ? '<button class="cancel-request" type="button">Zurückziehen</button>' : ""}</article>
  `).join("") : "<p>Noch keine Urlaubsanträge vorhanden.</p>";
}

async function submitVacation(event) {
  event.preventDefault();
  if (!portalState.vacationCheck?.allowed) return;
  try {
    await api("/api/portal/v1/me/vacation-requests", {
      method: "POST",
      body: JSON.stringify({ dateFrom: el.vacationDateFrom.value, dateTo: el.vacationDateTo.value, note: el.vacationNote.value }),
    });
    el.vacationRequestForm.reset();
    portalState.vacationCheck = null;
    el.vacationSubmitButton.disabled = true;
    updateTraffic(el.vacationCheck, null, "Antragssperren werden sofort geprüft.");
    message(el.vacationMessage, "Der Urlaubsantrag wurde übermittelt.");
    await loadVacationRequests();
  } catch (error) {
    message(el.vacationMessage, error.message, true);
    await checkVacation();
  }
}

async function cancelVacation(id) {
  if (!confirm("Offenen Urlaubsantrag wirklich zurückziehen?")) return;
  try {
    await api(`/api/portal/v1/me/vacation-requests/${id}`, { method: "DELETE", body: "{}" });
    await loadVacationRequests();
  } catch (error) { message(el.vacationMessage, error.message, true); }
}

async function loadApprovedVacations() {
  const data = await api("/api/portal/v1/me/approved-vacations");
  const pendingByGroup = Object.fromEntries((data.pendingChanges || []).map((item) => [item.vacation_group_id, item]));
  el.approvedVacationList.innerHTML = data.vacations.length ? data.vacations.map((vacation) => {
    const pending = pendingByGroup[vacation.groupId];
    const pendingLabel = pending ? (pending.request_type === "cancel" ? "Storno beantragt" : "Änderung beantragt") : "";
    return `<article class="approved-vacation-item" data-vacation-group="${esc(vacation.groupId)}">
      <div><strong>${dateText(vacation.dateFrom)} – ${dateText(vacation.dateTo)}</strong>${vacation.note ? `<span>${esc(vacation.note)}</span>` : ""}${pending ? `<span class="pending-change">${pendingLabel}</span>` : ""}</div>
      <button data-vacation-action="change" type="button" ${pending ? "disabled" : ""}>Änderung beantragen</button>
      <button class="vacation-cancel" data-vacation-action="cancel" type="button" ${pending ? "disabled" : ""}>Stornierung beantragen</button>
    </article>`;
  }).join("") : "<p>Derzeit ist kein genehmigter Urlaub eingetragen.</p>";
}

const openRequestStatuses = new Set(["pending", "submitted", "pending_local", "preliminary_local", "pending_hr"]);
const decisionLabels = {
  create: "Antrag erstellt", preliminary: "Vorläufig genehmigt", approve: "Genehmigt", reject: "Abgelehnt",
  change: "Geändert", cancel: "Storniert", withdraw: "Zurückgezogen", forward: "Weitergeleitet",
};

function requestKindText(item) {
  if (item.kind === "time_off") return "Zeitausgleich";
  if (item.kind === "vacation_change" || item.request_type === "change") return "Urlaubsänderung";
  if (item.kind === "vacation_cancel" || item.request_type === "cancel") return "Urlaubsstorno";
  return "Urlaub";
}

function requestPeriodText(item) {
  if (item.kind === "time_off") return `${dateText(item.request_date)} · ${esc(item.start_time)}–${esc(item.end_time)}`;
  if (item.request_type === "change" || item.kind === "vacation_change") {
    return `${dateText(item.original_date_from)}–${dateText(item.original_date_to)} → ${dateText(item.requested_date_from)}–${dateText(item.requested_date_to)}`;
  }
  const from = item.date_from || item.original_date_from;
  const to = item.date_to || item.original_date_to || from;
  return from ? `${dateText(from)}–${dateText(to)}` : "Zeitraum nicht verfügbar";
}

function requestMatchesHistoryFilters(item) {
  const type = el.historyTypeFilter.value;
  const status = el.historyStatusFilter.value;
  const typeMatches = type === "all" || (type === "time_off" ? item.kind === "time_off" : item.kind !== "time_off");
  const statusMatches = status === "all"
    || (status === "open" ? openRequestStatuses.has(item.status) : status === "cancelled" ? ["cancelled", "withdrawn"].includes(item.status) : item.status === status);
  return typeMatches && statusMatches;
}

function renderAbsenceHistory() {
  const items = portalState.absenceHistory.filter(requestMatchesHistoryFilters);
  el.absenceHistoryList.innerHTML = items.length ? items.map((item) => {
    const approvals = [item.local_approved_by ? `Filiale: ${esc(item.local_approved_by)}` : "", item.hr_approved_by ? `PL: ${esc(item.hr_approved_by)}` : ""].filter(Boolean).join(" · ");
    return `<article class="history-item" data-history-id="${Number(item.id)}" data-history-kind="${esc(item.kind)}">
      <div><strong>${esc(requestKindText(item))}</strong><span>${requestPeriodText(item)}</span>${item.note ? `<span>${esc(item.note)}</span>` : ""}<small>${esc(new Date(item.created_at).toLocaleString("de-AT"))}</small></div>
      <div class="history-item-status"><span class="status ${esc(item.status)}">${esc(statusLabels[item.status] || item.status)}</span>${approvals ? `<small>${approvals}</small>` : ""}</div>
      <button class="text-button" data-open-history type="button">Verlauf</button>
    </article>`;
  }).join("") : '<p class="empty-state">Für diesen Filter gibt es keine Anträge.</p>';
}

async function loadAbsenceHistory() {
  try {
    const data = await api("/api/portal/v1/me/absence-history");
    portalState.absenceHistory = data.items || [];
    renderAbsenceHistory();
  } catch (error) {
    el.absenceHistoryList.innerHTML = `<p class="message error">${esc(error.message)}</p>`;
  }
}

function openHistoryDetail(id, kind) {
  const item = portalState.absenceHistory.find((entry) => Number(entry.id) === Number(id) && entry.kind === kind);
  if (!item) return;
  el.historyDetailTitle.textContent = requestKindText(item);
  el.historyDetailSummary.innerHTML = `<strong>${requestPeriodText(item)}</strong><span class="status ${esc(item.status)}">${esc(statusLabels[item.status] || item.status)}</span>${item.note ? `<p>${esc(item.note)}</p>` : ""}${item.decision_note ? `<p><strong>Entscheidungsbemerkung:</strong> ${esc(item.decision_note)}</p>` : ""}`;
  const decisions = item.decisions || [];
  el.historyDecisionTimeline.innerHTML = `<div class="timeline-entry"><span class="timeline-dot"></span><div><strong>Antrag erstellt</strong><small>${esc(new Date(item.created_at).toLocaleString("de-AT"))}</small></div></div>${decisions.map((decision) => `<div class="timeline-entry"><span class="timeline-dot"></span><div><strong>${esc(decisionLabels[decision.action] || decision.action)} · ${esc(decision.actor_employee_number)}</strong><small>${esc(new Date(decision.created_at).toLocaleString("de-AT"))}${decision.note ? ` · ${esc(decision.note)}` : ""}</small></div></div>`).join("")}`;
  el.historyDetailDialog.showModal();
}

function notificationIsRead(item) {
  return Boolean(item.read_at || item.readAt);
}

function renderNotifications() {
  el.notificationBadge.textContent = portalState.unreadNotifications > 99 ? "99+" : String(portalState.unreadNotifications);
  el.notificationBadge.classList.toggle("hidden", portalState.unreadNotifications < 1);
  el.notificationsButton.classList.toggle("has-unread", portalState.unreadNotifications > 0);
  el.notificationList.innerHTML = portalState.notifications.length ? portalState.notifications.map((item) => `<button class="notification-item ${notificationIsRead(item) ? "" : "unread"}" data-notification-id="${esc(item.id)}" type="button"><span class="notification-dot"></span><span><strong>${esc(item.title || "Benachrichtigung")}</strong><small>${esc(item.message || item.body || "")}</small><time>${esc(new Date(item.created_at || item.createdAt).toLocaleString("de-AT"))}</time></span></button>`).join("") : '<p class="empty-state">Keine Benachrichtigungen vorhanden.</p>';
  el.markAllNotificationsRead.classList.toggle("hidden", portalState.unreadNotifications < 1);
}

async function loadNotifications() {
  try {
    const data = await api("/api/portal/v1/me/notifications");
    portalState.notifications = data.notifications || [];
    portalState.unreadNotifications = Number(data.unreadCount || 0);
    renderNotifications();
  } catch (error) {
    if (error.status !== 401) el.notificationList.innerHTML = `<p class="message error">${esc(error.message)}</p>`;
  }
}

async function readNotification(id) {
  try {
    await api(`/api/portal/v1/me/notifications/${encodeURIComponent(String(id))}/read`, { method: "PUT", body: "{}" });
    const item = portalState.notifications.find((entry) => String(entry.id) === String(id));
    if (item && !notificationIsRead(item)) {
      item.read_at = new Date().toISOString();
      portalState.unreadNotifications = Math.max(0, portalState.unreadNotifications - 1);
    }
    renderNotifications();
    const target = String(item?.target || item?.link || "");
    if (target.startsWith("/portal")) {
      const requested = new URL(target, location.origin).searchParams.get("tab");
      const tab = requested === "requests" ? "history" : requested;
      el.notificationsDialog.close();
      setTab(["schedule", "timeOff", "vacation", "history", "amu"].includes(tab) ? tab : "history");
    } else if (target.startsWith("/")) location.href = target;
    else if (item?.entity_type === "amu_report") {
      el.notificationsDialog.close();
      setTab("amu");
    } else if (item?.request_id || item?.requestId || item?.entity_id) {
      el.notificationsDialog.close();
      setTab("history");
    }
  } catch (error) {
    el.notificationList.insertAdjacentHTML("afterbegin", `<p class="message error">${esc(error.message)}</p>`);
  }
}

async function markAllNotificationsRead() {
  try {
    await api("/api/portal/v1/me/notifications/read-all", { method: "PUT", body: "{}" });
    portalState.notifications.forEach((item) => { item.read_at ||= new Date().toISOString(); });
    portalState.unreadNotifications = 0;
    renderNotifications();
  } catch (error) {
    el.notificationList.insertAdjacentHTML("afterbegin", `<p class="message error">${esc(error.message)}</p>`);
  }
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

function renderAmuReports() {
  el.amuReportList.innerHTML = portalState.amuReports.length ? portalState.amuReports.map((report) => {
    const documents = report.documents || [];
    const canWithdraw = ["pending", "submitted", "pending_local", "returned"].includes(report.status);
    return `<article class="request-item amu-report" data-amu-report-id="${Number(report.id)}"><div><strong>${dateText(report.incapacity_from)}–${dateText(report.incapacity_to)}</strong>${report.employee_note ? `<span>${esc(report.employee_note)}</span>` : ""}<span class="status ${esc(report.status)}">${esc(statusLabels[report.status] || report.status)}</span><div class="document-links">${documents.map((document) => { const size = document.byte_size || document.size; return `<a href="/api/portal/v1/me/amu-reports/${Number(report.id)}/documents/${encodeURIComponent(String(document.id))}/content" target="_blank" rel="noopener">${esc(document.original_filename || document.original_name || document.filename || "Dokument")}${size ? ` · ${formatBytes(size)}` : ""}</a>`; }).join("")}</div></div>${canWithdraw ? '<button class="cancel-request" data-withdraw-amu type="button">Zurückziehen</button>' : ""}</article>`;
  }).join("") : '<p class="empty-state">Noch keine AMU-Meldung vorhanden.</p>';
}

async function loadAmuReports() {
  try {
    const data = await api("/api/portal/v1/me/amu-reports");
    portalState.amuReports = data.reports || data.items || [];
    renderAmuReports();
  } catch (error) {
    el.amuReportList.innerHTML = `<p class="message error">${esc(error.message)}</p>`;
  }
}

async function submitAmuReport(event) {
  event.preventDefault();
  const documents = [...el.amuDocuments.files];
  if (documents.length > 3) {
    message(el.amuMessage, "Bitte höchstens drei Dokumente auswählen.", true);
    return;
  }
  if (el.amuIncapacityTo.value < el.amuIncapacityFrom.value) {
    message(el.amuMessage, "Das Bis-Datum darf nicht vor dem Von-Datum liegen.", true);
    return;
  }
  const allowedTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);
  const allowedExtensions = /\.(pdf|jpe?g|png)$/i;
  if (documents.some((file) => file.type ? !allowedTypes.has(file.type) : !allowedExtensions.test(file.name || ""))) {
    message(el.amuMessage, "Erlaubt sind ausschließlich PDF-, JPG- und PNG-Dateien.", true);
    return;
  }
  const body = new FormData();
  body.append("incapacityFrom", el.amuIncapacityFrom.value);
  body.append("incapacityTo", el.amuIncapacityTo.value);
  body.append("employeeNote", el.amuEmployeeNote.value);
  documents.forEach((file) => body.append("documents", file));
  el.amuSubmitButton.disabled = true;
  try {
    await api("/api/portal/v1/me/amu-reports", { method: "POST", body });
    el.amuReportForm.reset();
    message(el.amuMessage, "Die AMU wurde sicher übermittelt.");
    await Promise.allSettled([loadAmuReports(), loadNotifications()]);
  } catch (error) {
    message(el.amuMessage, error.message, true);
  } finally {
    el.amuSubmitButton.disabled = false;
  }
}

async function withdrawAmuReport(id) {
  if (!confirm("Diese AMU-Meldung wirklich zurückziehen?")) return;
  try {
    await api(`/api/portal/v1/me/amu-reports/${id}/withdraw`, { method: "POST", body: "{}" });
    await Promise.allSettled([loadAmuReports(), loadNotifications()]);
  } catch (error) {
    message(el.amuMessage, error.message, true);
  }
}

function openVacationChange(groupId, requestType) {
  const item = el.approvedVacationList.querySelector(`[data-vacation-group="${CSS.escape(groupId)}"]`);
  if (!item) return;
  const dateMatch = item.querySelector("strong").textContent.match(/(\d{2}\.\d{2}\.\d{4}) – (\d{2}\.\d{2}\.\d{4})/);
  const toIso = (value) => value ? value.split(".").reverse().join("-") : "";
  portalState.vacationChange = { groupId, requestType };
  el.vacationChangeTitle.textContent = requestType === "cancel" ? "Stornierung beantragen" : "Änderung beantragen";
  el.vacationChangeOriginal.textContent = `Bisher: ${dateMatch?.[1] || ""} – ${dateMatch?.[2] || ""}`;
  el.vacationChangeDates.classList.toggle("hidden", requestType === "cancel");
  el.vacationChangeFrom.required = requestType === "change";
  el.vacationChangeTo.required = requestType === "change";
  el.vacationChangeFrom.value = toIso(dateMatch?.[1]);
  el.vacationChangeTo.value = toIso(dateMatch?.[2]);
  el.vacationChangeNote.value = "";
  message(el.vacationChangeMessage, "");
  el.vacationChangeDialog.showModal();
}

async function submitVacationChange(event) {
  event.preventDefault();
  const change = portalState.vacationChange;
  if (!change) return;
  try {
    await api("/api/portal/v1/me/vacation-change-requests", {
      method: "POST",
      body: JSON.stringify({
        groupId: change.groupId,
        requestType: change.requestType,
        dateFrom: el.vacationChangeFrom.value,
        dateTo: el.vacationChangeTo.value,
        note: el.vacationChangeNote.value,
      }),
    });
    el.vacationChangeDialog.close();
    await loadApprovedVacations();
  } catch (error) { message(el.vacationChangeMessage, error.message, true); }
}

async function changePassword(event) {
  event.preventDefault();
  if (el.newPassword.value !== el.repeatPassword.value) {
    message(el.passwordMessage, "Die neuen Passwörter stimmen nicht überein.", true);
    return;
  }
  try {
    await api("/api/portal/v1/me/password", {
      method: "PUT",
      body: JSON.stringify({ currentPassword: el.currentPassword.value, newPassword: el.newPassword.value }),
    });
    el.passwordDialog.dataset.required = "false";
    el.passwordForm.reset();
    message(el.passwordMessage, "Passwort wurde geändert.");
    setTimeout(async () => { el.passwordDialog.close(); await loadPortalData(); }, 700);
  } catch (error) { message(el.passwordMessage, error.message, true); }
}

function togglePassword(button) {
  const input = button.closest(".password-field")?.querySelector("input");
  if (!input) return;
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  button.textContent = visible ? "Anzeigen" : "Verbergen";
  button.setAttribute("aria-label", visible ? "Passwort anzeigen" : "Passwort verbergen");
}

el.portalLoginForm.addEventListener("submit", login);
el.logoutButton.addEventListener("click", logout);
el.changePasswordButton.addEventListener("click", () => el.passwordDialog.showModal());
el.passwordForm.addEventListener("submit", changePassword);
document.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-password-toggle]");
  if (toggle) togglePassword(toggle);
});
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => {
  if (el.passwordDialog.dataset.required !== "true") el.passwordDialog.close();
}));
document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
document.querySelector(".portal-tabs")?.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...document.querySelectorAll("[data-tab]")];
  const current = tabs.indexOf(document.activeElement);
  let next = current;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.length - 1;
  else next = (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
  setTab(tabs[next].dataset.tab);
});
el.previousWeek.addEventListener("click", () => { portalState.weekStart = addDays(portalState.weekStart, -7); loadSchedule(); });
el.nextWeek.addEventListener("click", () => { portalState.weekStart = addDays(portalState.weekStart, 7); loadSchedule(); });
el.currentWeek.addEventListener("click", () => { portalState.weekStart = mondayOf(new Date()); loadSchedule(); });
el.timeOffRequestForm.addEventListener("submit", submitTimeOff);
el.timeOffDate.addEventListener("change", loadTimeOffSlots);
el.timeOffStart.addEventListener("change", updateTimeOffEndSlots);
el.timeOffEnd.addEventListener("change", checkTimeOff);
el.timeOffRequestList.addEventListener("click", (event) => {
  const button = event.target.closest(".cancel-request");
  if (button) cancelTimeOff(button.closest("[data-time-off-request-id]").dataset.timeOffRequestId);
});
el.vacationRequestForm.addEventListener("submit", submitVacation);
[el.vacationDateFrom, el.vacationDateTo].forEach((field) => field.addEventListener("input", checkVacation));
el.vacationRequestList.addEventListener("click", (event) => {
  const button = event.target.closest(".cancel-request");
  if (button) cancelVacation(button.closest("[data-request-id]").dataset.requestId);
});
el.approvedVacationList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-vacation-action]");
  if (button && !button.disabled) openVacationChange(button.closest("[data-vacation-group]").dataset.vacationGroup, button.dataset.vacationAction);
});
el.vacationChangeForm.addEventListener("submit", submitVacationChange);
document.querySelectorAll("[data-close-vacation-change]").forEach((button) => button.addEventListener("click", () => el.vacationChangeDialog.close()));
el.historyTypeFilter.addEventListener("change", renderAbsenceHistory);
el.historyStatusFilter.addEventListener("change", renderAbsenceHistory);
el.absenceHistoryList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-history]");
  const item = button?.closest("[data-history-id]");
  if (item) openHistoryDetail(item.dataset.historyId, item.dataset.historyKind);
});
document.querySelectorAll("[data-close-history-detail]").forEach((button) => button.addEventListener("click", () => el.historyDetailDialog.close()));
el.notificationsButton.addEventListener("click", async () => {
  await loadNotifications();
  el.notificationsButton.setAttribute("aria-expanded", "true");
  el.notificationsDialog.showModal();
});
el.notificationsDialog.addEventListener("close", () => el.notificationsButton.setAttribute("aria-expanded", "false"));
document.querySelectorAll("[data-close-notifications]").forEach((button) => button.addEventListener("click", () => el.notificationsDialog.close()));
el.notificationList.addEventListener("click", (event) => {
  const item = event.target.closest("[data-notification-id]");
  if (item) readNotification(item.dataset.notificationId);
});
el.markAllNotificationsRead.addEventListener("click", markAllNotificationsRead);
el.amuReportForm.addEventListener("submit", submitAmuReport);
el.amuReportList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-withdraw-amu]");
  const report = button?.closest("[data-amu-report-id]");
  if (report) withdrawAmuReport(report.dataset.amuReportId);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && portalState.session) loadNotifications();
});
setInterval(() => {
  if (!document.hidden && portalState.session) loadNotifications();
}, 45000);

initialize();
