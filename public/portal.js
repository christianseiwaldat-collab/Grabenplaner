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
  timePeriod: "week",
  timePeriodAnchor: iso(new Date()),
  timeSummary: null,
  timeCorrections: [],
  timeTrackingLoading: false,
  timeTrackingBooking: false,
  mobileLayout: null,
  mobileLeadership: false,
  leadershipOverview: null,
  leadershipLocations: [],
  leadershipLocationId: "",
  leadershipDepartmentId: "",
  leadershipKind: "absence",
  leadershipRequests: [],
  leadershipAmuReports: [],
  selectedLeadershipRequest: null,
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
  if (portalState.session) applyMobileLeadershipLayout();
}
applyDeviceMode();
window.addEventListener("resize", applyDeviceMode, { passive: true });

const el = Object.fromEntries([
  "portalLogin", "portalLoginForm", "loginPersonnelNumber", "loginPassword", "loginError", "portalApp", "portalLogo", "portalAccessModeLabel",
  "portalUserName", "portalUserRole", "adminAppLink", "changePasswordButton", "logoutButton", "notificationsButton", "notificationBadge", "scheduleView", "timeOffView",
  "vacationView", "historyView", "amuView", "timeTrackingTab", "timeTrackingView", "timeTrackingDate", "timeTrackingRefresh", "timeTrackingCard",
  "timeTrackingIndicator", "timeTrackingState", "timeTrackingReason", "timeTrackingActions", "timeTrackingMessage", "timePlanned", "timeActual", "timeDifference", "timeEntryList",
  "timePeriodHeading", "timePeriodSummary", "timePeriodList", "previousTimePeriod", "currentTimePeriod", "nextTimePeriod",
  "leadershipTeamTab", "leadershipApprovalsTab", "leadershipMoreTab", "leadershipTeamView", "leadershipApprovalsView", "leadershipMoreView",
  "leadershipTeamRefresh", "leadershipApprovalsRefresh", "leadershipContextFields", "leadershipLocation", "leadershipDepartment", "leadershipApprovalContextFields", "leadershipApprovalLocation", "leadershipApprovalDepartment", "leadershipPresenceSummary", "leadershipPresenceList", "leadershipApprovalList",
  "leadershipPasswordButton", "leadershipDesktopLink", "timeCorrectionDialog", "timeCorrectionForm", "timeCorrectionId", "timeCorrectionDate", "timeCorrectionDateText", "timeCorrectionEntries", "timeCorrectionNote", "timeCorrectionMessage", "addTimeCorrectionEntry",
  "leadershipRequestDialog", "leadershipRequestForm", "leadershipRequestTitle", "leadershipRequestSummary", "leadershipCorrectionEntries", "addLeadershipCorrectionEntry", "leadershipRequestNote", "leadershipRequestMessage", "leadershipRequestActions",
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

function addMonths(value, amount) {
  const date = new Date(`${value}T12:00:00`);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + amount);
  date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  return iso(date);
}

function isMobileUi() {
  return document.documentElement.dataset.uiMode === "mobile";
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

function portalUser() {
  return portalState.session?.user || null;
}

function isLeadershipUser(user = portalUser()) {
  return ["department_manager", "manager", "hr", "admin"].includes(user?.role);
}

const mobileModuleAliases = {
  time: "time",
  timeTracking: "time",
  time_tracking: "time",
  presence: "presence",
  team: "presence",
  team_now: "presence",
  approvals: "approvals",
  requests_review: "approvals",
  schedule: "schedule",
  plan: "schedule",
  requests: "requests",
  history: "requests",
  own_requests: "requests",
  more: "more",
};

function normalizedMobileModules(value) {
  const list = Array.isArray(value) ? value : [];
  const normalized = list.map((item) => {
    if (typeof item === "string") return mobileModuleAliases[item] || item;
    if (item?.enabled === false || item?.visible === false) return "";
    return mobileModuleAliases[item?.id || item?.key || item?.module] || item?.id || item?.key || item?.module || "";
  }).filter(Boolean);
  return [...new Set(normalized)].slice(0, 6);
}

function mobileModuleAllowed(module, permissions = portalUser()?.permissions || []) {
  if (module === "time") return permissions.includes("own_time:read") && timeTrackingCapabilityEnabled();
  if (module === "presence") return permissions.includes("time:read");
  if (module === "approvals") return permissions.some((permission) => ["vacation:read", "vacation:approve", "time:review", "amu:metadata:read", "amu:review"].includes(permission));
  if (module === "schedule") return permissions.includes("own_schedule:read");
  if (module === "requests") return permissions.some((permission) => ["own_vacation:read", "own_vacation:request", "own_time:read", "own_time:correction_request"].includes(permission));
  return module === "more";
}

function effectiveMobileModules() {
  const fallback = ["time", "presence", "approvals", "schedule", "requests", "more"];
  const configured = normalizedMobileModules(portalState.mobileLayout?.modules);
  const available = normalizedMobileModules(portalState.mobileLayout?.availableModules);
  const source = configured.length ? configured : fallback;
  const availability = new Set(available.length ? available : fallback);
  const modules = source.filter((module) => module !== "time" && availability.has(module) && mobileModuleAllowed(module));
  if (availability.has("time") && mobileModuleAllowed("time")) modules.unshift("time");
  return [...new Set(modules)].slice(0, 6);
}

function applyMobileLeadershipLayout() {
  const navigation = document.querySelector(".portal-tabs");
  if (!navigation) return;
  const compactLeadership = isMobileUi() && isLeadershipUser();
  portalState.mobileLeadership = compactLeadership;
  navigation.classList.toggle("mobile-leadership", compactLeadership);
  const regularTabs = ["schedule", "timeTracking", "timeOff", "vacation", "history", "amu"];
  document.querySelectorAll(".leadership-tab").forEach((button) => button.classList.add("hidden"));
  if (!compactLeadership) {
    regularTabs.forEach((tab) => {
      const button = document.querySelector(`[data-tab="${tab}"]`);
      button?.classList.toggle("hidden", tab === "timeTracking" && !timeTrackingCapabilityEnabled());
      button?.style.removeProperty("order");
    });
    document.querySelectorAll(".leadership-tab").forEach((button) => button.style.removeProperty("order"));
    navigation.style.removeProperty("--mobile-module-count");
    if (["leadershipTeam", "leadershipApprovals", "leadershipMore"].includes(portalState.activeTab)) setTab("timeTracking");
    return;
  }
  document.querySelectorAll("[data-tab]").forEach((button) => button.classList.add("hidden"));
  const moduleTabs = {
    time: "timeTracking",
    presence: "leadershipTeam",
    approvals: "leadershipApprovals",
    schedule: "schedule",
    requests: "history",
    more: "leadershipMore",
  };
  const modules = effectiveMobileModules();
  modules.forEach((module, index) => {
    const button = document.querySelector(`[data-tab="${moduleTabs[module]}"]`);
    button?.classList.remove("hidden");
    if (button) button.style.order = String(index);
  });
  navigation.style.setProperty("--mobile-module-count", String(Math.max(1, modules.length)));
  const activeButton = document.querySelector(`[data-tab="${portalState.activeTab}"]`);
  if (activeButton?.classList.contains("hidden") && modules.length) setTab(moduleTabs[modules[0]]);
}

async function loadMobileLayout() {
  if (!isLeadershipUser()) {
    portalState.mobileLayout = null;
    applyMobileLeadershipLayout();
    return;
  }
  try {
    portalState.mobileLayout = await api("/api/portal/v1/mobile-layout");
  } catch {
    portalState.mobileLayout = { modules: ["time", "presence", "approvals", "schedule", "requests", "more"] };
  }
  applyMobileLeadershipLayout();
}

function normalizedPortalTab(requested) {
  const aliases = { requests: "history", team: "leadershipTeam", approvals: "leadershipApprovals", more: "leadershipMore", time: "timeTracking" };
  const tab = aliases[requested] || requested;
  if (["leadershipTeam", "leadershipApprovals", "leadershipMore"].includes(tab) && (!isMobileUi() || !isLeadershipUser())) return "";
  return ["schedule", "timeTracking", "timeOff", "vacation", "history", "amu", "leadershipTeam", "leadershipApprovals", "leadershipMore"].includes(tab) ? tab : "";
}

function requestedPortalTab() {
  return normalizedPortalTab(new URLSearchParams(location.search).get("tab"));
}

function chooseInitialPortalTab() {
  const requested = requestedPortalTab();
  setTab(requested || (timeTrackingCapabilityEnabled() ? "timeTracking" : "schedule"));
  return requested;
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
      await loadMobileLayout();
      const requested = chooseInitialPortalTab();
      await loadPortalData();
      if (!requested && portalState.timeTracking?.enabled !== true) setTab("schedule");
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
  if (session.status) portalState.status = session.status;
  applyPortalBranding(session.status?.branding || session.branding || portalState.status?.branding || {});
  applyPortalCapabilities();
  el.portalLogin.classList.add("hidden");
  el.portalApp.classList.remove("hidden");
  el.portalUserName.textContent = `${session.user.employeeNumber} · ${session.user.nickname || session.user.fullName}`;
  el.portalUserRole.textContent = session.user.roleName;
  el.adminAppLink.classList.toggle("hidden", !session.user.permissions.includes("schedule:read"));
  el.passwordDialog.dataset.required = session.user.mustChangePassword ? "true" : "false";
  applyMobileLeadershipLayout();
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
      await loadMobileLayout();
      const requested = chooseInitialPortalTab();
      await loadPortalData();
      if (!requested && portalState.timeTracking?.enabled !== true) setTab("schedule");
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
  el.leadershipTeamView?.classList.toggle("active", tab === "leadershipTeam");
  el.leadershipApprovalsView?.classList.toggle("active", tab === "leadershipApprovals");
  el.leadershipMoreView?.classList.toggle("active", tab === "leadershipMore");
  if (tab === "timeOff") loadTimeOffRequests();
  if (tab === "timeTracking") Promise.allSettled([loadTimeTracking(), loadTimeSummary(), loadTimeCorrections()]);
  if (tab === "vacation") loadVacationRequests();
  if (tab === "history") Promise.allSettled([loadAbsenceHistory(), loadApprovedVacations()]);
  if (tab === "amu") Promise.allSettled([loadAmuReports(), loadAmuSettings()]);
  if (tab === "leadershipTeam") loadLeadershipOverview();
  if (tab === "leadershipApprovals") loadLeadershipApprovals();
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
    loadTimeSummary();
  } catch (error) {
    message(el.timeTrackingMessage, error.message, true);
  } finally {
    portalState.timeTrackingBooking = false;
    renderTimeTracking();
  }
}

function normalizedTimeSummary(result = {}) {
  const summary = result.summary || result;
  const days = Array.isArray(summary.days) ? summary.days : [];
  return {
    ...summary,
    days: days.map((day) => ({
      ...day,
      date: day.date || day.workDate || day.work_date,
      plannedMinutes: Number(day.plannedMinutes ?? day.planned_minutes ?? 0),
      actualMinutes: Number(day.actualMinutes ?? day.actual_minutes ?? 0),
      differenceMinutes: Number(day.differenceMinutes ?? day.difference_minutes ?? 0),
      entries: Array.isArray(day.entries) ? day.entries : [],
    })),
  };
}

function correctionRequestedChange(correction = {}) {
  const raw = correction.requestedChange ?? correction.requested_change ?? correction.change ?? {};
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

function correctionDate(correction = {}) {
  return correction.correctionDate || correction.correction_date || correction.date || "";
}

function renderTimeSummary() {
  const summary = portalState.timeSummary;
  if (!summary) return;
  const days = summary.days || [];
  const totals = summary.totals || {
    plannedMinutes: days.reduce((sum, day) => sum + day.plannedMinutes, 0),
    actualMinutes: days.reduce((sum, day) => sum + day.actualMinutes, 0),
    differenceMinutes: days.reduce((sum, day) => sum + day.differenceMinutes, 0),
  };
  const from = summary.from || days[0]?.date || portalState.timePeriodAnchor;
  const to = summary.to || days.at(-1)?.date || portalState.timePeriodAnchor;
  el.timePeriodHeading.textContent = portalState.timePeriod === "month"
    ? dateText(from, { month: "long", year: "numeric" })
    : `${dateText(from)} – ${dateText(to)}`;
  el.timePeriodSummary.innerHTML = [
    ["Soll", totals.plannedMinutes ?? totals.planned_minutes],
    ["Ist", totals.actualMinutes ?? totals.actual_minutes],
    ["Differenz", totals.differenceMinutes ?? totals.difference_minutes, true],
  ].map(([label, value, signed]) => `<article><span>${label}</span><strong>${durationText(value, Boolean(signed))}</strong></article>`).join("");
  const correctionByDate = new Map();
  for (const correction of portalState.timeCorrections) {
    const date = correctionDate(correction);
    const current = correctionByDate.get(date);
    if (!current || (current.status !== "pending" && correction.status === "pending")) correctionByDate.set(date, correction);
  }
  const canRequest = portalUser()?.permissions?.includes("own_time:correction_request");
  const today = iso(new Date());
  el.timePeriodList.innerHTML = days.length ? days.map((day) => {
    const correction = correctionByDate.get(day.date) || day.correction;
    const entryText = day.entries.length
      ? day.entries.map((entry) => `${timeEntryLabels[entry.type || entry.entry_type] || entry.type || entry.entry_type}: ${entry.time || timeText(timeEntryTimestamp(entry))}`).join(" · ")
      : "Keine Buchung";
    const correctionStatus = correction?.status ? `<small class="time-period-correction">Korrektur: ${esc(statusLabels[correction.status] || correction.status)}</small>` : "";
    const difference = Number(day.differenceMinutes || 0);
    return `<article class="time-period-day ${day.date === today ? "today" : ""}" data-time-summary-date="${esc(day.date)}">
      <div><strong>${dateText(day.date, { weekday: "short", day: "2-digit", month: "2-digit" })}</strong><small>${esc(entryText)}</small>${correctionStatus}</div>
      <div class="time-period-value"><span>Soll</span><strong>${durationText(day.plannedMinutes)}</strong></div>
      <div class="time-period-value"><span>Ist</span><strong>${durationText(day.actualMinutes)}</strong></div>
      <div class="time-period-value"><span>Diff.</span><strong class="${difference < 0 ? "negative" : difference > 0 ? "positive" : ""}">${durationText(difference, true)}</strong></div>
      ${canRequest && day.date <= today && correction?.status !== "approved" ? `<button type="button" data-open-time-correction>${correction?.status === "pending" ? "Antrag bearbeiten" : "Korrektur anfragen"}</button>` : ""}
    </article>`;
  }).join("") : '<p class="empty-state">Für diesen Zeitraum gibt es noch keine Arbeitszeitdaten.</p>';
}

async function loadTimeSummary() {
  if (!portalState.session || !timeTrackingCapabilityEnabled()) return;
  try {
    const parameters = new URLSearchParams({ period: portalState.timePeriod, anchor: portalState.timePeriodAnchor });
    portalState.timeSummary = normalizedTimeSummary(await api(`/api/portal/v1/me/time-summary?${parameters}`));
    renderTimeSummary();
  } catch (error) {
    el.timePeriodList.innerHTML = `<p class="empty-state">${esc(error.message)}</p>`;
  }
}

async function loadTimeCorrections() {
  if (!portalUser()?.permissions?.includes("own_time:correction_request")) return;
  try {
    const result = await api("/api/portal/v1/me/time-corrections");
    portalState.timeCorrections = result.corrections || result.requests || (Array.isArray(result) ? result : []);
    renderTimeSummary();
  } catch {
    portalState.timeCorrections = [];
  }
}

function correctionEntryTime(entry, date) {
  const direct = entry.time || entry.entryTime || entry.entry_time;
  if (direct) return String(direct).slice(0, 5);
  const timestamp = timeEntryTimestamp(entry);
  if (!timestamp) return "";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed);
}

function appendCorrectionEntry(entry = {}, container = el.timeCorrectionEntries) {
  const type = entry.type || entry.entryType || entry.entry_type || "clock_in";
  const row = document.createElement("div");
  row.className = "correction-entry-row";
  row.innerHTML = `<label><span>Buchung</span><select data-correction-type>${Object.entries(timeEntryLabels).map(([value, label]) => `<option value="${value}" ${value === type ? "selected" : ""}>${label}</option>`).join("")}</select></label><label><span>Uhrzeit</span><input data-correction-time type="time" step="60" value="${esc(entry.time || "")}" required /></label><button type="button" data-remove-correction-entry aria-label="Buchung entfernen">×</button>`;
  container.append(row);
}

function openTimeCorrection(date) {
  const day = portalState.timeSummary?.days?.find((item) => item.date === date);
  if (!day) return;
  const correction = portalState.timeCorrections.find((item) => correctionDate(item) === date && item.status === "pending") || null;
  const requested = correctionRequestedChange(correction || {});
  const entries = requested.proposedEntries || requested.entries || day.entries || [];
  el.timeCorrectionId.value = correction?.id || "";
  el.timeCorrectionDate.value = date;
  el.timeCorrectionDateText.textContent = `${dateText(date, { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" })} · bestehende Buchungen werden zur Prüfung mitgesendet.`;
  el.timeCorrectionNote.value = correction?.note || requested.note || "";
  el.timeCorrectionEntries.innerHTML = "";
  entries.forEach((entry) => appendCorrectionEntry({ ...entry, time: correctionEntryTime(entry, date) }));
  if (!entries.length) {
    appendCorrectionEntry({ type: "clock_in", time: "" });
    appendCorrectionEntry({ type: "clock_out", time: "" });
  }
  let withdraw = el.timeCorrectionForm.querySelector("[data-withdraw-time-correction]");
  if (correction && !withdraw) {
    withdraw = document.createElement("button");
    withdraw.type = "button";
    withdraw.className = "cancel-request";
    withdraw.dataset.withdrawTimeCorrection = "";
    withdraw.textContent = "Antrag zurückziehen";
    el.timeCorrectionForm.querySelector(".dialog-actions")?.prepend(withdraw);
  }
  withdraw?.classList.toggle("hidden", !correction);
  message(el.timeCorrectionMessage, "");
  el.timeCorrectionDialog.showModal();
}

function timeCorrectionPayload() {
  const proposedEntries = [...el.timeCorrectionEntries.querySelectorAll(".correction-entry-row")].map((row) => ({
    type: row.querySelector("[data-correction-type]").value,
    time: row.querySelector("[data-correction-time]").value,
  }));
  return {
    date: el.timeCorrectionDate.value,
    correctionDate: el.timeCorrectionDate.value,
    note: el.timeCorrectionNote.value,
    entries: proposedEntries,
    proposedEntries,
  };
}

async function submitTimeCorrection(event) {
  event.preventDefault();
  const entries = timeCorrectionPayload().proposedEntries;
  if (!entries.length || entries.some((entry) => !entry.type || !entry.time)) {
    message(el.timeCorrectionMessage, "Bitte alle Buchungen und Uhrzeiten vollständig eintragen.", true);
    return;
  }
  const id = el.timeCorrectionId.value;
  try {
    await api(id ? `/api/portal/v1/me/time-corrections/${id}` : "/api/portal/v1/me/time-corrections", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(timeCorrectionPayload()),
    });
    el.timeCorrectionDialog.close();
    await Promise.allSettled([loadTimeCorrections(), loadTimeSummary(), loadNotifications()]);
  } catch (error) {
    message(el.timeCorrectionMessage, error.message, true);
  }
}

