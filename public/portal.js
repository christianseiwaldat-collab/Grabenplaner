const portalState = {
  session: null,
  weekStart: mondayOf(new Date()),
  timeOffCheck: null,
  vacationCheck: null,
  vacationChange: null,
  timeOffChange: null,
  absenceHistory: [],
  notifications: [],
  unreadNotifications: 0,
  amuReports: [],
  amuPolicy: null,
  activeTab: "schedule",
  timeTracking: null,
  timeTrackingLoading: false,
  timeTrackingBooking: false,
  editingTimeOffId: null,
  editingVacationId: null,
  timeOffArchive: false,
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
  "vacationView", "historyView", "amuView", "timeTrackingTab", "timeTrackingView", "timeTrackingDate", "timeTrackingRefresh", "timeTrackingCard",
  "timeTrackingIndicator", "timeTrackingState", "timeTrackingReason", "timeTrackingActions", "timeTrackingMessage", "timePlanned", "timeActual", "timeDifference", "timeEntryList",
  "scheduleHeading", "scheduleGrid", "previousWeek", "currentWeek", "nextWeek",
  "timeOffRequestForm", "timeOffFormTitle", "timeOffDate", "timeOffDateTo", "timeOffDateToField", "timeOffTimeFields", "timeOffStart", "timeOffEnd", "timeOffNote", "timeOffCheck", "timeOffMessage",
  "timeOffSubmitButton", "cancelTimeOffEdit", "timeOffArchiveToggle", "timeOffRequestList", "vacationRequestForm", "vacationFormTitle", "vacationDateFrom", "vacationDateTo", "vacationNote",
  "vacationCheck", "vacationMessage", "vacationSubmitButton", "cancelVacationEdit", "vacationRequestList", "approvedVacationList", "passwordDialog",
  "passwordForm", "currentPassword", "newPassword", "repeatPassword", "passwordMessage", "vacationChangeDialog", "timeOffChangeDialog",
  "vacationChangeForm", "vacationChangeTitle", "vacationChangeOriginal", "vacationChangeDates", "vacationChangeFrom",
  "vacationChangeTo", "vacationChangeNote", "vacationChangeMessage", "historyTypeFilter", "historyStatusFilter", "absenceHistoryList",
  "timeOffChangeForm", "timeOffChangeTitle", "timeOffChangeOriginal", "timeOffChangeFields", "timeOffChangeFrom", "timeOffChangeTo",
  "timeOffChangeToField", "timeOffChangeTimes", "timeOffChangeStart", "timeOffChangeEnd", "timeOffChangeNote", "timeOffChangeMessage",
  "historyDetailDialog", "historyDetailTitle", "historyDetailSummary", "historyDecisionTimeline", "notificationsDialog", "notificationList",
  "markAllNotificationsRead", "amuReportForm", "amuIncapacityFrom", "amuIncapacityTo", "amuEmployeeNote", "amuDocuments",
  "amuMessage", "amuSubmitButton", "amuReportList", "amuCamera", "amuUploadHint", "portalDeploymentBanner",
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

function timeText(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function durationText(value, signed = false) {
  const minutes = Math.round(Number(value) || 0);
  const absolute = Math.abs(minutes);
  const prefix = signed ? (minutes > 0 ? "+" : minutes < 0 ? "−" : "±") : "";
  return `${prefix}${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, "0")} h`;
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

function timeTrackingCapabilityEnabled() {
  return portalState.status?.capabilities?.timeTracking === true;
}

function applyPortalCapabilities() {
  const timeTrackingEnabled = timeTrackingCapabilityEnabled();
  el.timeTrackingTab?.classList.toggle("hidden", !timeTrackingEnabled);
  if (!timeTrackingEnabled && portalState.activeTab === "timeTracking") setTab("schedule");
}

function applyRequestedTab() {
  const requested = new URLSearchParams(location.search).get("tab");
  const tab = requested === "requests" ? "history" : requested;
  if (["schedule", "timeTracking", "timeOff", "vacation", "history", "amu"].includes(tab)) setTab(tab);
}

async function initialize() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    [el.timeOffDate, el.timeOffDateTo, el.vacationDateFrom, el.vacationDateTo, el.amuIncapacityFrom, el.amuIncapacityTo].forEach((input) => { if (input) input.min = today; });
    const status = await api("/api/portal/v1/status");
    portalState.status = status;
    applyPortalBranding(status.branding);
    el.portalDeploymentBanner?.classList.toggle("hidden", status.deploymentKind !== "codespaces-test");
    applyPortalCapabilities();
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
  const requests = [
    loadSchedule(), loadVacationRequests(), loadTimeOffRequests(), loadApprovedVacations(),
    loadAbsenceHistory(), loadNotifications(), loadAmuReports(), loadAmuSettings(),
  ];
  if (timeTrackingCapabilityEnabled()) requests.push(loadTimeTracking());
  await Promise.allSettled(requests);
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
  if (tab === "timeTracking" && !timeTrackingCapabilityEnabled()) tab = "schedule";
  portalState.activeTab = tab;
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  el.scheduleView.classList.toggle("active", tab === "schedule");
  el.timeTrackingView.classList.toggle("active", tab === "timeTracking");
  el.timeOffView.classList.toggle("active", tab === "timeOff");
  el.vacationView.classList.toggle("active", tab === "vacation");
  el.historyView.classList.toggle("active", tab === "history");
  el.amuView.classList.toggle("active", tab === "amu");
  if (tab === "timeOff") loadTimeOffRequests();
  if (tab === "timeTracking") loadTimeTracking();
  if (tab === "vacation") loadVacationRequests();
  if (tab === "history") Promise.allSettled([loadAbsenceHistory(), loadApprovedVacations()]);
  if (tab === "amu") Promise.allSettled([loadAmuReports(), loadAmuSettings()]);
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

const timeEntryLabels = {
  clock_in: "Kommen",
  break_start: "Pause",
  break_end: "Weiter",
  clock_out: "Gehen",
};

const timeStateLabels = {
  off: "Nicht eingestempelt",
  not_working: "Nicht eingestempelt",
  working: "Im Dienst",
  paused: "In Pause",
  attention: "Prüfung erforderlich",
};

const timeStateReasons = {
  off: "Du kannst deinen Arbeitstag mit „Kommen“ beginnen.",
  not_working: "Du kannst deinen Arbeitstag mit „Kommen“ beginnen.",
  working: "Deine Arbeitszeit läuft.",
  paused: "Deine Pause läuft.",
};

function timeEntryTimestamp(entry) {
  return entry.entryTimestamp || entry.entry_timestamp || entry.timestamp || "";
}

function renderTimeTracking() {
  const data = portalState.timeTracking;
  if (!data) return;
  const enabled = data.enabled === true;
  const state = data.state || "off";
  const allowedActions = new Set(Array.isArray(data.allowedActions) ? data.allowedActions : []);
  const workDate = data.workDate || data.work_date || data.date || iso(new Date());
  const entries = [...(Array.isArray(data.entries) ? data.entries : [])]
    .sort((left, right) => String(timeEntryTimestamp(left)).localeCompare(String(timeEntryTimestamp(right))));

  el.timeTrackingDate.textContent = `Heute, ${dateText(workDate, { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" })}`;
  el.timeTrackingState.textContent = enabled ? (timeStateLabels[state] || "Zeiterfassung") : "Nicht aktiviert";
  el.timeTrackingIndicator.className = `time-state-indicator ${enabled ? state : "disabled"}`;

  let reason = data.reason || (enabled ? timeStateReasons[state] : "Die Zeiterfassung ist für deinen Standort nicht aktiviert.");
  if (data.staleEntry) {
    const staleDate = data.staleEntry.date || data.staleEntry.workDate || data.staleEntry.work_date;
    reason = staleDate
      ? `Eine Buchung vom ${dateText(staleDate)} ist noch offen. Bitte wende dich an deine Leitung.`
      : "Eine frühere Buchung ist noch offen. Bitte wende dich an deine Leitung.";
  }
  el.timeTrackingReason.textContent = reason;
  el.timeTrackingCard.classList.toggle("time-unavailable", !enabled || Boolean(data.staleEntry));

  el.timeTrackingActions.querySelectorAll("[data-time-action]").forEach((button) => {
    const allowed = enabled && !data.staleEntry && allowedActions.has(button.dataset.timeAction);
    button.disabled = portalState.timeTrackingLoading || portalState.timeTrackingBooking || !allowed;
    button.setAttribute("aria-disabled", String(button.disabled));
  });

  el.timePlanned.textContent = durationText(data.plannedMinutes);
  el.timeActual.textContent = durationText(data.actualMinutes);
  el.timeDifference.textContent = durationText(data.differenceMinutes, true);
  el.timeDifference.classList.toggle("positive", Number(data.differenceMinutes) > 0);
  el.timeDifference.classList.toggle("negative", Number(data.differenceMinutes) < 0);

  el.timeEntryList.innerHTML = entries.length ? entries.map((entry) => {
    const type = entry.type || entry.entryType || entry.entry_type;
    return `<article class="time-entry ${esc(type)}"><span class="time-entry-dot" aria-hidden="true"></span><div><strong>${esc(timeEntryLabels[type] || type || "Buchung")}</strong><small>${esc(timeText(timeEntryTimestamp(entry)))} Uhr</small></div></article>`;
  }).join("") : '<p class="empty-state">Heute noch keine Buchung.</p>';
}

async function loadTimeTracking() {
  if (!portalState.session || !timeTrackingCapabilityEnabled() || portalState.timeTrackingLoading || portalState.timeTrackingBooking) return;
  portalState.timeTrackingLoading = true;
  el.timeTrackingRefresh.disabled = true;
  el.timeTrackingCard.setAttribute("aria-busy", "true");
  if (portalState.timeTracking) renderTimeTracking();
  try {
    const result = await api("/api/portal/v1/me/time-entries");
    portalState.timeTracking = result.status || result.timeTracking || result;
    message(el.timeTrackingMessage, "");
    renderTimeTracking();
  } catch (error) {
    message(el.timeTrackingMessage, error.message, true);
  } finally {
    portalState.timeTrackingLoading = false;
    el.timeTrackingRefresh.disabled = false;
    el.timeTrackingCard.removeAttribute("aria-busy");
    renderTimeTracking();
  }
}

async function bookTimeEntry(type) {
  if (portalState.timeTrackingBooking || !timeTrackingCapabilityEnabled()) return;
  const allowed = new Set(portalState.timeTracking?.allowedActions || []);
  if (!allowed.has(type)) return;
  portalState.timeTrackingBooking = true;
  message(el.timeTrackingMessage, "Buchung wird gespeichert …");
  renderTimeTracking();
  try {
    const result = await api("/api/portal/v1/me/time-entries", {
      method: "POST",
      body: JSON.stringify({ type }),
    });
    portalState.timeTracking = result.status || result.timeTracking || result;
    message(el.timeTrackingMessage, `${timeEntryLabels[type] || "Buchung"} wurde gespeichert.`);
  } catch (error) {
    message(el.timeTrackingMessage, error.message, true);
  } finally {
    portalState.timeTrackingBooking = false;
    renderTimeTracking();
  }
}

function updateTraffic(node, result, emptyText) {
  const traffic = result?.trafficLight || "neutral";
  node.classList.remove("neutral", "green", "yellow", "red");
  node.classList.add(traffic);
  node.querySelector("strong").textContent = ({ green: "Nach aktuellem Stand möglich", yellow: "Manuelle Prüfung erforderlich", red: "Derzeit nicht möglich" })[traffic] || "Zeitraum eingeben";
  node.querySelector("small").textContent = result?.reason || emptyText;
}

let timeOffCheckTimer;
function timeOffMode() {
  return document.querySelector('input[name="timeOffMode"]:checked')?.value || "hours";
}

function timeOffPayload() {
  const mode = timeOffMode();
  return {
    date: el.timeOffDate.value,
    dateFrom: el.timeOffDate.value,
    dateTo: mode === "range" ? el.timeOffDateTo.value : el.timeOffDate.value,
    allDay: mode !== "hours",
    startTime: mode === "hours" ? el.timeOffStart.value : "",
    endTime: mode === "hours" ? el.timeOffEnd.value : "",
    note: el.timeOffNote.value,
    approvalType: document.querySelector('input[name="timeOffApprovalType"]:checked')?.value || "local",
  };
}

function updateTimeOffMode() {
  const mode = timeOffMode();
  const hourly = mode === "hours";
  el.timeOffTimeFields.classList.toggle("hidden", !hourly);
  [el.timeOffStart, el.timeOffEnd].forEach((field) => {
    field.required = hourly;
    field.disabled = !hourly || !el.timeOffDate.value || (field === el.timeOffEnd && !el.timeOffStart.value);
  });
  el.timeOffDateToField.classList.toggle("hidden", mode !== "range");
  el.timeOffDateTo.required = mode === "range";
  el.timeOffDateTo.min = el.timeOffDate.value || new Date().toISOString().slice(0, 10);
  if (mode === "range" && (!el.timeOffDateTo.value || el.timeOffDateTo.value < el.timeOffDate.value)) el.timeOffDateTo.value = el.timeOffDate.value;
  checkTimeOff();
}

async function checkTimeOff() {
  clearTimeout(timeOffCheckTimer);
  const payload = timeOffPayload();
  if (!payload.dateFrom || (timeOffMode() === "range" && !payload.dateTo) || (timeOffMode() === "hours" && (!payload.startTime || !payload.endTime))) {
    portalState.timeOffCheck = null;
    el.timeOffSubmitButton.disabled = true;
    updateTraffic(el.timeOffCheck, null, "Danach wird die aktuelle Planung geprüft.");
    return;
  }
  timeOffCheckTimer = setTimeout(async () => {
    try {
      const result = await api("/api/portal/v1/me/time-off-check", {
        method: "POST",
        body: JSON.stringify({ ...payload, excludeRequestId: portalState.editingTimeOffId }),
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
  if (timeOffMode() !== "hours") {
    el.timeOffStart.disabled = true;
    el.timeOffEnd.disabled = true;
    return;
  }
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
  const [data, approvedData] = await Promise.all([
    api("/api/portal/v1/me/time-off-requests"),
    api("/api/portal/v1/me/approved-time-off"),
  ]);
  const approvedRequests = (approvedData.requests || []).map((item) => ({
    ...item,
    date_from: item.date_from || item.dateFrom || item.request_date,
    date_to: item.date_to || item.dateTo || item.date_from || item.dateFrom || item.request_date,
    start_time: item.start_time || item.startTime || "",
    end_time: item.end_time || item.endTime || "",
    all_day: item.all_day ?? item.allDay ?? false,
    status: "approved",
  }));
  const approvedIds = new Set(approvedRequests.map((item) => Number(item.id)));
  portalState.timeOffRequests = [...(data.requests || []).filter((item) => !approvedIds.has(Number(item.id))), ...approvedRequests];
  portalState.pendingTimeOffChanges = approvedData.pendingChanges || [];
  const pendingByRequest = new Map(portalState.pendingTimeOffChanges.map((item) => [
    Number(item.original_request_id ?? item.time_off_request_id ?? item.request_id),
    item,
  ]));
  const today = new Date().toISOString().slice(0, 10);
  const requests = portalState.timeOffRequests.filter((item) => portalState.timeOffArchive ? (item.date_to || item.request_date) < today : (item.date_to || item.request_date) >= today || ["pending","pending_local","preliminary_local","pending_hr"].includes(item.status));
  el.timeOffArchiveToggle.textContent = portalState.timeOffArchive ? "Aktuelle Anträge" : "Archiv";
  el.timeOffRequestList.innerHTML = requests.length ? requests.map((item) => {
    const pendingChange = pendingByRequest.get(Number(item.id));
    const approvedFuture = item.status === "approved" && (item.date_to || item.request_date) >= today && !portalState.timeOffArchive;
    const pendingLabel = pendingChange ? (pendingChange.request_type === "cancel" ? "Stornierung beantragt" : "Änderung beantragt") : "";
    return `
    <article class="request-item" data-time-off-request-id="${item.id}"><div>
      <strong>${dateText(item.date_from || item.request_date)}${(item.date_to || item.request_date) !== (item.date_from || item.request_date) ? ` – ${dateText(item.date_to)}` : ""}${item.all_day ? " · ganztägig" : ` · ${esc(item.start_time)}–${esc(item.end_time)}`}</strong>
      <span>${item.approval_type === "hr" ? "Verbindlicher PL-ZA" : "Filialinterner ZA"}</span>
      ${item.note ? `<span>${esc(item.note)}</span>` : ""}
      <span class="status ${item.status}">${statusLabels[item.status] || esc(item.status)}</span>
      ${pendingChange ? `<span class="pending-change">${pendingLabel}</span>` : ""}
      ${["pending","pending_local","preliminary_local","pending_hr"].includes(item.status) ? `<span>${esc(item.check_reason)}</span>` : ""}
      ${item.local_approved_by ? `<span>Filiale: ${esc(item.local_approved_by)}</span>` : ""}${item.hr_approved_by ? `<span>Personalleitung: ${esc(item.hr_approved_by)}</span>` : ""}
    </div>${["pending","pending_local","preliminary_local","pending_hr"].includes(item.status) ? '<div class="request-actions"><button class="text-button edit-request" type="button">Bearbeiten</button><button class="cancel-request" type="button">Zurückziehen</button></div>' : approvedFuture ? `<div class="request-actions approved-time-off-actions"><button class="text-button" data-time-off-action="change" type="button" ${pendingChange ? "disabled" : ""}>Änderung beantragen</button><button class="cancel-request" data-time-off-action="cancel" type="button" ${pendingChange ? "disabled" : ""}>Stornierung beantragen</button></div>` : ""}</article>
  `;
  }).join("") : "<p>Noch keine ZA-Anträge vorhanden.</p>";
}

async function editTimeOff(id) {
  const item = portalState.timeOffRequests.find((request) => Number(request.id) === Number(id));
  if (!item) return;
  portalState.editingTimeOffId = Number(id);
  const mode = item.all_day ? ((item.date_to || item.request_date) !== (item.date_from || item.request_date) ? "range" : "day") : "hours";
  document.querySelector(`input[name="timeOffMode"][value="${mode}"]`).checked = true;
  el.timeOffDate.value = item.date_from || item.request_date;
  el.timeOffDateTo.value = item.date_to || item.request_date;
  el.timeOffNote.value = item.note || "";
  document.querySelector(`input[name="timeOffApprovalType"][value="${item.approval_type || "local"}"]`).checked = true;
  updateTimeOffMode();
  if (mode === "hours") {
    await loadTimeOffSlots();
    el.timeOffStart.value = item.start_time;
    updateTimeOffEndSlots();
    el.timeOffEnd.value = item.end_time;
    checkTimeOff();
  }
  el.timeOffFormTitle.textContent = "ZA-Antrag bearbeiten";
  el.timeOffSubmitButton.textContent = "Änderung einreichen";
  el.cancelTimeOffEdit.classList.remove("hidden");
  el.timeOffRequestForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetTimeOffForm() {
  portalState.editingTimeOffId = null;
  el.timeOffRequestForm.reset();
  document.querySelector('input[name="timeOffMode"][value="hours"]').checked = true;
  el.timeOffFormTitle.textContent = "Neuer ZA-Antrag";
  el.timeOffSubmitButton.textContent = "Antrag absenden";
  el.cancelTimeOffEdit.classList.add("hidden");
  updateTimeOffMode();
}

async function submitTimeOff(event) {
  event.preventDefault();
  if (!portalState.timeOffCheck?.allowed) return;
  try {
    await api(portalState.editingTimeOffId ? `/api/portal/v1/me/time-off-requests/${portalState.editingTimeOffId}` : "/api/portal/v1/me/time-off-requests", {
      method: portalState.editingTimeOffId ? "PUT" : "POST",
      body: JSON.stringify(timeOffPayload()),
    });
    resetTimeOffForm();
    portalState.timeOffCheck = null;
    el.timeOffSubmitButton.disabled = true;
    el.timeOffStart.disabled = true;
    el.timeOffEnd.disabled = true;
    updateTraffic(el.timeOffCheck, null, "Danach wird die aktuelle Planung geprüft.");
    message(el.timeOffMessage, "Der ZA-Antrag wurde gespeichert und erneut zur Genehmigung eingereicht.");
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

function timeOffChangeMode() {
  return document.querySelector('input[name="timeOffChangeMode"]:checked')?.value || "hours";
}

function updateTimeOffChangeMode() {
  const mode = timeOffChangeMode();
  const change = portalState.timeOffChange;
  const editingPeriod = change?.requestType === "change";
  el.timeOffChangeFields.classList.toggle("hidden", !editingPeriod);
  el.timeOffChangeToField.classList.toggle("hidden", mode !== "range");
  el.timeOffChangeTimes.classList.toggle("hidden", mode !== "hours");
  el.timeOffChangeFrom.required = editingPeriod;
  el.timeOffChangeTo.required = editingPeriod && mode === "range";
  el.timeOffChangeStart.required = editingPeriod && mode === "hours";
  el.timeOffChangeEnd.required = editingPeriod && mode === "hours";
  el.timeOffChangeTo.min = el.timeOffChangeFrom.value || new Date().toISOString().slice(0, 10);
  if (mode === "range" && (!el.timeOffChangeTo.value || el.timeOffChangeTo.value < el.timeOffChangeFrom.value)) {
    el.timeOffChangeTo.value = el.timeOffChangeFrom.value;
  }
}

function timeOffPeriodText(item) {
  const from = item.date_from || item.request_date;
  const to = item.date_to || from;
  return `${dateText(from)}${to !== from ? ` – ${dateText(to)}` : ""}${item.all_day ? " · ganztägig" : ` · ${item.start_time}–${item.end_time}`}`;
}

function openTimeOffChange(requestId, requestType) {
  const item = portalState.timeOffRequests.find((request) => Number(request.id) === Number(requestId) && request.status === "approved");
  if (!item) return;
  const from = item.date_from || item.request_date;
  const to = item.date_to || from;
  const mode = item.all_day ? (to !== from ? "range" : "day") : "hours";
  portalState.timeOffChange = { requestId: Number(requestId), requestType };
  el.timeOffChangeTitle.textContent = requestType === "cancel" ? "Stornierung beantragen" : "Änderung beantragen";
  el.timeOffChangeOriginal.textContent = `Bisher: ${timeOffPeriodText(item)}`;
  document.querySelector(`input[name="timeOffChangeMode"][value="${mode}"]`).checked = true;
  el.timeOffChangeFrom.value = from;
  el.timeOffChangeTo.value = to;
  el.timeOffChangeStart.value = item.start_time || "";
  el.timeOffChangeEnd.value = item.end_time || "";
  el.timeOffChangeNote.value = "";
  message(el.timeOffChangeMessage, "");
  updateTimeOffChangeMode();
  el.timeOffChangeDialog.showModal();
}

async function submitTimeOffChange(event) {
  event.preventDefault();
  const change = portalState.timeOffChange;
  if (!change) return;
  const mode = timeOffChangeMode();
  const dateFrom = el.timeOffChangeFrom.value;
  const dateTo = mode === "range" ? el.timeOffChangeTo.value : dateFrom;
  if (change.requestType === "change" && mode === "hours" && el.timeOffChangeEnd.value <= el.timeOffChangeStart.value) {
    message(el.timeOffChangeMessage, "Die Bis-Zeit muss nach der Von-Zeit liegen.", true);
    return;
  }
  try {
    await api("/api/portal/v1/me/time-off-change-requests", {
      method: "POST",
      body: JSON.stringify({
        requestId: change.requestId,
        requestType: change.requestType,
        dateFrom,
        dateTo,
        allDay: mode !== "hours",
        startTime: mode === "hours" ? el.timeOffChangeStart.value : "",
        endTime: mode === "hours" ? el.timeOffChangeEnd.value : "",
        note: el.timeOffChangeNote.value,
      }),
    });
    el.timeOffChangeDialog.close();
    portalState.timeOffChange = null;
    message(el.timeOffMessage, change.requestType === "cancel" ? "Die Stornierung wurde beantragt." : "Die Änderung wurde beantragt.");
    await Promise.allSettled([loadTimeOffRequests(), loadAbsenceHistory(), loadNotifications()]);
  } catch (error) {
    message(el.timeOffChangeMessage, error.message, true);
  }
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
  portalState.vacationRequests = data.requests || [];
  el.vacationRequestList.innerHTML = data.requests.length ? data.requests.map((item) => `
    <article class="request-item" data-request-id="${item.id}"><div><strong>${dateText(item.date_from)} – ${dateText(item.date_to)}</strong>
      ${item.note ? `<span>${esc(item.note)}</span>` : ""}<span class="status ${item.status}">${statusLabels[item.status] || esc(item.status)}</span>
      ${item.local_approved_by ? `<span>Filiale: ${esc(item.local_approved_by)}</span>` : ""}${item.hr_approved_by ? `<span>Personalleitung: ${esc(item.hr_approved_by)}</span>` : ""}
    </div>${["pending","pending_local","preliminary_local","pending_hr"].includes(item.status) ? '<div class="request-actions"><button class="text-button edit-request" type="button">Bearbeiten</button><button class="cancel-request" type="button">Zurückziehen</button></div>' : ""}</article>
  `).join("") : "<p>Noch keine Urlaubsanträge vorhanden.</p>";
}

function editVacation(id) {
  const item = portalState.vacationRequests.find((request) => Number(request.id) === Number(id));
  if (!item) return;
  portalState.editingVacationId = Number(id);
  el.vacationDateFrom.value = item.date_from;
  el.vacationDateTo.value = item.date_to;
  el.vacationDateTo.min = item.date_from;
  el.vacationNote.value = item.note || "";
  el.vacationFormTitle.textContent = "Urlaubsantrag bearbeiten";
  el.vacationSubmitButton.textContent = "Änderung einreichen";
  el.cancelVacationEdit.classList.remove("hidden");
  checkVacation();
  el.vacationRequestForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetVacationForm() {
  portalState.editingVacationId = null;
  el.vacationRequestForm.reset();
  el.vacationFormTitle.textContent = "Neuer Antrag";
  el.vacationSubmitButton.textContent = "Antrag absenden";
  el.cancelVacationEdit.classList.add("hidden");
  el.vacationDateTo.min = el.vacationDateFrom.min;
}

async function submitVacation(event) {
  event.preventDefault();
  if (!portalState.vacationCheck?.allowed) return;
  try {
    await api(portalState.editingVacationId ? `/api/portal/v1/me/vacation-requests/${portalState.editingVacationId}` : "/api/portal/v1/me/vacation-requests", {
      method: portalState.editingVacationId ? "PUT" : "POST",
      body: JSON.stringify({ dateFrom: el.vacationDateFrom.value, dateTo: el.vacationDateTo.value, note: el.vacationNote.value }),
    });
    resetVacationForm();
    portalState.vacationCheck = null;
    el.vacationSubmitButton.disabled = true;
    updateTraffic(el.vacationCheck, null, "Antragssperren werden sofort geprüft.");
    message(el.vacationMessage, "Der Urlaubsantrag wurde gespeichert und zur Genehmigung eingereicht.");
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
  if (item.kind === "time_off_change") return "ZA-Änderung";
  if (item.kind === "time_off_cancel") return "ZA-Stornierung";
  if (item.kind === "vacation_change" || item.request_type === "change") return "Urlaubsänderung";
  if (item.kind === "vacation_cancel" || item.request_type === "cancel") return "Urlaubsstorno";
  return "Urlaub";
}

function requestPeriodText(item) {
  if (item.kind === "time_off") {
    const from = item.date_from || item.request_date;
    const to = item.date_to || item.request_date;
    return `${dateText(from)}${to !== from ? `–${dateText(to)}` : ""}${item.all_day ? " · ganztägig" : ` · ${esc(item.start_time)}–${esc(item.end_time)}`}`;
  }
  if (item.kind === "time_off_change") {
    const original = `${dateText(item.original_date_from)}${item.original_date_to !== item.original_date_from ? `–${dateText(item.original_date_to)}` : ""}`;
    const requested = `${dateText(item.requested_date_from)}${item.requested_date_to !== item.requested_date_from ? `–${dateText(item.requested_date_to)}` : ""}${item.requested_all_day ? " · ganztägig" : ` · ${esc(item.requested_start_time)}–${esc(item.requested_end_time)}`}`;
    return `${original} → ${requested}`;
  }
  if (item.kind === "time_off_cancel") {
    return `${dateText(item.original_date_from)}${item.original_date_to !== item.original_date_from ? `–${dateText(item.original_date_to)}` : ""}`;
  }
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
  const typeMatches = type === "all" || (type === "time_off" ? item.kind.startsWith("time_off") : !item.kind.startsWith("time_off"));
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

async function loadAmuSettings() {
  try {
    const data = await api("/api/portal/v1/amu-settings");
    portalState.amuPolicy = data.policy || null;
    if (el.amuUploadHint && data.policy) {
      const conversion = data.policy.convertImagesToPdf ? ` · Fotos werden${data.policy.grayscaleImages ? " in Graustufen" : ""} als PDF gespeichert` : "";
      el.amuUploadHint.textContent = `PDF oder Foto · höchstens 3 Dateien · je max. ${String(data.policy.uploadMaxMb).replace(".", ",")} MB${conversion}`;
    }
  } catch {
    portalState.amuPolicy = null;
  }
}

function renderAmuReports() {
  el.amuReportList.innerHTML = portalState.amuReports.length ? portalState.amuReports.map((report) => {
    const documents = report.documents || [];
    const canWithdraw = ["pending", "submitted", "pending_local", "returned"].includes(report.status);
    return `<article class="request-item amu-report" data-amu-report-id="${Number(report.id)}"><div><strong>${dateText(report.incapacity_from)}–${dateText(report.incapacity_to)}</strong>${report.employee_note ? `<span>${esc(report.employee_note)}</span>` : ""}<span class="status ${esc(report.status)}">${esc(statusLabels[report.status] || report.status)}</span><div class="document-links">${documents.map((document) => { const size = document.byte_size || document.size; return `<a href="/api/portal/v1/me/amu-reports/${Number(report.id)}/documents/${encodeURIComponent(String(document.id))}/content" target="_blank" rel="noopener">${esc(document.original_filename || document.original_name || document.filename || "Dokument")}${size ? ` · ${formatBytes(size)}` : ""}</a>`; }).join("")}</div></div>${canWithdraw ? '<button class="cancel-request" data-withdraw-amu type="button">Zurückziehen</button>' : ""}</article>`;
  }).join("") : '<p class="empty-state">Noch keine AUM-Meldung vorhanden.</p>';
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
  const documents = [...el.amuDocuments.files, ...el.amuCamera.files];
  if (!documents.length) {
    message(el.amuMessage, "Bitte mindestens ein Dokument auswählen oder mit der Kamera fotografieren.", true);
    return;
  }
  if (documents.length > 3) {
    message(el.amuMessage, "Bitte höchstens drei Dokumente auswählen.", true);
    return;
  }
  if (el.amuIncapacityTo.value < el.amuIncapacityFrom.value) {
    message(el.amuMessage, "Das Bis-Datum darf nicht vor dem Von-Datum liegen.", true);
    return;
  }
  const allowedTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/tiff"]);
  const allowedExtensions = /\.(pdf|jpe?g|png|webp|tiff?)$/i;
  if (documents.some((file) => file.type ? !allowedTypes.has(file.type) : !allowedExtensions.test(file.name || ""))) {
    message(el.amuMessage, "Erlaubt sind PDF-, JPG-, PNG-, WEBP- und TIFF-Dateien.", true);
    return;
  }
  const maxBytes = Number(portalState.amuPolicy?.uploadMaxMb || 10) * 1024 * 1024;
  if (documents.some((file) => file.size > maxBytes)) {
    message(el.amuMessage, `Eine Datei ist größer als ${String(portalState.amuPolicy?.uploadMaxMb || 10).replace(".", ",")} MB.`, true);
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
    message(el.amuMessage, "Die AUM wurde sicher übermittelt.");
    await Promise.allSettled([loadAmuReports(), loadNotifications()]);
  } catch (error) {
    message(el.amuMessage, error.message, true);
  } finally {
    el.amuSubmitButton.disabled = false;
  }
}

async function withdrawAmuReport(id) {
  if (!confirm("Diese AUM-Meldung wirklich zurückziehen?")) return;
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
  const tabs = [...document.querySelectorAll("[data-tab]:not(.hidden)")];
  const current = tabs.indexOf(document.activeElement);
  let next = current;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.length - 1;
  else next = (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
  setTab(tabs[next].dataset.tab);
});
el.timeTrackingRefresh.addEventListener("click", loadTimeTracking);
el.timeTrackingActions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-time-action]");
  if (button && !button.disabled) bookTimeEntry(button.dataset.timeAction);
});
el.previousWeek.addEventListener("click", () => { portalState.weekStart = addDays(portalState.weekStart, -7); loadSchedule(); });
el.nextWeek.addEventListener("click", () => { portalState.weekStart = addDays(portalState.weekStart, 7); loadSchedule(); });
el.currentWeek.addEventListener("click", () => { portalState.weekStart = mondayOf(new Date()); loadSchedule(); });
el.timeOffRequestForm.addEventListener("submit", submitTimeOff);
el.timeOffDate.addEventListener("change", loadTimeOffSlots);
el.timeOffDate.addEventListener("change", updateTimeOffMode);
el.timeOffDateTo.addEventListener("change", checkTimeOff);
document.querySelectorAll('input[name="timeOffMode"]').forEach((input) => input.addEventListener("change", updateTimeOffMode));
el.timeOffStart.addEventListener("change", updateTimeOffEndSlots);
el.timeOffEnd.addEventListener("change", checkTimeOff);
el.timeOffRequestList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-time-off-request-id]");
  const approvedAction = event.target.closest("[data-time-off-action]");
  if (approvedAction && !approvedAction.disabled) {
    openTimeOffChange(row.dataset.timeOffRequestId, approvedAction.dataset.timeOffAction);
    return;
  }
  if (event.target.closest(".cancel-request")) cancelTimeOff(row.dataset.timeOffRequestId);
  if (event.target.closest(".edit-request")) editTimeOff(row.dataset.timeOffRequestId);
});
el.cancelTimeOffEdit.addEventListener("click", resetTimeOffForm);
el.timeOffArchiveToggle.addEventListener("click", () => { portalState.timeOffArchive = !portalState.timeOffArchive; loadTimeOffRequests(); });
el.vacationRequestForm.addEventListener("submit", submitVacation);
[el.vacationDateFrom, el.vacationDateTo].forEach((field) => field.addEventListener("input", checkVacation));
el.vacationDateFrom.addEventListener("input", () => {
  el.vacationDateTo.min = el.vacationDateFrom.value;
  if (el.vacationDateTo.value && el.vacationDateTo.value < el.vacationDateFrom.value) el.vacationDateTo.value = el.vacationDateFrom.value;
});
el.vacationRequestList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-request-id]");
  if (event.target.closest(".cancel-request")) cancelVacation(row.dataset.requestId);
  if (event.target.closest(".edit-request")) editVacation(row.dataset.requestId);
});
el.cancelVacationEdit.addEventListener("click", resetVacationForm);
el.approvedVacationList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-vacation-action]");
  if (button && !button.disabled) openVacationChange(button.closest("[data-vacation-group]").dataset.vacationGroup, button.dataset.vacationAction);
});
el.vacationChangeForm.addEventListener("submit", submitVacationChange);
document.querySelectorAll("[data-close-vacation-change]").forEach((button) => button.addEventListener("click", () => el.vacationChangeDialog.close()));
el.timeOffChangeForm.addEventListener("submit", submitTimeOffChange);
document.querySelectorAll('input[name="timeOffChangeMode"]').forEach((input) => input.addEventListener("change", updateTimeOffChangeMode));
el.timeOffChangeFrom.addEventListener("change", updateTimeOffChangeMode);
el.timeOffChangeTo.addEventListener("change", updateTimeOffChangeMode);
document.querySelectorAll("[data-close-time-off-change]").forEach((button) => button.addEventListener("click", () => {
  portalState.timeOffChange = null;
  el.timeOffChangeDialog.close();
}));
document.querySelectorAll("[data-history-kind]").forEach((button) => button.addEventListener("click", () => {
  el.historyTypeFilter.value = button.dataset.historyKind;
  document.querySelectorAll("[data-history-kind]").forEach((item) => item.classList.toggle("active", item === button));
  renderAbsenceHistory();
}));
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
el.amuIncapacityFrom.addEventListener("input", () => {
  el.amuIncapacityTo.min = el.amuIncapacityFrom.value || new Date().toISOString().slice(0, 10);
  if (el.amuIncapacityTo.value && el.amuIncapacityTo.value < el.amuIncapacityFrom.value) el.amuIncapacityTo.value = el.amuIncapacityFrom.value;
});
el.amuReportList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-withdraw-amu]");
  const report = button?.closest("[data-amu-report-id]");
  if (report) withdrawAmuReport(report.dataset.amuReportId);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && portalState.session) {
    loadNotifications();
    if (portalState.activeTab === "timeTracking") loadTimeTracking();
  }
});
setInterval(() => {
  if (!document.hidden && portalState.session) loadNotifications();
}, 45000);
setInterval(() => {
  if (!document.hidden && portalState.session && portalState.activeTab === "timeTracking") loadTimeTracking();
}, 30000);

initialize();