async function withdrawTimeCorrection() {
  const id = el.timeCorrectionId.value;
  if (!id || !confirm("Diesen Korrekturantrag wirklich zurückziehen?")) return;
  try {
    await api(`/api/portal/v1/me/time-corrections/${id}`, { method: "DELETE" });
    el.timeCorrectionDialog.close();
    await Promise.allSettled([loadTimeCorrections(), loadTimeSummary()]);
  } catch (error) {
    message(el.timeCorrectionMessage, error.message, true);
  }
}

function leadershipQuery() {
  const parameters = new URLSearchParams();
  if (portalState.leadershipLocationId) parameters.set("locationId", portalState.leadershipLocationId);
  if (portalState.leadershipDepartmentId) parameters.set("departmentId", portalState.leadershipDepartmentId);
  return parameters;
}

async function loadLeadershipContexts() {
  if (portalState.leadershipLocations.length) return;
  try {
    const result = await api("/api/locations");
    portalState.leadershipLocations = (Array.isArray(result) ? result : result.locations || []).filter((location) => location.active !== false);
  } catch {
    portalState.leadershipLocations = [...new Set((portalUser()?.scopes || []).map((scope) => scope.locationId))]
      .map((locationId) => ({ id: locationId, name: `Filiale ${locationId}`, departments: [] }));
  }
  const scoped = portalUser()?.scopes || [];
  const preferredLocation = scoped[0]?.locationId || portalUser()?.homeLocationId || portalState.leadershipLocations[0]?.id || "";
  if (!portalState.leadershipLocations.some((location) => location.id === portalState.leadershipLocationId)) portalState.leadershipLocationId = preferredLocation;
  const preferredDepartment = scoped.find((scope) => scope.locationId === portalState.leadershipLocationId)?.departmentId || "";
  if (!portalState.leadershipDepartmentId) portalState.leadershipDepartmentId = preferredDepartment ? String(preferredDepartment) : "";
  renderLeadershipContexts();
}

function renderLeadershipContexts() {
  const user = portalUser();
  const locations = portalState.leadershipLocations;
  const location = locations.find((item) => item.id === portalState.leadershipLocationId);
  const scopedDepartments = new Set((user?.scopes || []).filter((scope) => scope.locationId === portalState.leadershipLocationId && scope.departmentId).map((scope) => Number(scope.departmentId)));
  const departments = (location?.departments || []).filter((department) => user?.role !== "department_manager" || scopedDepartments.has(Number(department.id)));
  const allowWholeLocation = user?.role !== "department_manager";
  if (!allowWholeLocation && !departments.some((department) => String(department.id) === portalState.leadershipDepartmentId)) portalState.leadershipDepartmentId = departments[0] ? String(departments[0].id) : String([...scopedDepartments][0] || "");
  const locationOptions = locations.map((item) => `<option value="${esc(item.id)}" ${item.id === portalState.leadershipLocationId ? "selected" : ""}>${esc(item.id)} · ${esc(item.name)}</option>`).join("");
  const departmentOptions = `${allowWholeLocation ? '<option value="">Gesamte Filiale</option>' : ""}${departments.map((department) => `<option value="${department.id}">${esc(department.name)}</option>`).join("")}`;
  for (const [locationSelect, departmentSelect, fields] of [
    [el.leadershipLocation, el.leadershipDepartment, el.leadershipContextFields],
    [el.leadershipApprovalLocation, el.leadershipApprovalDepartment, el.leadershipApprovalContextFields],
  ]) {
    if (!locationSelect || !departmentSelect) continue;
    locationSelect.innerHTML = locationOptions;
    locationSelect.value = portalState.leadershipLocationId;
    departmentSelect.innerHTML = departmentOptions;
    departmentSelect.value = portalState.leadershipDepartmentId;
    locationSelect.disabled = locations.length < 2;
    departmentSelect.disabled = departments.length + (allowWholeLocation ? 1 : 0) < 2;
    fields?.classList.toggle("hidden", locations.length < 2 && departmentSelect.disabled);
  }
}

function normalizedLeadershipOverview(result = {}) {
  return result.overview || result;
}

function leadershipPresence(overview = portalState.leadershipOverview || {}) {
  return overview.presence || overview.timePresence || overview.team || overview;
}

function renderLeadershipPresence() {
  const presence = leadershipPresence();
  const employees = presence.employees || presence.members || [];
  const stateCounts = employees.reduce((counts, employee) => {
    const state = employee.state || "off";
    counts[state] = (counts[state] || 0) + 1;
    return counts;
  }, {});
  const counts = portalState.leadershipOverview?.counts || presence.counts || {};
  el.leadershipPresenceSummary.innerHTML = [
    ["Im Dienst", counts.working ?? stateCounts.working ?? 0],
    ["In Pause", counts.paused ?? stateCounts.paused ?? 0],
    ["Prüfen", counts.attention ?? stateCounts.attention ?? 0],
  ].map(([label, value]) => `<article><span>${label}</span><strong>${Number(value || 0)}</strong></article>`).join("");
  el.leadershipPresenceList.innerHTML = employees.length ? employees.map((employee) => {
    const state = employee.state || "off";
    const entries = (employee.entries || []).map((entry) => `${timeEntryLabels[entry.type || entry.entry_type] || entry.type}: ${entry.time || timeText(timeEntryTimestamp(entry))}`).join(" · ");
    return `<article class="leadership-person"><span class="leadership-person-dot" style="--person-color:${esc(employee.color || "#7b8983")}"></span><div><strong>${esc(employee.employeeNumber || employee.employee_number)} · ${esc(employee.nickname || employee.fullName || employee.full_name)}</strong><small>${esc(entries || "Heute noch keine Buchung")} · Soll ${durationText(employee.plannedMinutes ?? employee.planned_minutes)} · Ist ${durationText(employee.actualMinutes ?? employee.actual_minutes)}</small></div><span class="leadership-person-state ${esc(state)}">${esc(timeStateLabels[state] || "Nicht da")}</span></article>`;
  }).join("") : '<p class="empty-state">Für diesen Bereich sind heute keine Teamdaten vorhanden.</p>';
}

async function loadLeadershipOverview() {
  if (!isLeadershipUser()) return;
  await loadLeadershipContexts();
  el.leadershipPresenceList.innerHTML = '<p class="empty-state">Teamstatus wird geladen.</p>';
  try {
    portalState.leadershipOverview = normalizedLeadershipOverview(await api(`/api/portal/v1/leadership/overview?${leadershipQuery()}`));
    renderLeadershipPresence();
  } catch (error) {
    el.leadershipPresenceList.innerHTML = `<p class="empty-state">${esc(error.message)}</p>`;
  }
}

function leadershipRequestActionable(request) {
  if (!["pending", "pending_local", "preliminary_local", "pending_hr"].includes(request.status)) return false;
  const role = portalUser()?.role;
  const stage = request.approval_stage || request.approvalStage;
  if (stage === "hr") return ["hr", "admin"].includes(role);
  return role !== "hr";
}

function requestKindLabel(request) {
  const kind = request.kind || request.request_kind;
  if (kind === "time_off" || kind?.startsWith("time_off")) return "ZA";
  if (kind === "vacation_change") return "Urlaubsänderung";
  if (kind === "vacation_cancel") return "Urlaubsstorno";
  return "Urlaub";
}

function leadershipItemInContext(item) {
  const itemLocation = item.locationId || item.location_id || item.scoped_location_id || item.home_location_id || "";
  const itemDepartment = Number(item.departmentId || item.department_id || item.preferred_department_id || 0) || null;
  if (portalState.leadershipLocationId && itemLocation && itemLocation !== portalState.leadershipLocationId) return false;
  if (portalState.leadershipDepartmentId && itemDepartment && itemDepartment !== Number(portalState.leadershipDepartmentId)) return false;
  return true;
}

function leadershipRequestPeriodText(request) {
  const from = request.date_from || request.request_date || request.requested_date_from || request.correction_date;
  const to = request.date_to || request.requested_date_to || from;
  if (!from) return "";
  const time = request.all_day || request.requested_all_day ? " · ganztägig" : request.start_time ? ` · ${request.start_time}–${request.end_time}` : "";
  return `${dateText(from)}${to && to !== from ? ` – ${dateText(to)}` : ""}${time}`;
}

function renderLeadershipApprovals() {
  const kind = portalState.leadershipKind;
  let items = [];
  if (kind === "absence") items = portalState.leadershipRequests.filter(leadershipRequestActionable).filter(leadershipItemInContext);
  else if (kind === "amu") items = portalState.leadershipAmuReports.filter((report) => ["submitted", "returned"].includes(report.status)).filter(leadershipItemInContext);
  else {
    const overview = portalState.leadershipOverview || {};
    items = overview.timeCorrections || overview.time_corrections || overview.corrections || [];
    items = items.filter((item) => (!item.status || item.status === "pending") && leadershipItemInContext(item));
  }
  el.leadershipApprovalList.innerHTML = items.length ? items.map((item) => {
    const employeeNumber = item.employee_number || item.employeeNumber || "";
    const name = item.nickname || item.full_name || item.fullName || "";
    const label = kind === "amu" ? "AUM" : kind === "time_correction" ? "Zeitkorrektur" : requestKindLabel(item);
    const period = kind === "amu" ? `${dateText(item.incapacity_from)} – ${dateText(item.incapacity_to)}` : leadershipRequestPeriodText(item);
    return `<article class="leadership-request-row" data-leadership-request-id="${esc(item.id)}" data-leadership-request-kind="${esc(kind)}"><div><strong>${esc(label)} · ${esc(employeeNumber)} · ${esc(name)}</strong><small>${esc(period)}${item.note || item.employee_note ? ` · ${esc(item.note || item.employee_note)}` : ""}</small><span class="status ${esc(item.status || "pending")}">${esc(statusLabels[item.status] || item.status || "Offen")}</span></div><button type="button" data-open-leadership-request>Bearbeiten</button></article>`;
  }).join("") : '<p class="empty-state">Derzeit ist in diesem Bereich nichts zu bearbeiten.</p>';
}

async function loadLeadershipApprovals() {
  if (!isLeadershipUser()) return;
  await loadLeadershipContexts();
  el.leadershipApprovalList.innerHTML = '<p class="empty-state">Freigaben werden geladen.</p>';
  portalState.leadershipRequests = [];
  portalState.leadershipAmuReports = [];
  portalState.leadershipOverview = null;
  const permissions = portalUser()?.permissions || [];
  const tasks = [api(`/api/portal/v1/leadership/overview?${leadershipQuery()}`).then((result) => { portalState.leadershipOverview = normalizedLeadershipOverview(result); })];
  if (permissions.includes("vacation:read") || permissions.includes("time:review")) tasks.push(api(`/api/portal/v1/absence-requests?${leadershipQuery()}`).then((result) => { portalState.leadershipRequests = result.requests || []; }));
  if (permissions.includes("amu:metadata:read") || permissions.includes("amu:review")) tasks.push(api(`/api/portal/v1/amu-reports?${leadershipQuery()}`).then((result) => { portalState.leadershipAmuReports = result.reports || []; }));
  const results = await Promise.allSettled(tasks);
  if (results.every((result) => result.status === "rejected")) {
    el.leadershipApprovalList.innerHTML = `<p class="empty-state">${esc(results[0].reason?.message || "Freigaben konnten nicht geladen werden.")}</p>`;
    return;
  }
  renderLeadershipApprovals();
}

function findLeadershipRequest(id, kind) {
  if (kind === "amu") return portalState.leadershipAmuReports.find((item) => String(item.id) === String(id));
  if (kind === "time_correction") {
    const overview = portalState.leadershipOverview || {};
    return (overview.timeCorrections || overview.time_corrections || overview.corrections || []).find((item) => String(item.id) === String(id));
  }
  return portalState.leadershipRequests.find((item) => String(item.id) === String(id));
}

function openLeadershipRequest(id, kind) {
  const request = findLeadershipRequest(id, kind);
  if (!request) return;
  portalState.selectedLeadershipRequest = { request, kind };
  const employeeNumber = request.employee_number || request.employeeNumber || "";
  const name = request.nickname || request.full_name || request.fullName || "";
  const title = kind === "amu" ? "AUM prüfen" : kind === "time_correction" ? "Zeitkorrektur prüfen" : `${requestKindLabel(request)} bearbeiten`;
  el.leadershipRequestTitle.textContent = title;
  el.leadershipRequestSummary.innerHTML = `<strong>${esc(employeeNumber)} · ${esc(name)}</strong><p>${esc(kind === "amu" ? `${dateText(request.incapacity_from)} – ${dateText(request.incapacity_to)}` : leadershipRequestPeriodText(request))}</p>${request.note || request.employee_note ? `<p>${esc(request.note || request.employee_note)}</p>` : ""}`;
  el.leadershipRequestNote.value = "";
  el.leadershipCorrectionEntries.innerHTML = "";
  el.leadershipCorrectionEntries.classList.toggle("hidden", kind !== "time_correction");
  el.addLeadershipCorrectionEntry.classList.toggle("hidden", kind !== "time_correction");
  if (kind === "time_correction") {
    const requested = correctionRequestedChange(request);
    const entries = request.proposedEntries || request.proposed_entries || requested.proposedEntries || requested.entries || [];
    entries.forEach((entry) => appendCorrectionEntry({ ...entry, time: correctionEntryTime(entry, correctionDate(request)) }, el.leadershipCorrectionEntries));
  }
  message(el.leadershipRequestMessage, "");
  const actions = kind === "amu"
    ? [["reviewed", "Als geprüft markieren", "primary-action"]]
    : kind === "time_correction"
      ? [["reject", "Ablehnen", "danger-action"], ["approve", "Genehmigen", "primary-action"]]
      : [["reject", "Ablehnen", "danger-action"], ...(request.status !== "pending_hr" ? [["preliminary", "Vorläufig", "secondary-action"]] : []), ["approve", "Genehmigen / weiterleiten", "primary-action"]];
  el.leadershipRequestActions.innerHTML = `<button type="button" data-close-leadership-request>Abbrechen</button>${actions.map(([action, label, className]) => `<button class="${className}" data-leadership-action="${action}" type="button">${label}</button>`).join("")}`;
  el.leadershipRequestDialog.showModal();
}

async function decideLeadershipRequest(action) {
  const selected = portalState.selectedLeadershipRequest;
  if (!selected) return;
  const { request, kind } = selected;
  let url;
  let body;
  if (kind === "amu") {
    url = `/api/portal/v1/amu-reports/${request.id}/review`;
    body = { action: "reviewed", note: el.leadershipRequestNote.value };
  } else if (kind === "time_correction") {
    url = `/api/portal/v1/time-corrections/${request.id}/decision`;
    const proposedEntries = [...el.leadershipCorrectionEntries.querySelectorAll(".correction-entry-row")].map((row) => ({
      type: row.querySelector("[data-correction-type]").value,
      time: row.querySelector("[data-correction-time]").value,
    }));
    if (action === "approve" && (!proposedEntries.length || proposedEntries.some((entry) => !entry.type || !entry.time))) {
      message(el.leadershipRequestMessage, "Bitte die korrigierte Buchungsfolge vollständig eintragen.", true);
      return;
    }
    body = { action, decision: action === "approve" ? "approved" : "rejected", note: el.leadershipRequestNote.value, entries: proposedEntries, proposedEntries };
  } else {
    const requestKind = ["vacation_change", "vacation_cancel"].includes(request.kind) ? "vacation_change"
      : ["time_off_change", "time_off_cancel"].includes(request.kind) ? "time_off_change" : request.kind;
    url = `/api/portal/v1/absence-requests/${requestKind}/${request.id}/action`;
    body = { action, note: el.leadershipRequestNote.value };
  }
  try {
    await api(url, { method: "PUT", body: JSON.stringify(body) });
    el.leadershipRequestDialog.close();
    portalState.selectedLeadershipRequest = null;
    await Promise.allSettled([loadLeadershipApprovals(), loadNotifications()]);
  } catch (error) {
    message(el.leadershipRequestMessage, error.message, true);
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
      const tab = normalizedPortalTab(requested);
      el.notificationsDialog.close();
      setTab(tab || "history");
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
    setTimeout(async () => {
      el.passwordDialog.close();
      await loadMobileLayout();
      const requested = chooseInitialPortalTab();
      await loadPortalData();
      if (!requested && portalState.timeTracking?.enabled !== true) setTab("schedule");
    }, 700);
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
document.querySelectorAll("[data-time-period]").forEach((button) => button.addEventListener("click", () => {
  portalState.timePeriod = button.dataset.timePeriod;
  portalState.timePeriodAnchor = iso(new Date());
  document.querySelectorAll("[data-time-period]").forEach((item) => item.classList.toggle("active", item === button));
  loadTimeSummary();
}));
el.previousTimePeriod.addEventListener("click", () => {
  portalState.timePeriodAnchor = portalState.timePeriod === "month" ? addMonths(portalState.timePeriodAnchor, -1) : addDays(portalState.timePeriodAnchor, -7);
  loadTimeSummary();
});
el.nextTimePeriod.addEventListener("click", () => {
  portalState.timePeriodAnchor = portalState.timePeriod === "month" ? addMonths(portalState.timePeriodAnchor, 1) : addDays(portalState.timePeriodAnchor, 7);
  loadTimeSummary();
});
el.currentTimePeriod.addEventListener("click", () => { portalState.timePeriodAnchor = iso(new Date()); loadTimeSummary(); });
el.timePeriodList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-time-summary-date]");
  if (row && event.target.closest("[data-open-time-correction]")) openTimeCorrection(row.dataset.timeSummaryDate);
});
el.timeCorrectionForm.addEventListener("submit", submitTimeCorrection);
el.addTimeCorrectionEntry.addEventListener("click", () => appendCorrectionEntry());
el.timeCorrectionEntries.addEventListener("click", (event) => {
  if (event.target.closest("[data-remove-correction-entry]")) event.target.closest(".correction-entry-row")?.remove();
});
el.timeCorrectionForm.addEventListener("click", (event) => {
  if (event.target.closest("[data-withdraw-time-correction]")) withdrawTimeCorrection();
});
document.querySelectorAll("[data-close-time-correction]").forEach((button) => button.addEventListener("click", () => el.timeCorrectionDialog.close()));
el.leadershipTeamRefresh.addEventListener("click", loadLeadershipOverview);
el.leadershipApprovalsRefresh.addEventListener("click", loadLeadershipApprovals);
function changeLeadershipLocation(event) {
  portalState.leadershipLocationId = event.currentTarget.value;
  portalState.leadershipDepartmentId = "";
  renderLeadershipContexts();
  if (portalState.activeTab === "leadershipTeam") loadLeadershipOverview();
  if (portalState.activeTab === "leadershipApprovals") loadLeadershipApprovals();
}
function changeLeadershipDepartment(event) {
  portalState.leadershipDepartmentId = event.currentTarget.value;
  renderLeadershipContexts();
  if (portalState.activeTab === "leadershipTeam") loadLeadershipOverview();
  if (portalState.activeTab === "leadershipApprovals") loadLeadershipApprovals();
}
[el.leadershipLocation, el.leadershipApprovalLocation].forEach((select) => select.addEventListener("change", changeLeadershipLocation));
[el.leadershipDepartment, el.leadershipApprovalDepartment].forEach((select) => select.addEventListener("change", changeLeadershipDepartment));
document.querySelectorAll("[data-leadership-kind]").forEach((button) => button.addEventListener("click", () => {
  portalState.leadershipKind = button.dataset.leadershipKind;
  document.querySelectorAll("[data-leadership-kind]").forEach((item) => item.classList.toggle("active", item === button));
  renderLeadershipApprovals();
}));
el.leadershipApprovalList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-leadership-request-id]");
  if (row && event.target.closest("[data-open-leadership-request]")) openLeadershipRequest(row.dataset.leadershipRequestId, row.dataset.leadershipRequestKind);
});
el.leadershipRequestActions.addEventListener("click", (event) => {
  const action = event.target.closest("[data-leadership-action]")?.dataset.leadershipAction;
  if (action) decideLeadershipRequest(action);
  else if (event.target.closest("[data-close-leadership-request]")) el.leadershipRequestDialog.close();
});
el.addLeadershipCorrectionEntry.addEventListener("click", () => appendCorrectionEntry({}, el.leadershipCorrectionEntries));
el.leadershipCorrectionEntries.addEventListener("click", (event) => {
  if (event.target.closest("[data-remove-correction-entry]")) event.target.closest(".correction-entry-row")?.remove();
});
document.querySelectorAll("[data-close-leadership-request]").forEach((button) => button.addEventListener("click", () => el.leadershipRequestDialog.close()));
document.querySelectorAll("[data-more-tab]").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.moreTab)));
el.leadershipPasswordButton.addEventListener("click", () => el.passwordDialog.showModal());
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
    if (portalState.activeTab === "leadershipTeam") loadLeadershipOverview();
    if (portalState.activeTab === "leadershipApprovals") loadLeadershipApprovals();
  }
});
setInterval(() => {
  if (!document.hidden && portalState.session) loadNotifications();
}, 45000);
setInterval(() => {
  if (!document.hidden && portalState.session && portalState.activeTab === "timeTracking") loadTimeTracking();
}, 30000);
setInterval(() => {
  if (!document.hidden && portalState.session && portalState.activeTab === "leadershipTeam") loadLeadershipOverview();
}, 30000);

initialize();
