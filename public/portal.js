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
  candidateEvaluations: [],
  candidateEvaluationsLoadPromise: null,
  candidateEvaluationsRequestGeneration: 0,
  processTasks: [],
  processTaskSummary: null,
  processTasksLoading: false,
  processTasksLoadPromise: null,
  processTasksRequestGeneration: 0,
  processTasksOwnerFingerprint: "",
  processTasksAvailable: true,
  processTasksError: "",
  processTaskCompletionPending: new Set(),
  processTaskCompletionKeys: new Map(),
  processTaskCompletionPayloads: new Map(),
  processTaskNotes: new Map(),
  processTaskMessages: new Map(),
  processTaskRequestedRunId: "",
  processTaskRequestedStepId: "",
  processTaskFlash: "",
  personnelLearningDashboard: null,
  personnelLearningDashboardLoading: false,
  personnelLearningDashboardAvailable: false,
  personnelLearningDashboardEmployeeNumber: "",
  personnelLearningProgressAssignment: null,
  personnelLearningProgressMutationPending: false,
  birthdayPresentationClaimGeneration: 0,
  birthdayPresentationClaimActor: "",
  birthdayPresentationReturnFocus: null,
  birthdayPresentationThemeGeneration: 0,
  birthdayPresentationThemeActor: "",
  birthdayPresentationThemeRefreshTimer: null,
  birthdayPresentationThemeRefreshPromise: null,
  birthdayPresentationThemeRequestController: null,
  amuReports: [],
  amuPolicy: null,
  sicknessAumAllowance: null,
  sicknessCases: [],
  leadershipSicknessCases: [],
  emailSettings: null,
  emailSettingsLoading: false,
  amuOcr: { busy: false, assisted: false, startManuallyEdited: false, endManuallyEdited: false, autoFilledStart: false, autoFilledEnd: false, identityDetected: false, fileKey: "", runToken: 0 },
  sicknessAmuOcr: { busy: false, assisted: false, startManuallyEdited: false, endManuallyEdited: false, autoFilledStart: false, autoFilledEnd: false, identityDetected: false, fileKey: "", runToken: 0 },
  activeAmuOcrContext: "amu",
  dateRangeCalendar: null,
  activeTab: "schedule",
  timeTracking: null,
  timePeriod: "week",
  timePeriodAnchor: iso(new Date()),
  timeSummary: null,
  timeCorrections: [],
  timeTrackingLoading: false,
  timeTrackingBooking: false,
  privacyRequests: [],
  privacyRequestTypes: [],
  privacyRequestsLoading: false,
  vacationAccount: null,
  vacationAccountYear: String(new Date().getFullYear()),
  timeRecordStatements: [],
  timeRecordStatementsMonth: "",
  wifiAutomation: null,
  wifiAutomationLoading: false,
  home: null,
  mobileLayout: null,
  uiPreferences: null,
  mobileNavigationDraft: null,
  mobileHomeDraft: null,
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
  loanStatus: null,
  loanOverviewItems: [],
  loanOverviewColumns: [],
  loanOverviewSearchEnabled: false,
  loans: [],
  loanTeamMembers: [],
  loanDraftItems: [],
  loanIssuePhotoFiles: [],
  loanReturnPhotoFiles: [],
  selectedLoan: null,
  selectedManagedLoan: null,
  pendingLoanConfirmations: [],
  activeLoanConfirmation: null,
  loanConfirmationLoading: false,
  branchOrderCatalog: null,
  branchOrderDraft: null,
  branchOrderDraftPending: null,
  branchOrderDraftRevision: 0,
  branchOrderDraftDirty: false,
  branchOrderDraftLoading: false,
  branchOrderDraftSaving: false,
  branchOrderSubmitting: false,
  branchOrderDraftEmployeeNumber: "",
  branchOrderSelection: new Map(),
  branchOrderReviewVisible: false,
  branchOrderAutosaveTimer: null,
  branchOrderPortalHistory: [],
  branchOrderSettings: null,
  branchOrderSettingsDraft: null,
  branchOrderSettingsUnitSort: { key: "position", direction: "asc" },
  branchOrderSettingsUnitEditingId: "",
  branchOrderHistory: [],
  branchOrderSettingsLoading: false,
  branchPortalDisplaySettings: null,
  branchPortalDisplaySettingsLoading: false,
  scheduleData: null,
  branchVacationWeekStart: mondayOf(new Date()),
  branchVacationLoading: false,
  personalActions: [],
  personalActionsCursor: "",
  personalActionsLoading: false,
  personalActionUndoPending: "",
  personalActionsActorKey: "",
  personalActionsRequestId: 0,
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
const LOAN_OVERVIEW_SEARCH_THRESHOLD = 10;
const loanOverviewColumnCatalog = Object.freeze([
  { id: "borrowerName", label: "Mitarbeiter/in", fallback: "–" },
  { id: "employeeNumber", label: "Personalnummer", fallback: "–" },
  { id: "description", label: "Gerät / Modell", fallback: "Gerät ohne Bezeichnung" },
  { id: "articleNumber", label: "Artikel-/Inventarnr.", fallback: "–" },
  { id: "serialNumber", label: "Seriennr.", fallback: "–" },
  { id: "dueDate", label: "Geplante Rückgabe", fallback: "Nicht festgelegt" },
]);
const loanOverviewColumnById = new Map(loanOverviewColumnCatalog.map((column) => [column.id, column]));
const defaultLoanOverviewColumnIds = Object.freeze(["description", "articleNumber", "serialNumber", "dueDate"]);

function normalizedLoanOverviewColumns(value) {
  const requested = Array.isArray(value) ? value.map(String) : [];
  const result = [...new Set(requested)].filter((id) => loanOverviewColumnById.has(id));
  return result.length ? result : [...defaultLoanOverviewColumnIds];
}

const statusLabels = { pending: "Offen", submitted: "Übermittelt", reported: "Gemeldet", aum_received: "AUM vorhanden", not_required: "AUM nicht erforderlich", recovered: "Wieder arbeitsfähig", pending_local: "Offen", preliminary_local: "Vorläufig genehmigt", pending_hr: "Wartet auf Personalleitung", approved: "Genehmigt", rejected: "Abgelehnt", cancelled: "Storniert", withdrawn: "Zurückgezogen", reviewed: "Geprüft", returned: "Ergänzung erforderlich", warning: "Besetzung prüfen", yellow: "AUM überfällig", red: "Rot eskaliert" };
const privacyRequestStatusLabels = {
  received: "Eingelangt",
  identity_pending: "Identität wird geprüft",
  in_review: "In Bearbeitung",
  extended: "Frist dokumentiert verlängert",
  approved: "Genehmigt",
  partially_approved: "Teilweise genehmigt",
  rejected: "Abgelehnt",
  fulfilled: "Erledigt",
  partially_fulfilled: "Teilweise erledigt",
  withdrawn: "Zurückgezogen",
};
const privacyIdentityStatusLabels = {
  pending: "Identitätsprüfung offen",
  verified: "Identität bestätigt",
  insufficient: "Weitere Identitätsprüfung nötig",
};
const defaultPrivacyRequestTypes = [
  { id: "access", label: "Auskunft" },
  { id: "rectification", label: "Berichtigung" },
  { id: "erasure", label: "Löschung" },
  { id: "restriction", label: "Einschränkung" },
  { id: "portability", label: "Datenübertragbarkeit" },
  { id: "objection", label: "Widerspruch" },
];

function amuReportStatusText(report) {
  return report?.review_mode === "automatic"
    ? "Automatisch geprüft und zugeordnet"
    : statusLabels[report?.status] || report?.status || "";
}

function applyDeviceMode() {
  const compact = window.matchMedia("(max-width: 720px)").matches;
  const touch = window.matchMedia("(pointer: coarse)").matches;
  const compactTouchScreen = window.matchMedia("(max-width: 1100px)").matches;
  const mobileHint = navigator.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  document.documentElement.dataset.uiMode = compact || (touch && (mobileHint || compactTouchScreen)) ? "mobile" : "desktop";
  document.documentElement.dataset.inputMode = touch ? "touch" : "pointer";
  if (portalState.session) applyMobileLeadershipLayout();
}
applyDeviceMode();
window.addEventListener("resize", applyDeviceMode, { passive: true });

const el = Object.fromEntries([
  "pendingCandidateEvaluationNotice", "pendingCandidateEvaluationSummary", "pendingCandidateEvaluationLink",
  "portalLogin", "portalLoginForm", "loginPersonnelNumber", "loginPassword", "loginError", "forgotPasswordButton", "passwordResetRequestDialog", "passwordResetRequestForm", "passwordResetEmail", "passwordResetRequestMessage", "passwordResetRequestSubmit", "passwordResetConfirmDialog", "passwordResetConfirmForm", "passwordResetToken", "passwordResetNewPassword", "passwordResetRepeatPassword", "passwordResetConfirmMessage", "passwordResetConfirmSubmit", "portalApp", "portalLogo", "portalAccessModeLabel",
  "portalUserName", "portalUserRole", "adminAppLink", "portalSettingsShortcut", "personalActionsButton", "personalActionsDialog", "personalActionsTitle", "personalActionsMessage", "personalActionsList", "personalActionsLoadMore", "logoutButton", "portalLogoutStatus", "notificationsButton", "notificationBadge", "mobileHomeTab", "mobileHomeView", "mobileHomeTiles", "mobileSettingsHome", "settingsView", "passwordSettingsCard", "settingsPasswordButton", "scheduleTab", "scheduleView", "timeOffTab", "timeOffView",
  "loanTab", "loanView", "leadershipLoanShortcut", "loanRefresh", "loanAvailabilityMessage", "loanWorkspace", "loanIssueForm",
  "loanOpenOverview", "loanOverviewDescription", "loanOverviewSearchField", "loanOverviewSearch", "loanOverviewTableHeader", "loanOverviewTableBody", "loanPersonalOverview",
  "loanItemEditor", "loanAddItem", "loanDueDate", "loanIssueNote", "loanIssuePhotos", "loanIssueCamera", "loanIssuePhotoPolicy", "loanIssuePhotoSummary", "loanIssueMessage", "loanIssueSubmit", "loanScopeField", "loanScope", "loanStatusFilter", "loanList",
  "loanReturnDialog", "loanReturnForm", "loanReturnTitle", "loanReturnSummary", "loanReturnItems", "loanReturnWitness", "loanReturnWitnessHint", "loanReturnNote", "loanReturnPhotos", "loanReturnCamera", "loanReturnPhotoPolicy", "loanReturnPhotoSummary", "loanReturnMessage", "loanReturnSubmit",
  "loanManageDialog", "loanManageForm", "loanManageTitle", "loanManageSummary", "loanManageDueDate", "loanManageNote", "loanManageItems", "loanManageActionHint", "loanManageMessage", "loanManageClose", "loanManageReopen", "loanManageSave",
  "loanConfirmationDialog", "loanConfirmationForm", "loanConfirmationTitle", "loanConfirmationSummary", "loanConfirmationItems", "loanConfirmationNote",
  "loanConfirmationPhotos", "loanConfirmationExpiry", "loanConfirmationMessage", "loanConfirmationReject", "loanConfirmationSubmit",
  "branchOrdersTab", "branchOrderSettingsTab", "branchOrdersView", "branchOrderRefresh", "branchOrderForm", "branchOrderEmployee", "branchOrderWeek", "branchOrderGroups", "branchOrderMessage", "branchOrderSubmit", "branchOrderSaveDraft", "branchOrderDraftPanel", "branchOrderDraftTitle", "branchOrderDraftDetail", "branchOrderContinueDraft", "branchOrderDiscardDraft", "branchOrderPortalHistoryRefresh", "branchOrderPortalHistoryList", "branchOrderReview", "branchOrderReviewList", "branchOrderBackToEdit", "branchMobileActionBar", "branchMobileBack", "branchMobileReview", "branchMobileSubmit", "branchMobileSave",
  "branchVacationTab", "branchVacationView", "branchVacationPrevious", "branchVacationCurrent", "branchVacationNext", "branchVacationWeek", "branchVacationList", "branchVacationMessage",
  "processTasksTab", "processTasksTabCount", "processTasksView", "refreshProcessTasks", "processTaskSummary", "processTaskList",
  "personnelLearningDashboardTab", "personnelLearningDashboardView", "refreshPortalLearningDashboard", "portalLearningDashboardScope", "portalLearningDashboardMessage", "portalLearningDashboardSummary", "portalLearningDashboardAssignments", "portalLearningDashboardEmployee", "portalLearningSkillTree", "portalLearningProgressDialog", "portalLearningProgressForm", "portalLearningProgressTitle", "portalLearningProgressAssignmentId", "portalLearningProgressAssignmentReceipt", "portalLearningProgressExpectedReceipt", "portalLearningProgressSummary", "portalLearningProgressSteps", "portalLearningProgressAssessment", "portalLearningProgressFinalized", "portalLearningProgressResult", "portalLearningProgressAssessmentNote", "portalLearningProgressCorrectionReasonField", "portalLearningProgressCorrectionReason", "portalLearningProgressMessage", "savePortalLearningProgress",
  "vacationTab", "vacationView", "historyTab", "historyView", "amuTab", "amuView", "timeTrackingTab", "timeTrackingView", "timeTrackingDate", "timeTrackingGreeting", "timeTrackingRefresh", "timeTrackingCard",
  "timeTrackingIndicator", "timeTrackingState", "timeTrackingReason", "timeTrackingActions", "timeTrackingMessage", "timePlanned", "timeActual", "timeWeighted", "timePause", "timeDifference", "timeTrackingIssues", "timeEntryList",
  "wifiAutomationCard", "wifiAutomationAvailability", "wifiAutomationToggle", "wifiConfirmationLevel", "wifiSuggestionWarning", "wifiSuggestionList", "wifiAutomationMessage",
  "timePeriodHeading", "timePeriodSummary", "timePeriodList", "previousTimePeriod", "currentTimePeriod", "nextTimePeriod",
  "privacyRequestsCard", "privacyRequestsNotice", "privacyRequestForm", "privacyRequestType", "privacyRequestSubmit", "privacyRequestMessage", "privacyRequestsRefresh", "privacyExportHint", "privacyRequestList",
  "mobileHomeSettingsCard", "mobileHomeSettingsList", "mobileHomeSettingsMessage", "resetMobileHomeButton", "saveMobileHomeButton", "mobileNavigationSettingsCard", "mobileNavigationSettingsList", "mobileNavigationSettingsMessage", "resetMobileNavigationButton", "saveMobileNavigationButton",
  "mobileAppearanceSettingsCard", "mobileAppearanceSettingsMessage", "saveMobileAppearanceButton",
  "vacationAccountCard", "vacationAccountYear", "vacationAccountSummary", "vacationAccountNotice",
  "timeRecordStatementsPanel", "timeRecordStatementList",
  "leadershipTeamTab", "leadershipApprovalsTab", "leadershipMoreTab", "leadershipTeamView", "leadershipApprovalsView", "leadershipMoreView",
  "leadershipTeamRefresh", "leadershipApprovalsRefresh", "leadershipContextFields", "leadershipLocation", "leadershipDepartment", "leadershipApprovalContextFields", "leadershipApprovalLocation", "leadershipApprovalDepartment", "leadershipPresenceSummary", "leadershipPresenceList", "leadershipApprovalList",
  "leadershipSettingsButton", "leadershipDesktopLink", "leadershipMoreDescription", "leadershipTimeOffShortcut", "leadershipVacationShortcut", "leadershipAmuShortcut", "leadershipProcessTasksShortcut",
  "mobileMoreTimeShortcut", "mobileMoreScheduleShortcut", "mobileMoreTeamShortcut", "mobileMoreApprovalsShortcut", "mobileMoreRequestsShortcut",
  "timeCorrectionDialog", "timeCorrectionForm", "timeCorrectionId", "timeCorrectionDate", "timeCorrectionDateText", "timeCorrectionEntries", "timeCorrectionNote", "timeCorrectionMessage", "addTimeCorrectionEntry",
  "leadershipRequestDialog", "leadershipRequestForm", "leadershipRequestTitle", "leadershipRequestSummary", "leadershipRequestHistory", "leadershipRequestDocuments", "leadershipSicknessFields", "leadershipSicknessExpectedEnd", "leadershipSicknessReturnDate", "leadershipCorrectionEntries", "addLeadershipCorrectionEntry", "leadershipRequestNote", "leadershipRequestMessage", "leadershipRequestActions",
  "scheduleHeading", "scheduleGrid", "previousWeek", "currentWeek", "nextWeek",
  "timeOffRequestForm", "timeOffFormTitle", "timeOffDate", "timeOffDateTo", "timeOffDateToField", "timeOffTimeFields", "timeOffStart", "timeOffEnd", "timeOffNote", "timeOffCheck", "timeOffMessage",
  "timeOffSubmitButton", "cancelTimeOffEdit", "timeOffArchiveToggle", "timeOffRequestList", "vacationRequestForm", "vacationFormTitle", "vacationDateFrom", "vacationDateTo", "vacationNote",
  "vacationCheck", "vacationMessage", "vacationSubmitButton", "cancelVacationEdit", "vacationRequestList", "approvedVacationList", "passwordDialog",
  "passwordForm", "passwordChangeUsername", "currentPassword", "newPassword", "repeatPassword", "passwordMessage", "vacationChangeDialog", "timeOffChangeDialog",
  "vacationChangeForm", "vacationChangeTitle", "vacationChangeOriginal", "vacationChangeDates", "vacationChangeFrom",
  "vacationChangeTo", "vacationChangeNote", "vacationChangeMessage", "historyTypeFilter", "historyStatusFilter", "absenceHistoryList",
  "timeOffChangeForm", "timeOffChangeTitle", "timeOffChangeOriginal", "timeOffChangeFields", "timeOffChangeFrom", "timeOffChangeTo",
  "timeOffChangeToField", "timeOffChangeTimes", "timeOffChangeStart", "timeOffChangeEnd", "timeOffChangeNote", "timeOffChangeMessage",
  "historyDetailDialog", "historyDetailTitle", "historyDetailSummary", "historyDecisionTimeline", "notificationsDialog", "notificationList",
  "birthdayPresentationDialog", "birthdayPresentationGraphic", "birthdayPresentationClose", "birthdayPresentationConfirm",
  "markAllNotificationsRead", "sicknessCaseForm", "sicknessStartDate", "sicknessExpectedEnd", "sicknessEmployeeNote", "sicknessMessage", "sicknessSubmitButton", "sicknessCaseList", "sicknessAumAllowance",
  "sicknessAmuPanel", "sicknessAmuDocuments", "sicknessAmuCamera", "sicknessAmuUploadHint", "sicknessAmuOcrStatus", "sicknessAmuOcrStatusTitle", "sicknessAmuOcrStatusText", "sicknessAmuOcrConfirmField", "sicknessAmuOcrConfirmed",
  "amuReportForm", "amuSicknessCaseId", "amuIncapacityFrom", "amuIncapacityTo", "amuEmployeeNote", "amuDocuments",
  "amuMessage", "amuSubmitButton", "amuReportList", "amuCamera", "amuUploadHint", "amuOcrStatus", "amuOcrStatusTitle", "amuOcrStatusText", "amuOcrConfirmField", "amuOcrConfirmed", "portalDeploymentBanner",
  "sicknessDateRangeButton", "sicknessDateRangeText", "amuUploadPanel", "amuDateRangeButton", "amuDateRangeText",
  "dateRangeDialog", "dateRangeForm", "dateRangeDialogTitle", "dateRangeStartText", "dateRangeEndText", "dateRangePreviousMonth", "dateRangeMonthLabel", "dateRangeNextMonth", "dateRangeCalendarGrid", "dateRangeOpenEnd", "dateRangeMessage", "dateRangeClose", "dateRangeCancel", "dateRangeApply",
  "sicknessRecoveryDialog", "sicknessRecoveryForm", "sicknessRecoveryTitle", "sicknessRecoveryCaseId", "sicknessRecoveryDate", "sicknessRecoveryMessage", "sicknessRecoveryClose", "sicknessRecoveryCancel", "sicknessRecoverySubmit",
  "emailSettingsCard", "emailSettingsSummary", "notificationPreferencesForm", "notificationTargetList", "notificationChannelSelection", "notificationPreferencesSaveButton", "notificationEarliestTime", "notificationQuietHoursBadge", "notificationQuietHoursHint", "emailSettingsMessage", "emailCategoryList",
  "branchOrderSettingsCard", "branchOrderSettingsSummary", "branchOrderSettingsMessage", "branchOrderSettingsWorkspace", "refreshBranchOrderSettings", "saveBranchOrderSettings", "refreshBranchOrderHistory", "branchOrderHistoryList", "branchPortalDisplaySettingsCard", "branchPortalDisplaySettingsSummary", "branchPortalDisplaySettingsForm", "branchPortalHideElapsedDays", "branchOrderAutosaveEnabled", "branchOrderAutosaveMinutes", "branchPortalDisplaySettingsMessage", "saveBranchPortalDisplaySettings",
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

function dateRangeText(start, end, emptyText = "Zeitraum auswählen") {
  if (!start) return emptyText;
  return end ? `${dateText(start)} – ${dateText(end)}` : `${dateText(start)} · Ende offen`;
}

function updateSicknessRangeControls() {
  if (el.sicknessDateRangeText) {
    el.sicknessDateRangeText.textContent = dateRangeText(el.sicknessStartDate.value, el.sicknessExpectedEnd.value, "Beginn auswählen");
  }
  if (el.amuDateRangeText) {
    el.amuDateRangeText.textContent = dateRangeText(el.amuIncapacityFrom.value, el.amuIncapacityTo.value);
  }
}

function openDateRangeCalendar(context) {
  if (!portalState.dateRangeCalendar) return;
  const sickness = context === "sickness";
  const from = sickness ? el.sicknessStartDate : el.amuIncapacityFrom;
  const to = sickness ? el.sicknessExpectedEnd : el.amuIncapacityTo;
  el.dateRangeDialogTitle.textContent = sickness ? "Krankheitszeitraum auswählen" : "AUM-Zeitraum auswählen";
  message(el.dateRangeMessage, "");
  portalState.dateRangeCalendar.open({
    start: from.value,
    end: to.value,
    min: sickness ? addDays(iso(new Date()), -5) : addDays(iso(new Date()), -3650),
    maxStart: sickness ? iso(new Date()) : addDays(iso(new Date()), 3650),
    maxEnd: sickness ? "" : addDays(iso(new Date()), 3650),
    maxEndDays: sickness ? 365 : null,
    allowOpenEnd: true,
    openLabel: "Ende offen",
    onCommit(start, end) {
      from.value = start;
      to.value = end;
      if (sickness) {
        portalState.sicknessAmuOcr.startManuallyEdited = true;
        portalState.sicknessAmuOcr.endManuallyEdited = true;
      } else {
        portalState.amuOcr.startManuallyEdited = true;
        portalState.amuOcr.endManuallyEdited = true;
      }
      updateSicknessRangeControls();
    },
  });
}

function initializeDateRangeCalendar() {
  const factory = window.GrabenplanerDateRangeCalendar?.createDateRangeCalendar;
  if (!factory || !el.dateRangeDialog) return;
  portalState.dateRangeCalendar = factory({
    dialog: el.dateRangeDialog,
    form: el.dateRangeForm,
    grid: el.dateRangeCalendarGrid,
    title: el.dateRangeMonthLabel,
    startText: el.dateRangeStartText,
    endText: el.dateRangeEndText,
    previousButton: el.dateRangePreviousMonth,
    nextButton: el.dateRangeNextMonth,
    openEndCheckbox: el.dateRangeOpenEnd,
    applyButton: el.dateRangeApply,
    closeButtons: [el.dateRangeClose, el.dateRangeCancel],
  });
  el.sicknessDateRangeButton?.addEventListener("click", () => openDateRangeCalendar("sickness"));
  el.amuDateRangeButton?.addEventListener("click", () => openDateRangeCalendar("amu"));
}

function timeText(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function timestampText(value) {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return new Intl.DateTimeFormat("de-AT", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
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
  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (error) {
    throw window.GrabenplanerApiErrors.fromNetwork(error, { hostname: location.hostname });
  }
  if (!response.ok) {
    const detail = await window.GrabenplanerApiErrors.fromResponse(response, {
      hostname: location.hostname,
      fallback: "Die Aktion konnte nicht ausgeführt werden.",
    });
    const error = new Error(detail.message);
    error.status = response.status;
    error.code = detail.code;
    if (response.status === 401) showLogin("Die Anmeldung ist abgelaufen. Bitte erneut anmelden.");
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

const birthdayPresentationPaths = Object.freeze({
  elegant: "/assets/birthday-presentations/elegant.svg",
  farbenfroh: "/assets/birthday-presentations/farbenfroh.svg",
  fotowelt: "/assets/birthday-presentations/fotowelt.svg",
  technik: "/assets/birthday-presentations/technik.svg",
  standard: "/assets/birthday-presentations/dezent.svg",
});

const birthdayPresentationThemeIds = Object.freeze({
  standard: true,
  elegant: true,
  farbenfroh: true,
  fotowelt: true,
  technik: true,
});
const BIRTHDAY_PRESENTATION_THEME_REFRESH_MS = 5 * 60 * 1000;
const BIRTHDAY_PRESENTATION_THEME_REQUEST_TIMEOUT_MS = 8000;

function birthdayPresentationActor(user = portalUser()) {
  if (!user || user.isEmployee !== true || isOrganizationAccount(user)) return "";
  return String(user.employeeNumber || "").trim();
}

function neutralizeBirthdayPresentation({ restoreFocus = false } = {}) {
  portalState.birthdayPresentationClaimGeneration += 1;
  portalState.birthdayPresentationClaimActor = "";
  const returnFocus = portalState.birthdayPresentationReturnFocus;
  portalState.birthdayPresentationReturnFocus = null;
  if (el.birthdayPresentationDialog?.open) el.birthdayPresentationDialog.close();
  if (el.birthdayPresentationGraphic) el.birthdayPresentationGraphic.removeAttribute("src");
  if (restoreFocus && returnFocus?.isConnected && typeof returnFocus.focus === "function") {
    returnFocus.focus();
  }
}

function validBirthdayPresentation(result) {
  if (!result?.presentation || typeof result.presentation !== "object") return null;
  const id = String(result.presentation.id || "");
  const previewUrl = String(result.presentation.previewUrl || "");
  if (!Object.hasOwn(birthdayPresentationPaths, id)) return null;
  if (birthdayPresentationPaths[id] !== previewUrl) return null;
  return { id, previewUrl };
}

function showBirthdayPresentation(presentation) {
  if (!el.birthdayPresentationDialog || !el.birthdayPresentationGraphic || !presentation) return;
  const generation = portalState.birthdayPresentationClaimGeneration;
  portalState.birthdayPresentationReturnFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  el.birthdayPresentationGraphic.src = presentation.previewUrl;
  el.birthdayPresentationDialog.showModal();
  window.requestAnimationFrame(() => {
    if (generation === portalState.birthdayPresentationClaimGeneration
      && el.birthdayPresentationDialog?.open) {
      el.birthdayPresentationConfirm?.focus();
    }
  });
}

function closeBirthdayPresentation() {
  const returnFocus = portalState.birthdayPresentationReturnFocus;
  portalState.birthdayPresentationReturnFocus = null;
  if (el.birthdayPresentationDialog?.open) el.birthdayPresentationDialog.close();
  if (el.birthdayPresentationGraphic) el.birthdayPresentationGraphic.removeAttribute("src");
  if (returnFocus?.isConnected && typeof returnFocus.focus === "function") returnFocus.focus();
}

async function claimBirthdayPresentation() {
  const actor = birthdayPresentationActor();
  if (!actor) {
    neutralizeBirthdayPresentation();
    return;
  }
  if (portalState.birthdayPresentationClaimActor === actor) return;
  neutralizeBirthdayPresentation();
  portalState.birthdayPresentationClaimActor = actor;
  const generation = portalState.birthdayPresentationClaimGeneration;
  try {
    const result = await api("/api/portal/v1/me/birthday-presentation/claim", {
      method: "POST",
      body: "{}",
    });
    if (generation !== portalState.birthdayPresentationClaimGeneration) return;
    if (birthdayPresentationActor() !== actor) return;
    const presentation = validBirthdayPresentation(result);
    if (presentation) showBirthdayPresentation(presentation);
    else if (!Object.hasOwn(result || {}, "presentation") || result.presentation !== null) {
      neutralizeBirthdayPresentation();
    }
  } catch {
    if (generation === portalState.birthdayPresentationClaimGeneration) neutralizeBirthdayPresentation();
  }
}

function clearBirthdayPresentationThemeRefreshTimer() {
  if (portalState.birthdayPresentationThemeRefreshTimer === null) return;
  window.clearTimeout(portalState.birthdayPresentationThemeRefreshTimer);
  portalState.birthdayPresentationThemeRefreshTimer = null;
}

function neutralizeBirthdayPresentationTheme() {
  portalState.birthdayPresentationThemeGeneration += 1;
  portalState.birthdayPresentationThemeActor = "";
  portalState.birthdayPresentationThemeRefreshPromise = null;
  portalState.birthdayPresentationThemeRequestController?.abort();
  portalState.birthdayPresentationThemeRequestController = null;
  clearBirthdayPresentationThemeRefreshTimer();
  delete document.documentElement.dataset.portalBirthdayTheme;
}

function applyBirthdayPresentationTheme(result) {
  const theme = result?.theme;
  const id = theme && typeof theme === "object" && !Array.isArray(theme)
    ? String(theme.id || "")
    : "";
  if (result && Object.hasOwn(result, "theme") && Object.hasOwn(birthdayPresentationThemeIds, id)) {
    document.documentElement.dataset.portalBirthdayTheme = id;
    return;
  }
  delete document.documentElement.dataset.portalBirthdayTheme;
}

function scheduleBirthdayPresentationThemeRefresh(actor, generation) {
  clearBirthdayPresentationThemeRefreshTimer();
  if (!actor
    || actor !== portalState.birthdayPresentationThemeActor
    || generation !== portalState.birthdayPresentationThemeGeneration) return;
  portalState.birthdayPresentationThemeRefreshTimer = window.setTimeout(() => {
    portalState.birthdayPresentationThemeRefreshTimer = null;
    if (document.hidden) {
      scheduleBirthdayPresentationThemeRefresh(actor, generation);
      return;
    }
    refreshBirthdayPresentationTheme();
  }, BIRTHDAY_PRESENTATION_THEME_REFRESH_MS);
}

async function refreshBirthdayPresentationTheme() {
  const actor = birthdayPresentationActor();
  if (!actor || portalUser()?.mustChangePassword === true) {
    neutralizeBirthdayPresentationTheme();
    return;
  }
  if (portalState.birthdayPresentationThemeActor !== actor) {
    neutralizeBirthdayPresentationTheme();
    portalState.birthdayPresentationThemeActor = actor;
  }
  if (portalState.birthdayPresentationThemeRefreshPromise) {
    return portalState.birthdayPresentationThemeRefreshPromise;
  }
  clearBirthdayPresentationThemeRefreshTimer();
  const generation = portalState.birthdayPresentationThemeGeneration;
  const controller = new AbortController();
  portalState.birthdayPresentationThemeRequestController = controller;
  const requestTimeout = window.setTimeout(
    () => controller.abort(),
    BIRTHDAY_PRESENTATION_THEME_REQUEST_TIMEOUT_MS,
  );
  const request = (async () => {
    try {
      const result = await api("/api/portal/v1/me/birthday-presentation/theme", {
        signal: controller.signal,
      });
      if (generation !== portalState.birthdayPresentationThemeGeneration) return;
      if (birthdayPresentationActor() !== actor) return;
      applyBirthdayPresentationTheme(result);
    } catch {
      if (generation === portalState.birthdayPresentationThemeGeneration
        && birthdayPresentationActor() === actor) {
        delete document.documentElement.dataset.portalBirthdayTheme;
      }
    } finally {
      window.clearTimeout(requestTimeout);
      if (generation === portalState.birthdayPresentationThemeGeneration
        && portalState.birthdayPresentationThemeActor === actor) {
        if (portalState.birthdayPresentationThemeRequestController === controller) {
          portalState.birthdayPresentationThemeRequestController = null;
        }
        if (portalState.birthdayPresentationThemeRefreshPromise === request) {
          portalState.birthdayPresentationThemeRefreshPromise = null;
        }
        scheduleBirthdayPresentationThemeRefresh(actor, generation);
      }
    }
  })();
  portalState.birthdayPresentationThemeRefreshPromise = request;
  return request;
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

let loginBrandingTimer;
async function previewLoginBranding() {
  const employeeNumber = el.loginPersonnelNumber.value.trim();
  try {
    const result = await api("/api/portal/v1/auth/branding", {
      method: "POST",
      body: JSON.stringify({ loginName: employeeNumber }),
    });
    if (el.loginPersonnelNumber.value.trim() === employeeNumber) applyPortalBranding(result.branding || {});
  } catch {
    if (!employeeNumber) applyPortalBranding(portalState.status?.branding || {});
  }
}

function scheduleLoginBrandingPreview() {
  clearTimeout(loginBrandingTimer);
  loginBrandingTimer = setTimeout(previewLoginBranding, 300);
}

function timeTrackingCapabilityEnabled() {
  return portalState.status?.capabilities?.timeTracking === true;
}

function wifiTimeSuggestionsCapabilityEnabled() {
  return portalState.status?.capabilities?.wifiTimeSuggestions === true;
}

function loanCapabilityEnabled() {
  if (portalState.status?.capabilities?.loans !== true) return false;
  const permissions = portalUser()?.permissions || [];
  return permissions.some((permission) => [
    "loans:overview:read",
    "loans:self:read",
    "loans:self:create",
    "loans:self:return",
    "loans:location:read",
    "loans:location:manage",
  ].includes(permission));
}

function branchOrderCapabilityEnabled(user = portalUser()) {
  const canSubmit = (user?.permissions || []).includes("branch_orders:submit");
  if (!canSubmit) return false;
  if (isOrganizationAccount(user)) return user?.accountType === "branch";
  return user?.isEmployee !== false && Boolean(String(user?.homeLocationId || "").trim());
}

function branchVacationCapabilityEnabled(user = portalUser()) {
  return isOrganizationAccount(user)
    && user?.accountType === "branch"
    && (user?.permissions || []).includes("schedule:location:view");
}

function branchOrderManagementEnabled(user = portalUser()) {
  return !isOrganizationAccount(user)
    && ["hr", "admin", "developer"].includes(user?.role)
    && (user?.permissions || []).includes("branch_orders:manage");
}

function branchPortalDisplaySettingsEnabled(user = portalUser()) {
  if (isOrganizationAccount(user) || user?.isEmployee === false || isMobileUi()) return false;
  const allowed = (user?.permissions || []).includes("branch_portal:display:manage");
  return allowed && ["department_manager", "manager", "hr", "admin", "developer"].includes(user?.role);
}

function applyPortalCapabilities() {
  const timeTrackingEnabled = timeTrackingCapabilityEnabled();
  el.timeTrackingTab?.classList.toggle("hidden", !timeTrackingEnabled);
  el.wifiAutomationCard?.classList.toggle(
    "hidden",
    !wifiTimeSuggestionsCapabilityEnabled() || !mobileLocationDisplayAllows("time"),
  );
  if (!timeTrackingEnabled && portalState.activeTab === "timeTracking") setTab(defaultPortalTab());
  const sicknessEnabled = portalState.status?.capabilities?.sicknessReports === true;
  document.querySelector('[data-tab="amu"]')?.classList.toggle("hidden", !sicknessEnabled);
  const loansEnabled = loanCapabilityEnabled();
  el.loanTab?.classList.toggle("hidden", !loansEnabled);
  el.leadershipLoanShortcut?.classList.toggle("hidden", !loansEnabled);
  if (!loansEnabled && portalState.activeTab === "loan") setTab(defaultPortalTab());
  const branchOrdersEnabled = branchOrderCapabilityEnabled();
  el.branchOrdersTab?.classList.toggle("hidden", !branchOrdersEnabled);
  if (!branchOrdersEnabled && portalState.activeTab === "branchOrders") setTab(defaultPortalTab());
  el.branchOrderSettingsTab?.classList.toggle("hidden", !branchOrderManagementEnabled());
  const branchVacationEnabled = branchVacationCapabilityEnabled();
  el.branchVacationTab?.classList.toggle("hidden", !branchVacationEnabled);
  if (!branchVacationEnabled && portalState.activeTab === "branchVacation") setTab(defaultPortalTab());
}

function portalUser() {
  return portalState.session?.user || null;
}

function isOrganizationAccount(user = portalUser()) {
  return user?.isEmployee === false || ["branch", "terminal"].includes(user?.accountType);
}

function personalEmailSettingsAvailable(user = portalUser()) {
  return user?.isEmployee === true && !isOrganizationAccount(user);
}

function scheduleCapabilityEnabled(user = portalUser()) {
  const permissions = user?.permissions || [];
  return permissions.includes("own_schedule:read")
    || (isOrganizationAccount(user) && permissions.includes("schedule:location:view"));
}

function hasPortalPermission(permission) {
  return portalUser()?.permissions?.includes(permission) === true;
}

const leadershipPortalPermissions = new Set([
  "schedule:write",
  "time:read",
  "time:review",
  "vacation:read",
  "vacation:approve",
  "hr:approve",
  "amu:metadata:read",
  "amu:review",
  "sickness:read",
  "notifications:settings",
]);

function isLeadershipUser(user = portalUser()) {
  return Array.isArray(user?.permissions)
    && user.permissions.some((permission) => leadershipPortalPermissions.has(permission));
}

const mobileMoreSecondaryTabs = new Set(["timeOff", "vacation", "amu", "loan", "settings"]);
mobileMoreSecondaryTabs.add("processTasks");
mobileMoreSecondaryTabs.add("branchOrders");
mobileMoreSecondaryTabs.add("branchVacation");
mobileMoreSecondaryTabs.add("learningDashboard");
const mobileModuleCatalog = Object.freeze([
  { id: "time", tab: "timeTracking", label: "Zeit", description: "Zeiterfassung und Zeitkonto" },
  { id: "tasks", tab: "processTasks", label: "Aufgaben", description: "Offene persönliche Prozessschritte" },
  { id: "team", tab: "leadershipTeam", label: "Team", description: "Anwesenheit im zuständigen Bereich" },
  { id: "approvals", tab: "leadershipApprovals", label: "Freigaben", description: "Offene Entscheidungen" },
  { id: "schedule", tab: "schedule", label: "Dienstplan", description: "Meine geplanten Dienste" },
  { id: "requests", tab: "history", label: "Anträge", description: "Zeitausgleich, Urlaub und Verlauf" },
  { id: "loan", tab: "loan", label: "Leihe", description: "Ausgaben und Rücknahmen" },
  { id: "sickness", tab: "amu", label: "Krank & AUM", description: "Krankmeldung und Dokumente" },
  { id: "learning", tab: "learningDashboard", label: "Schulungen", description: "Fortschritte und Fähigkeiten" },
  { id: "more", tab: "leadershipMore", label: "Mehr", description: "Alle weiteren Bereiche" },
]);
const mobileModuleIds = new Set(mobileModuleCatalog.map((item) => item.id));
const mobileModuleById = new Map(mobileModuleCatalog.map((item) => [item.id, item]));
const mobileModuleByTab = new Map(mobileModuleCatalog.map((item) => [item.tab, item.id]));
const mobileHomeTileCatalog = Object.freeze([
  ...mobileModuleCatalog.filter((item) => item.id !== "more"),
  { id: "branchOrders", tab: "branchOrders", label: "Filialbestellung", description: "Bestellung erfassen oder fortsetzen" },
  { id: "branchVacation", tab: "branchVacation", label: "Urlaubsplanung", description: "Genehmigte Urlaubstage ansehen" },
]);
const mobileHomeTileById = new Map(mobileHomeTileCatalog.map((item) => [item.id, item]));
const mobileHomeTileIds = Object.freeze(mobileHomeTileCatalog.map((item) => item.id));
const mobileLocationDisplayManagedModuleIds = new Set([
  "time", "tasks", "team", "approvals", "schedule", "requests", "loan", "sickness", "branchOrders", "branchVacation",
]);
const mobileLocationDisplayTabModules = Object.freeze({
  timeTracking: "time",
  processTasks: "tasks",
  schedule: "schedule",
  timeOff: "requests",
  vacation: "requests",
  history: "requests",
  loan: "loan",
  amu: "sickness",
  branchOrders: "branchOrders",
  branchVacation: "branchVacation",
});
const mobileHomeDefaultColors = Object.freeze({
  time: [39, 110, 85],
  tasks: [41, 107, 145],
  team: [98, 84, 151],
  approvals: [156, 104, 28],
  schedule: [38, 112, 104],
  requests: [128, 82, 108],
  loan: [129, 91, 48],
  sickness: [173, 75, 66],
  learning: [55, 118, 93],
  branchOrders: [42, 122, 99],
  branchVacation: [76, 112, 167],
});

const mobileModuleAliases = {
  time: "time",
  timeTracking: "time",
  time_tracking: "time",
  tasks: "tasks",
  processTasks: "tasks",
  process_tasks: "tasks",
  presence: "team",
  team: "team",
  team_now: "team",
  approvals: "approvals",
  requests_review: "approvals",
  schedule: "schedule",
  plan: "schedule",
  requests: "requests",
  history: "requests",
  own_requests: "requests",
  loan: "loan",
  loans: "loan",
  sickness: "sickness",
  amu: "sickness",
  learning: "learning",
  learningDashboard: "learning",
  training: "learning",
  more: "more",
};

function normalizedMobileModules(value) {
  const list = Array.isArray(value) ? value : [];
  const normalized = list.map((item) => {
    if (typeof item === "string") return mobileModuleAliases[item] || item;
    if (item?.enabled === false || item?.visible === false) return "";
    return mobileModuleAliases[item?.id || item?.key || item?.module] || item?.id || item?.key || item?.module || "";
  }).filter(Boolean);
  return [...new Set(normalized)].filter((id) => mobileModuleIds.has(id));
}

function mobileLocationDisplayAllows(moduleId, user = portalUser()) {
  if (!isMobileUi() || isOrganizationAccount(user) || !mobileLocationDisplayManagedModuleIds.has(moduleId)) {
    return true;
  }
  const allowedModules = portalState.uiPreferences?.mobilePortalLocationDisplay?.allowedModules;
  return Array.isArray(allowedModules) && allowedModules.includes(moduleId);
}

function mobileModuleAllowed(module, permissions = portalUser()?.permissions || []) {
  if (!mobileLocationDisplayAllows(module)) return false;
  if (module === "time") return permissions.includes("own_time:read") && timeTrackingCapabilityEnabled();
  if (module === "tasks") return portalTabAllowed("processTasks");
  if (module === "team") return permissions.includes("time:read");
  if (module === "approvals") return permissions.some((permission) => ["vacation:read", "vacation:approve", "time:review", "amu:metadata:read", "amu:review", "amu:local:manage", "sickness:read", "sickness:manage"].includes(permission));
  if (module === "schedule") return permissions.includes("own_schedule:read");
  if (module === "requests") return permissions.some((permission) => ["own_vacation:read", "own_vacation:request", "own_time:read", "own_time:correction_request"].includes(permission));
  if (module === "loan") return loanCapabilityEnabled();
  if (module === "sickness") return portalTabAllowed("amu");
  if (module === "learning") return portalTabAllowed("learningDashboard");
  return module === "more";
}

function portalTabAllowed(tab, user = portalUser()) {
  const permissions = user?.permissions || [];
  if (tab === "home") return isMobileUi();
  if (tab === "settings") return true;
  const locationDisplayModule = mobileLocationDisplayTabModules[tab];
  if (locationDisplayModule && !mobileLocationDisplayAllows(locationDisplayModule, user)) return false;
  if (tab === "schedule") return scheduleCapabilityEnabled(user);
  if (tab === "branchOrders") return branchOrderCapabilityEnabled(user);
  if (tab === "branchVacation") return branchVacationCapabilityEnabled(user);
  if (tab === "learningDashboard") {
    return portalState.personnelLearningDashboardAvailable === true
      || permissions.includes("personnel_learning:location:dashboard");
  }
  if (tab === "leadershipMore") return !isOrganizationAccount(user);
  if (tab === "timeTracking") return permissions.includes("own_time:read") && timeTrackingCapabilityEnabled();
  if (tab === "timeOff") return permissions.includes("own_vacation:request");
  if (tab === "vacation") return permissions.some((permission) => ["own_vacation:read", "own_vacation:request"].includes(permission));
  if (tab === "history") {
    return permissions.some((permission) => [
      "own_vacation:read", "own_vacation:request", "own_time:read", "own_time:correction_request",
    ].includes(permission));
  }
  if (tab === "amu") {
    return permissions.some((permission) => [
      "own_sickness:create", "own_sickness:read", "own_amu:create", "own_amu:read", "own_amu:withdraw",
    ].includes(permission)) && portalState.status?.capabilities?.sicknessReports === true;
  }
  if (tab === "processTasks") {
    return !isOrganizationAccount(user)
      && user?.role !== "location_planner"
      && portalState.processTasksAvailable !== false;
  }
  if (tab === "loan") return loanCapabilityEnabled();
  if (tab === "leadershipTeam") return mobileModuleAllowed("team", permissions);
  if (tab === "leadershipApprovals") return mobileModuleAllowed("approvals", permissions);
  return false;
}

function mobileHomeTileAllowed(tile, user = portalUser()) {
  if (!tile) return false;
  if (tile.id === "branchOrders" || tile.id === "branchVacation") return portalTabAllowed(tile.tab, user);
  return mobileModuleAllowed(tile.id, user?.permissions || []);
}

function availableMobileHomeTiles(user = portalUser()) {
  return mobileHomeTileCatalog.filter((tile) => mobileHomeTileAllowed(tile, user));
}

function normalizedRgb(value, fallback) {
  if (!Array.isArray(value) || value.length !== 3
    || value.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    return [...fallback];
  }
  return value.map(Number);
}

function defaultMobilePortalHome() {
  return {
    version: 1,
    order: [...mobileHomeTileIds],
    colors: Object.fromEntries(mobileHomeTileIds.map((id) => [id, [...mobileHomeDefaultColors[id]]])),
  };
}

function normalizedMobilePortalHome(value) {
  const fallback = defaultMobilePortalHome();
  if (!value || typeof value !== "object" || Array.isArray(value) || Number(value.version) !== 1) return fallback;
  const order = Array.isArray(value.order)
    ? [...new Set(value.order.map(String))].filter((id) => mobileHomeTileById.has(id))
    : [];
  for (const id of mobileHomeTileIds) if (!order.includes(id)) order.push(id);
  const submittedColors = value.colors && typeof value.colors === "object" && !Array.isArray(value.colors)
    ? value.colors
    : {};
  const colors = Object.fromEntries(mobileHomeTileIds.map((id) => [
    id,
    normalizedRgb(submittedColors[id], mobileHomeDefaultColors[id]),
  ]));
  return { version: 1, order, colors };
}

function rgbToHex(rgb) {
  return `#${rgb.map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`;
}

function availablePersonalMobileModules() {
  return mobileModuleCatalog
    .map((item) => item.id)
    .filter((id) => id !== "more" && mobileModuleAllowed(id));
}

function normalizedPersonalMobileNavigation(value) {
  const fallback = mobileModuleCatalog.filter((item) => item.id !== "more").map((item) => item.id);
  const requestedOrder = Array.isArray(value?.order)
    ? [...new Set(value.order.map(String))].filter((id) => mobileModuleIds.has(id) && id !== "more")
    : [];
  for (const id of fallback) if (!requestedOrder.includes(id)) requestedOrder.push(id);
  const hidden = Array.isArray(value?.hidden)
    ? [...new Set(value.hidden.map(String))].filter((id) => mobileModuleIds.has(id) && id !== "more")
    : [];
  return { version: 1, order: requestedOrder, hidden };
}

function defaultPersonalMobileSelection() {
  const available = new Set(availablePersonalMobileModules());
  const roleDefault = isLeadershipUser()
    ? normalizedMobileModules(portalState.mobileLayout?.modules)
    : ["time", "schedule", "requests", "loan", "tasks", "sickness"];
  const selected = roleDefault.filter((id) => id !== "more" && available.has(id)).slice(0, 3);
  if (!selected.length) selected.push(...[...available].slice(0, 1));
  return selected;
}

function createMobileNavigationDraft() {
  const stored = normalizedPersonalMobileNavigation(portalState.uiPreferences?.mobilePortalNavigation);
  const available = new Set(availablePersonalMobileModules());
  const customized = portalState.uiPreferences?.mobilePortalNavigationCustomized === true;
  const selected = customized
    ? stored.order.filter((id) => available.has(id) && !stored.hidden.includes(id)).slice(0, 5)
    : defaultPersonalMobileSelection();
  return {
    order: [...stored.order],
    selected: selected.length ? selected : [...available].slice(0, 1),
  };
}

function currentMobileNavigationDraft() {
  if (!portalState.mobileNavigationDraft) portalState.mobileNavigationDraft = createMobileNavigationDraft();
  return portalState.mobileNavigationDraft;
}

function effectiveMobileModules() {
  const available = new Set(availablePersonalMobileModules());
  const draft = currentMobileNavigationDraft();
  const direct = draft.order
    .filter((id) => available.has(id) && draft.selected.includes(id))
    .slice(0, 5);
  if (!direct.length) direct.push(...[...available].slice(0, 1));
  return [...direct, "more"];
}

function syncPortalTabButtons(tab) {
  const modules = portalState.mobileLeadership ? effectiveMobileModules() : [];
  const navigationTab = portalState.mobileLeadership && ["timeOff", "vacation"].includes(tab) ? "history" : tab;
  const directModule = mobileModuleByTab.get(navigationTab);
  const representedByMore = portalState.mobileLeadership
    && ((mobileMoreSecondaryTabs.has(tab) && (!directModule || !modules.includes(directModule)))
      || (directModule && !modules.includes(directModule)));
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const active = representedByMore
      ? button.dataset.tab === "leadershipMore"
      : button.dataset.tab === navigationTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  if (portalState.mobileLeadership) {
    const activeButton = document.querySelector(".portal-tabs [data-tab].active");
    activeButton?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }
}

function renderMobileMoreShortcuts(modules = effectiveMobileModules()) {
  const direct = new Set(modules);
  [
    [el.mobileMoreTimeShortcut, "time"],
    [el.mobileMoreScheduleShortcut, "schedule"],
    [el.mobileMoreTeamShortcut, "team"],
    [el.mobileMoreApprovalsShortcut, "approvals"],
    [el.mobileMoreRequestsShortcut, "requests"],
  ].forEach(([button, module]) => {
    button?.classList.toggle("hidden", !mobileModuleAllowed(module) || direct.has(module));
  });
}

function isBranchMobileAccount(user = portalUser()) {
  return isMobileUi() && isOrganizationAccount(user) && user?.accountType === "branch";
}

function applyMobileLeadershipLayout() {
  const navigation = document.querySelector(".portal-tabs");
  if (!navigation) return;
  const loanIssueSection = document.querySelector("#loanIssueSection");
  const loanDisplayMode = isMobileUi() ? "mobile" : "desktop";
  if (loanIssueSection && loanIssueSection.dataset.displayMode !== loanDisplayMode) {
    loanIssueSection.open = loanDisplayMode === "desktop";
    loanIssueSection.dataset.displayMode = loanDisplayMode;
  }
  document.querySelectorAll("[data-request-tab]").forEach((button) => {
    const tab = button.dataset.requestTab;
    const canRequest = tab === "history" || (portalUser()?.permissions || []).includes("own_vacation:request");
    button.classList.toggle("hidden", !canRequest || !portalTabAllowed(tab));
  });
  document.querySelectorAll(".portal-request-shortcuts").forEach((group) => {
    group.classList.toggle("hidden", !group.querySelector("button:not(.hidden)"));
  });
  const branchMobile = isBranchMobileAccount();
  const compactMobile = isMobileUi() && !isOrganizationAccount();
  const mobilePortal = branchMobile || compactMobile;
  portalState.mobileLeadership = compactMobile;
  document.body.classList.toggle("branch-mobile-account", branchMobile);
  document.body.classList.toggle("portal-mobile-session", mobilePortal);
  document.body.classList.toggle(
    "branch-mobile-action-active",
    branchMobile && portalState.activeTab === "branchOrders",
  );
  navigation.classList.toggle("branch-mobile-navigation", branchMobile);
  navigation.classList.toggle("mobile-personal", compactMobile);
  navigation.classList.toggle("mobile-leadership", compactMobile && isLeadershipUser());
  navigation.classList.toggle("mobile-settings-hidden", mobilePortal && portalState.activeTab === "settings");
  el.portalSettingsShortcut?.classList.toggle("hidden", !mobilePortal);
  if (branchMobile) {
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.classList.add("hidden");
      button.classList.add("mobile-navigation-hidden");
    });
    ["home", "schedule", "learningDashboard", "branchOrders", "loan", "branchVacation"]
      .filter((tab) => portalTabAllowed(tab))
      .forEach((tab, index) => {
        const button = document.querySelector(`[data-tab="${tab}"]`);
        button?.classList.remove("hidden");
        button?.classList.remove("mobile-navigation-hidden");
        if (button) button.style.order = String(index);
      });
    syncPortalTabButtons(portalState.activeTab);
    renderMobileHome();
    renderBranchMobileActionBar();
    if (portalState.scheduleData) renderSchedule(portalState.scheduleData);
    return;
  }
  const regularTabs = ["settings", "schedule", "branchVacation", "timeTracking", "processTasks", "learningDashboard", "timeOff", "vacation", "history", "amu"];
  document.querySelectorAll(".leadership-tab").forEach((button) => button.classList.add("hidden"));
  if (!compactMobile) {
    document.querySelectorAll("[data-tab]").forEach((button) => button.classList.remove("mobile-navigation-hidden"));
    el.mobileHomeTab?.classList.add("hidden");
    el.mobileHomeTab?.style.removeProperty("order");
    regularTabs.forEach((tab) => {
      const button = document.querySelector(`[data-tab="${tab}"]`);
      const unavailable = !portalTabAllowed(tab);
      button?.classList.toggle("hidden", unavailable);
      button?.style.removeProperty("order");
    });
    document.querySelectorAll(".leadership-tab").forEach((button) => button.style.removeProperty("order"));
    if (["leadershipTeam", "leadershipApprovals", "leadershipMore"].includes(portalState.activeTab)) {
      setTab("timeTracking");
      return;
    }
    if (portalState.activeTab === "home") {
      setTab(defaultPortalTab());
      return;
    }
    syncPortalTabButtons(portalState.activeTab);
    return;
  }
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.add("hidden");
    button.classList.add("mobile-navigation-hidden");
  });
  const modules = effectiveMobileModules();
  const homeButton = el.mobileHomeTab;
  homeButton?.classList.remove("hidden");
  homeButton?.classList.remove("mobile-navigation-hidden");
  if (homeButton) homeButton.style.order = "-1";
  modules.forEach((module, index) => {
    const button = document.querySelector(`[data-tab="${mobileModuleById.get(module)?.tab}"]`);
    button?.classList.remove("hidden");
    button?.classList.remove("mobile-navigation-hidden");
    if (button) button.style.order = String(index);
  });
  renderMobileMoreShortcuts(modules);
  const activeButton = document.querySelector(`[data-tab="${portalState.activeTab}"]`);
  const activeModule = mobileModuleByTab.get(portalState.activeTab);
  const secondaryViaMore = modules.includes("more") && mobileMoreSecondaryTabs.has(portalState.activeTab)
    && (!activeModule || !modules.includes(activeModule));
  const hiddenDirectViaMore = modules.includes("more") && activeModule && !modules.includes(activeModule);
  if (activeButton?.classList.contains("hidden") && modules.length && !secondaryViaMore && !hiddenDirectViaMore) {
    setTab(mobileModuleById.get(modules[0])?.tab || "leadershipMore");
    return;
  }
  syncPortalTabButtons(portalState.activeTab);
  renderMobileHome();
}

async function loadMobileLayout() {
  const layoutRequest = isLeadershipUser()
    ? api("/api/portal/v1/mobile-layout")
    : Promise.resolve(null);
  const [layoutResult, preferencesResult] = await Promise.allSettled([
    layoutRequest,
    api("/api/portal/v1/ui-preferences"),
  ]);
  portalState.mobileLayout = layoutResult.status === "fulfilled"
    ? layoutResult.value
    : { modules: ["time", "team", "approvals", "schedule", "requests", "more"] };
  const locationDisplay = preferencesResult.status === "fulfilled"
    ? preferencesResult.value?.mobilePortalLocationDisplay
    : layoutResult.status === "fulfilled"
      ? layoutResult.value?.locationDisplay
      : null;
  portalState.uiPreferences = preferencesResult.status === "fulfilled"
    ? preferencesResult.value
    : {
      mobilePortalNavigation: { version: 1, order: mobileModuleCatalog.filter((item) => item.id !== "more").map((item) => item.id), hidden: [] },
      mobilePortalAppearance: { version: 1, palette: "forest", surface: "soft" },
      mobilePortalHome: defaultMobilePortalHome(),
      mobilePortalLocationDisplay: locationDisplay || { version: 1, locationId: "", allowedModules: [] },
      mobilePortalNavigationCustomized: false,
    };
  if (!portalState.uiPreferences.mobilePortalLocationDisplay) {
    portalState.uiPreferences.mobilePortalLocationDisplay = locationDisplay
      || { version: 1, locationId: "", allowedModules: [] };
  }
  portalState.mobileNavigationDraft = null;
  portalState.mobileHomeDraft = null;
  applyMobilePortalAppearance(portalState.uiPreferences.mobilePortalAppearance);
  renderMobileAppearanceSettings();
  renderMobileNavigationSettings();
  renderMobileHomeSettings();
  renderMobileHome();
  applyMobileLeadershipLayout();
}

function normalizedMobilePortalAppearance(value) {
  const palettes = new Set(["forest", "ocean", "plum", "sand", "berry", "amber", "slate", "teal"]);
  const surfaces = new Set(["soft", "compact"]);
  return {
    version: 1,
    palette: palettes.has(String(value?.palette)) ? String(value.palette) : "forest",
    surface: surfaces.has(String(value?.surface)) ? String(value.surface) : "soft",
  };
}

function applyMobilePortalAppearance(value) {
  const appearance = normalizedMobilePortalAppearance(value);
  document.documentElement.dataset.portalPalette = appearance.palette;
  document.documentElement.dataset.portalSurface = appearance.surface;
}

function mobileAppearanceFromSettings() {
  return normalizedMobilePortalAppearance({
    version: 1,
    palette: document.querySelector('input[name="mobilePortalPalette"]:checked')?.value,
    surface: document.querySelector('input[name="mobilePortalSurface"]:checked')?.value,
  });
}

function renderMobileAppearanceSettings() {
  const appearance = normalizedMobilePortalAppearance(portalState.uiPreferences?.mobilePortalAppearance);
  const palette = document.querySelector(`input[name="mobilePortalPalette"][value="${appearance.palette}"]`);
  const surface = document.querySelector(`input[name="mobilePortalSurface"][value="${appearance.surface}"]`);
  if (palette) palette.checked = true;
  if (surface) surface.checked = true;
  applyMobilePortalAppearance(appearance);
}

async function saveMobileAppearanceSettings() {
  const appearance = mobileAppearanceFromSettings();
  el.saveMobileAppearanceButton.disabled = true;
  message(el.mobileAppearanceSettingsMessage, "");
  try {
    portalState.uiPreferences = await api("/api/portal/v1/ui-preferences", {
      method: "PUT",
      body: JSON.stringify({ mobilePortalAppearance: appearance }),
    });
    renderMobileAppearanceSettings();
    message(el.mobileAppearanceSettingsMessage, "Dein persönliches Portaldesign wurde gespeichert.");
  } catch (error) {
    renderMobileAppearanceSettings();
    message(el.mobileAppearanceSettingsMessage, error.message, true);
  } finally {
    el.saveMobileAppearanceButton.disabled = false;
  }
}

function currentMobileHomeDraft() {
  if (!portalState.mobileHomeDraft) {
    const stored = normalizedMobilePortalHome(portalState.uiPreferences?.mobilePortalHome);
    portalState.mobileHomeDraft = {
      order: [...stored.order],
      colors: Object.fromEntries(Object.entries(stored.colors).map(([id, rgb]) => [id, [...rgb]])),
    };
  }
  return portalState.mobileHomeDraft;
}

function mobileHomeItemsForSettings() {
  const draft = currentMobileHomeDraft();
  const allowed = new Set(availableMobileHomeTiles().map((tile) => tile.id));
  return draft.order
    .filter((id) => allowed.has(id))
    .map((id) => mobileHomeTileById.get(id))
    .filter(Boolean);
}

function renderMobileHomeSettings() {
  if (!el.mobileHomeSettingsList) return;
  if (isOrganizationAccount()) {
    el.mobileHomeSettingsList.innerHTML = "";
    return;
  }
  const draft = currentMobileHomeDraft();
  const items = mobileHomeItemsForSettings();
  if (!items.length) {
    el.mobileHomeSettingsList.innerHTML = '<p class="empty-state">Für dein Konto ist derzeit kein Bereich für die Startseite freigeschaltet.</p>';
    if (el.saveMobileHomeButton) el.saveMobileHomeButton.disabled = true;
    return;
  }
  if (el.saveMobileHomeButton) el.saveMobileHomeButton.disabled = false;
  el.mobileHomeSettingsList.innerHTML = items.map((item, index) => {
    const rgb = normalizedRgb(draft.colors[item.id], mobileHomeDefaultColors[item.id]);
    return `
      <div class="mobile-home-setting-row" data-mobile-home-item="${esc(item.id)}">
        <div class="mobile-home-setting-copy"><span class="mobile-home-color-preview" style="--mobile-home-tile-color:rgb(${rgb.join(",")})"></span><span><strong>${esc(item.label)}</strong><small>${esc(item.description)}</small></span></div>
        <label class="mobile-home-color-picker"><span>Farbe</span><input type="color" data-mobile-home-color-picker value="${rgbToHex(rgb)}" aria-label="${esc(item.label)} Farbwahl" /></label>
        <div class="mobile-home-rgb-fields" aria-label="${esc(item.label)} RGB-Werte"><label><span>R</span><input data-mobile-home-rgb="r" type="number" min="0" max="255" step="1" inputmode="numeric" value="${rgb[0]}" /></label><label><span>G</span><input data-mobile-home-rgb="g" type="number" min="0" max="255" step="1" inputmode="numeric" value="${rgb[1]}" /></label><label><span>B</span><input data-mobile-home-rgb="b" type="number" min="0" max="255" step="1" inputmode="numeric" value="${rgb[2]}" /></label></div>
        <div class="mobile-home-order-actions" aria-label="${esc(item.label)} anordnen"><button type="button" data-mobile-home-move="-1" aria-label="${esc(item.label)} nach oben verschieben" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" data-mobile-home-move="1" aria-label="${esc(item.label)} nach unten verschieben" ${index === items.length - 1 ? "disabled" : ""}>↓</button></div>
      </div>`;
  }).join("");
}

function mobileHomeRgbFromRow(row) {
  const values = ["r", "g", "b"].map((channel) => Number(row.querySelector(`[data-mobile-home-rgb="${channel}"]`)?.value));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return values;
}

function updateMobileHomeColor(itemId, row, rgb) {
  if (!mobileHomeTileById.has(itemId) || !rgb) return false;
  const draft = currentMobileHomeDraft();
  draft.colors[itemId] = [...rgb];
  row?.querySelector("[data-mobile-home-color-picker]")?.setAttribute("value", rgbToHex(rgb));
  if (row?.querySelector("[data-mobile-home-color-picker]")) row.querySelector("[data-mobile-home-color-picker]").value = rgbToHex(rgb);
  row?.querySelector(".mobile-home-color-preview")?.style.setProperty("--mobile-home-tile-color", `rgb(${rgb.join(",")})`);
  renderMobileHome();
  message(el.mobileHomeSettingsMessage, "Vorschau aktiv. Bitte speichern, um die Auswahl zu behalten.");
  return true;
}

function updateMobileHomeColorFromPicker(row) {
  const picker = row?.querySelector("[data-mobile-home-color-picker]");
  const itemId = String(row?.dataset.mobileHomeItem || "");
  const match = String(picker?.value || "").match(/^#([0-9a-f]{6})$/i);
  if (!match) return;
  const hex = match[1];
  const rgb = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  ["r", "g", "b"].forEach((channel, index) => {
    const input = row.querySelector(`[data-mobile-home-rgb="${channel}"]`);
    if (input) input.value = String(rgb[index]);
  });
  updateMobileHomeColor(itemId, row, rgb);
}

function moveMobileHomeItem(itemId, direction) {
  const draft = currentMobileHomeDraft();
  const visibleOrder = mobileHomeItemsForSettings().map((item) => item.id);
  const index = visibleOrder.indexOf(itemId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= visibleOrder.length) return;
  [visibleOrder[index], visibleOrder[target]] = [visibleOrder[target], visibleOrder[index]];
  const visible = new Set(visibleOrder);
  draft.order = [...visibleOrder, ...draft.order.filter((id) => !visible.has(id))];
  renderMobileHomeSettings();
  renderMobileHome();
  message(el.mobileHomeSettingsMessage, "Vorschau aktiv. Bitte speichern, um die Reihenfolge zu behalten.");
}

function resetMobileHomeSettings() {
  const defaults = defaultMobilePortalHome();
  portalState.mobileHomeDraft = {
    order: [...defaults.order],
    colors: Object.fromEntries(Object.entries(defaults.colors).map(([id, rgb]) => [id, [...rgb]])),
  };
  renderMobileHomeSettings();
  renderMobileHome();
  message(el.mobileHomeSettingsMessage, "Der Rollenstandard ist als Vorschau eingestellt. Bitte noch speichern.");
}

async function saveMobileHomeSettings() {
  const draft = currentMobileHomeDraft();
  const home = normalizedMobilePortalHome({ version: 1, order: draft.order, colors: draft.colors });
  if (el.saveMobileHomeButton) el.saveMobileHomeButton.disabled = true;
  message(el.mobileHomeSettingsMessage, "");
  try {
    portalState.uiPreferences = await api("/api/portal/v1/ui-preferences", {
      method: "PUT",
      body: JSON.stringify({ mobilePortalHome: home }),
    });
    portalState.mobileHomeDraft = null;
    renderMobileHomeSettings();
    renderMobileHome();
    message(el.mobileHomeSettingsMessage, "Deine persönliche Startseite wurde gespeichert.");
  } catch (error) {
    message(el.mobileHomeSettingsMessage, error.message, true);
  } finally {
    if (el.saveMobileHomeButton) el.saveMobileHomeButton.disabled = false;
  }
}

function mobileNavigationItemsForSettings() {
  const allowed = new Set(availablePersonalMobileModules());
  const draft = currentMobileNavigationDraft();
  return draft.order
    .filter((id) => allowed.has(id))
    .map((id) => mobileModuleById.get(id))
    .filter(Boolean);
}

function renderMobileNavigationSettings() {
  if (!el.mobileNavigationSettingsList) return;
  const draft = currentMobileNavigationDraft();
  const items = mobileNavigationItemsForSettings();
  const selected = new Set(draft.selected);
  if (!items.length) {
    el.mobileNavigationSettingsList.innerHTML = '<p class="empty-state">Für dein Konto ist derzeit kein direkter Portalbereich freigeschaltet. „Mehr“ und die persönlichen Einstellungen bleiben erreichbar.</p>';
    if (el.saveMobileNavigationButton) el.saveMobileNavigationButton.disabled = true;
    return;
  }
  if (el.saveMobileNavigationButton) el.saveMobileNavigationButton.disabled = false;
  el.mobileNavigationSettingsList.innerHTML = items.map((item, index) => `
    <div class="mobile-navigation-setting-row" data-mobile-navigation-item="${esc(item.id)}">
      <label>
        <input type="checkbox" data-mobile-navigation-visible value="${esc(item.id)}" ${selected.has(item.id) ? "checked" : ""} ${!selected.has(item.id) && selected.size >= 5 ? "disabled" : ""} />
        <span><strong>${esc(item.label)}</strong><small>${esc(item.description)}</small></span>
      </label>
      <div class="mobile-navigation-order-actions" aria-label="${esc(item.label)} anordnen">
        <button type="button" data-mobile-navigation-move="-1" aria-label="${esc(item.label)} nach links verschieben" ${index === 0 ? "disabled" : ""}>↑</button>
        <button type="button" data-mobile-navigation-move="1" aria-label="${esc(item.label)} nach rechts verschieben" ${index === items.length - 1 ? "disabled" : ""}>↓</button>
      </div>
    </div>
  `).join("") + `<p class="mobile-navigation-limit">${selected.size} von höchstens 5 direkten Punkten · „Mehr“ bleibt fest am Ende.</p>`;
}

function updateMobileNavigationSelection(itemId, visible) {
  const draft = currentMobileNavigationDraft();
  const selected = new Set(draft.selected);
  if (visible && selected.size >= 5 && !selected.has(itemId)) {
    message(el.mobileNavigationSettingsMessage, "Im Bottom-Menü sind höchstens fünf direkte Punkte möglich. Weitere Bereiche bleiben unter „Mehr“ erreichbar.", true);
    return false;
  }
  if (visible) selected.add(itemId);
  else selected.delete(itemId);
  if (!selected.size) {
    message(el.mobileNavigationSettingsMessage, "Bitte mindestens einen direkten Punkt auswählen. „Mehr“ bleibt zusätzlich erreichbar.", true);
    return false;
  }
  draft.selected = draft.order.filter((id) => selected.has(id));
  message(el.mobileNavigationSettingsMessage, "");
  renderMobileNavigationSettings();
  applyMobileLeadershipLayout();
  return true;
}

function moveMobileNavigationItem(itemId, direction) {
  const draft = currentMobileNavigationDraft();
  const visibleOrder = mobileNavigationItemsForSettings().map((item) => item.id);
  const index = visibleOrder.indexOf(itemId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= visibleOrder.length) return;
  [visibleOrder[index], visibleOrder[target]] = [visibleOrder[target], visibleOrder[index]];
  const visibleSet = new Set(visibleOrder);
  draft.order = [...visibleOrder, ...draft.order.filter((id) => !visibleSet.has(id))];
  draft.selected = draft.order.filter((id) => draft.selected.includes(id));
  renderMobileNavigationSettings();
  applyMobileLeadershipLayout();
}

function resetMobileNavigationSettings() {
  const selected = defaultPersonalMobileSelection();
  const all = normalizedPersonalMobileNavigation(null).order;
  portalState.mobileNavigationDraft = {
    order: [...selected, ...all.filter((id) => !selected.includes(id))],
    selected: [...selected],
  };
  renderMobileNavigationSettings();
  applyMobileLeadershipLayout();
  message(el.mobileNavigationSettingsMessage, "Der Rollenstandard ist als Vorschau eingestellt. Bitte noch speichern.");
}

async function saveMobileNavigationSettings() {
  const draft = currentMobileNavigationDraft();
  const available = new Set(availablePersonalMobileModules());
  const stored = normalizedPersonalMobileNavigation(portalState.uiPreferences?.mobilePortalNavigation);
  const hidden = [
    ...stored.hidden.filter((id) => !available.has(id)),
    ...[...available].filter((id) => !draft.selected.includes(id)),
  ];
  const navigation = {
    version: 1,
    order: [...draft.order],
    hidden: [...new Set(hidden)],
  };
  el.saveMobileNavigationButton.disabled = true;
  message(el.mobileNavigationSettingsMessage, "");
  try {
    portalState.uiPreferences = await api("/api/portal/v1/ui-preferences", {
      method: "PUT",
      body: JSON.stringify({ mobilePortalNavigation: navigation }),
    });
    portalState.mobileNavigationDraft = null;
    renderMobileNavigationSettings();
    applyMobileLeadershipLayout();
    message(el.mobileNavigationSettingsMessage, "Dein persönliches Bottom-Menü wurde gespeichert.");
  } catch (error) {
    portalState.mobileNavigationDraft = null;
    renderMobileNavigationSettings();
    applyMobileLeadershipLayout();
    message(el.mobileNavigationSettingsMessage, error.message, true);
  } finally {
    el.saveMobileNavigationButton.disabled = false;
  }
}

function normalizedPortalTab(requested) {
  const aliases = { requests: "history", team: "leadershipTeam", approvals: "leadershipApprovals", more: "leadershipMore", time: "timeTracking" };
  const tab = aliases[requested] || requested;
  if (["leadershipTeam", "leadershipApprovals"].includes(tab) && !isLeadershipUser()) return "";
  return ["home", "settings", "schedule", "timeTracking", "processTasks", "timeOff", "vacation", "history", "loan", "branchOrders", "branchVacation", "amu", "leadershipTeam", "leadershipApprovals", "leadershipMore"].includes(tab) ? tab : "";
}

const portalTabStorageKey = "grabenplaner.portal.active-tab";

function storedPortalTab() {
  try {
    return normalizedPortalTab(sessionStorage.getItem(portalTabStorageKey));
  } catch {
    return "";
  }
}

function requestedPortalTab() {
  return normalizedPortalTab(new URLSearchParams(location.search).get("tab")) || storedPortalTab();
}

function requestedPortalSettingsSection() {
  const section = new URLSearchParams(location.search).get("section");
  return section === "branch-orders" ? section : "";
}

function focusPortalSettingsSection(section = requestedPortalSettingsSection()) {
  if (section !== "branch-orders") return;
  const target = el.branchOrderSettingsCard;
  if (!target || target.classList.contains("hidden")) return;
  target.open = true;
  requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function rememberPortalTab(tab) {
  const normalized = normalizedPortalTab(tab);
  if (!normalized) return;
  try {
    sessionStorage.setItem(portalTabStorageKey, normalized);
  } catch {}
  try {
    const url = new URL(location.href);
    url.searchParams.set("tab", normalized);
    if (normalized === "processTasks") {
      if (portalState.processTaskRequestedRunId) url.searchParams.set("run", portalState.processTaskRequestedRunId);
      if (portalState.processTaskRequestedStepId) url.searchParams.set("step", portalState.processTaskRequestedStepId);
    } else {
      portalState.processTaskRequestedRunId = "";
      portalState.processTaskRequestedStepId = "";
      url.searchParams.delete("run");
      url.searchParams.delete("step");
    }
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {}
}

function clearRememberedPortalTab() {
  try {
    sessionStorage.removeItem(portalTabStorageKey);
  } catch {}
  try {
    const url = new URL(location.href);
    url.searchParams.delete("tab");
    url.searchParams.delete("kind");
    url.searchParams.delete("run");
    url.searchParams.delete("step");
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {}
}

function chooseInitialPortalTab() {
  const requested = requestedPortalTab();
  const parameters = new URLSearchParams(location.search);
  const explicitTab = normalizedPortalTab(parameters.get("tab"));
  const requestedKind = parameters.get("kind");
  portalState.processTaskRequestedRunId = String(parameters.get("run") || "").slice(0, 120);
  portalState.processTaskRequestedStepId = String(parameters.get("step") || "").slice(0, 120);
  if (["absence", "sickness", "amu", "time_correction"].includes(requestedKind)) portalState.leadershipKind = requestedKind;
  setTab(explicitTab || (isMobileUi() ? "home" : requested || defaultPortalTab()));
  return requested;
}

function defaultPortalTab(user = portalUser()) {
  if (isMobileUi()) return "home";
  if (portalTabAllowed("timeTracking", user)) return "timeTracking";
  if (portalTabAllowed("schedule", user)) return "schedule";
  if (portalTabAllowed("loan", user)) return "loan";
  if (portalTabAllowed("branchOrders", user)) return "branchOrders";
  if (portalTabAllowed("learningDashboard", user)) return "learningDashboard";
  return "settings";
}

function clearCandidateEvaluationState() {
  portalState.candidateEvaluationsRequestGeneration += 1;
  portalState.candidateEvaluationsLoadPromise = null;
  portalState.candidateEvaluations = [];
  renderPendingCandidateEvaluationNotice();
}

function candidateEvaluationAvailable(user = portalUser()) {
  return Boolean(user && !isOrganizationAccount(user) && !user.mustChangePassword);
}

function renderPendingCandidateEvaluationNotice() {
  const notice = el.pendingCandidateEvaluationNotice;
  if (!notice) return;
  const evaluations = candidateEvaluationAvailable() ? portalState.candidateEvaluations : [];
  const evaluation = evaluations[0];
  notice.classList.toggle("hidden", !evaluation);
  if (!evaluation) {
    el.pendingCandidateEvaluationSummary.textContent = "";
    el.pendingCandidateEvaluationLink.removeAttribute("href");
    return;
  }
  const summary = evaluations.length === 1
    ? "Eine offene Bewerbungsbewertung wartet auf deine Rückmeldung."
    : `${evaluations.length} offene Bewerbungsbewertungen warten auf deine Rückmeldung.`;
  if (el.pendingCandidateEvaluationSummary.textContent !== summary) {
    el.pendingCandidateEvaluationSummary.textContent = summary;
  }
  el.pendingCandidateEvaluationLink.href = `/candidate-evaluation.html?id=${encodeURIComponent(evaluation.id)}`;
}

async function loadPendingCandidateEvaluations() {
  if (!candidateEvaluationAvailable()) {
    clearCandidateEvaluationState();
    return [];
  }
  if (portalState.candidateEvaluationsLoadPromise) return portalState.candidateEvaluationsLoadPromise;
  const session = portalState.session;
  const generation = ++portalState.candidateEvaluationsRequestGeneration;
  const isCurrent = () => portalState.session === session
    && portalState.candidateEvaluationsRequestGeneration === generation;
  const pending = (async () => {
    try {
      const result = await api("/api/portal/v1/me/candidate-evaluations");
      if (!isCurrent()) return [];
      portalState.candidateEvaluations = (Array.isArray(result?.evaluations) ? result.evaluations : [])
        .filter((entry) => typeof entry?.id === "string" && entry.id.trim())
        .map((entry) => ({ id: entry.id }));
      renderPendingCandidateEvaluationNotice();
      return portalState.candidateEvaluations;
    } catch (error) {
      if (isCurrent() && [401, 403, 404, 428].includes(error?.status)) {
        portalState.candidateEvaluations = [];
        renderPendingCandidateEvaluationNotice();
      }
      throw error;
    } finally {
      if (isCurrent()) portalState.candidateEvaluationsLoadPromise = null;
    }
  })();
  portalState.candidateEvaluationsLoadPromise = pending;
  return pending;
}

async function redirectToPendingCandidateEvaluation(user = portalUser()) {
  if (!candidateEvaluationAvailable(user)) return false;
  const session = portalState.session;
  try {
    const evaluations = await loadPendingCandidateEvaluations();
    if (portalState.session !== session) return false;
    const evaluation = evaluations[0];
    if (!evaluation?.id) return false;
    window.location.replace(`/candidate-evaluation.html?id=${encodeURIComponent(evaluation.id)}`);
    return true;
  } catch (error) {
    if (error?.status === 401) throw error;
    return false;
  }
}

async function initialize() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    [el.timeOffDate, el.timeOffDateTo, el.vacationDateFrom, el.vacationDateTo].forEach((input) => { if (input) input.min = today; });
    if (el.sicknessStartDate) { el.sicknessStartDate.min = addDays(today, -5); el.sicknessStartDate.max = today; el.sicknessStartDate.value = today; }
    if (el.amuIncapacityFrom) el.amuIncapacityFrom.min = addDays(today, -3650);
    if (el.amuIncapacityTo) el.amuIncapacityTo.min = addDays(today, -3650);
    updateSicknessRangeControls();
    const status = await api("/api/portal/v1/status");
    portalState.status = status;
    applyPortalBranding(status.branding);
    el.portalDeploymentBanner?.classList.toggle("hidden", status.deploymentKind !== "codespaces-test");
    applyPortalCapabilities();
    const minimum = Number(status.passwordMinLength || 6);
    [el.loginPassword, el.newPassword, el.repeatPassword, el.passwordResetNewPassword, el.passwordResetRepeatPassword]
      .forEach((input) => { if (input) input.minLength = minimum; });
    if (el.portalAccessModeLabel) el.portalAccessModeLabel.textContent = status.operationMode === "server" ? "Mitarbeiterportal · HTTPS" : "Mitarbeiterportal";
    if (!status.portalEnabled) {
      message(el.loginError, "Das Mitarbeiterportal ist für diese Installation nicht freigeschaltet.", true);
      return;
    }
    const session = await api("/api/portal/v1/session");
    if (!session.authenticated) {
      showLogin();
      openPasswordResetConfirm();
      return;
    }
    showPortal(session);
    if (!session.user.mustChangePassword) {
      if (await redirectToPendingCandidateEvaluation(session.user)) return;
      await Promise.allSettled([loadMobileLayout(), loadPersonnelLearningDashboard()]);
      chooseInitialPortalTab();
      await loadPortalData();
      await refreshBirthdayPresentationTheme();
      await claimBirthdayPresentation();
    }
    openPasswordResetConfirm();
  } catch (error) {
    showLogin(error.message);
  }
}

async function loadPortalData() {
  const requests = [];
  requests.push(loadPersonnelLearningDashboard());
  if (!isOrganizationAccount()) requests.push(loadPortalHome(), loadNotifications());
  if (portalTabAllowed("schedule")) requests.push(loadSchedule());
  if (portalTabAllowed("branchVacation")) requests.push(loadBranchVacationOverview());
  if (portalTabAllowed("vacation")) requests.push(loadVacationRequests(), loadApprovedVacations());
  if (portalTabAllowed("timeOff")) requests.push(loadTimeOffRequests());
  if (portalTabAllowed("history")) requests.push(loadAbsenceHistory());
  if (portalTabAllowed("processTasks")) requests.push(loadProcessTasks());
  if (portalTabAllowed("amu")) requests.push(loadSicknessCases(), loadAmuReports(), loadAmuSettings());
  if (portalTabAllowed("timeTracking")) requests.push(loadTimeTracking());
  if (hasPortalPermission("own_privacy_requests:read")) requests.push(loadPrivacyRequests());
  if (hasPortalPermission("own_vacation:read")) requests.push(loadVacationAccount());
  if (portalTabAllowed("loan")) requests.push(loadLoanModule());
  if (portalTabAllowed("branchOrders")) requests.push(loadBranchOrderCatalog(), loadBranchOrderPortalHistory());
  if (branchPortalDisplaySettingsEnabled()) requests.push(loadBranchPortalDisplaySettings());
  await Promise.allSettled(requests);
}

function portalLearningProgressStatusLabel(progress) {
  if (!progress || progress.status === "not_started") return "Noch nicht begonnen";
  if (progress.status === "in_progress") return "In Durchführung";
  return ({
    passed: "Alles erfüllt",
    follow_up_required: "Nachschulung erforderlich",
    not_passed: "Nicht bestanden",
    pending: "Noch nicht bewertet",
  })[progress.result] || "Abgeschlossen";
}

function portalLearningSelectedProfile() {
  const profiles = portalState.personnelLearningDashboard?.profiles || [];
  return profiles.find((profile) => (
    profile.employee?.employeeNumber === portalState.personnelLearningDashboardEmployeeNumber
  )) || profiles[0] || null;
}

function renderPortalLearningSkillTree() {
  if (!el.portalLearningSkillTree || !el.portalLearningDashboardEmployee) return;
  const profiles = portalState.personnelLearningDashboard?.profiles || [];
  const profile = portalLearningSelectedProfile();
  if (profile && portalState.personnelLearningDashboardEmployeeNumber
    !== profile.employee.employeeNumber) {
    portalState.personnelLearningDashboardEmployeeNumber = profile.employee.employeeNumber;
  }
  el.portalLearningDashboardEmployee.innerHTML = profiles.length
    ? profiles.map((entry) => `<option value="${esc(entry.employee.employeeNumber)}">${esc(entry.employee.fullName)} · ${esc(entry.employee.locationName || entry.employee.employeeNumber)}</option>`).join("")
    : '<option value="">Keine Kompetenzprofile sichtbar</option>';
  el.portalLearningDashboardEmployee.value =
    portalState.personnelLearningDashboardEmployeeNumber || "";
  el.portalLearningDashboardEmployee.disabled = profiles.length < 2;
  if (!profile) {
    el.portalLearningSkillTree.innerHTML = '<p class="empty-state">Noch kein aktives Fähigkeitsprofil vorhanden.</p>';
    return;
  }
  const categories = new Map();
  for (const competency of profile.competencies || []) {
    const category = String(competency.skillCategory || "Allgemein");
    const rows = categories.get(category) || [];
    rows.push(competency);
    categories.set(category, rows);
  }
  el.portalLearningSkillTree.innerHTML = [...categories.entries()].map(([category, rows]) => `
    <section class="portal-learning-skill-branch">
      <header><span aria-hidden="true">◆</span><div><strong>${esc(category)}</strong><small>${rows.length} Fähigkeit${rows.length === 1 ? "" : "en"}</small></div></header>
      <div>${rows.map((competency) => {
        const definitions = Array.isArray(competency.levelDefinitions)
          ? competency.levelDefinitions : [];
        const current = competency.levelDefinition || {};
        return `<article class="portal-learning-skill-node">
          <div class="portal-learning-skill-node-heading"><div><span>${esc(competency.skillCode)}</span><h3>${esc(competency.skillTitle)}</h3></div><div><strong>Stufe ${Number(competency.level)}</strong>${competency.trainerAuthorized ? "<em>Trainerfreigabe</em>" : ""}</div></div>
          <div class="portal-learning-level-rail" role="img" aria-label="${esc(competency.skillTitle)}: Stufe ${Number(competency.level)} von 10">${definitions.map((definition) => `<span class="${Number(definition.level) <= Number(competency.level) ? "reached" : ""}${Number(definition.level) === Number(competency.level) ? " current" : ""}" title="Stufe ${Number(definition.level)} · ${esc(definition.label)}"><b>${Number(definition.level)}</b></span>`).join("")}</div>
          <div class="portal-learning-current-level"><strong>${esc(current.label || `Stufe ${Number(competency.level)}`)}</strong><p>${esc(current.description || competency.skillSummary || "Verbindlicher Kompetenzstand")}</p></div>
        </article>`;
      }).join("")}</div>
    </section>`).join("");
}

function renderPersonnelLearningDashboardPortal() {
  if (!el.personnelLearningDashboardView) return;
  const dashboard = portalState.personnelLearningDashboard;
  const summary = dashboard?.summary || {};
  if (el.portalLearningDashboardSummary) {
    el.portalLearningDashboardSummary.innerHTML = [
      ["Aktiv", Number(summary.activeAssignments || 0), "Schulungen"],
      ["In Arbeit", Number(summary.inProgress || 0), "aus Schritten"],
      ["Erledigt", Number(summary.completed || 0), "bewertet"],
      ["Klärung", Number(summary.attentionRequired || 0), "offene Punkte"],
      ["Fähigkeiten", Number(summary.competencies || 0), `${Number(summary.trainerSkills || 0)} Trainerfreigaben`],
    ].map(([label, value, detail]) => `<article><span>${label}</span><strong>${value}</strong><small>${detail}</small></article>`).join("");
  }
  const scope = dashboard?.viewer?.scope;
  if (el.portalLearningDashboardScope) {
    el.portalLearningDashboardScope.textContent = scope
      ? `Sichtbarer Bereich: ${[scope.locationName, scope.departmentName].filter(Boolean).join(" · ")}. Die Ansicht erweitert keine Rechte.`
      : dashboard?.capabilities?.canViewTeam
        ? "Sichtbar ist ausschließlich der aktuell wirksame Verantwortungsbereich. Die Ansicht erweitert keine Rechte."
        : "Sichtbar sind ausschließlich eigene Schulungen, Trainerbindungen und Kompetenzprofile.";
  }
  if (portalState.personnelLearningDashboardLoading) {
    el.portalLearningDashboardAssignments.innerHTML = '<p class="empty-state">Schulungsstände werden geladen.</p>';
    el.portalLearningSkillTree.innerHTML = '<p class="empty-state">Fähigkeitsprofile werden geladen.</p>';
    return;
  }
  const assignments = dashboard?.assignments || [];
  el.portalLearningDashboardAssignments.innerHTML = assignments.length
    ? assignments.map((assignment) => {
        const progress = assignment.progress || {};
        const attention = ["follow_up_required", "not_passed"].includes(progress.result)
          || (assignment.trainers || []).some((trainer) => trainer.currentEligible !== true);
        const mayWrite = progress.capabilities?.canRecord === true
          || progress.capabilities?.canCorrect === true;
        return `<article class="portal-learning-assignment${attention ? " attention" : ""}">
          <header><div><span>${esc(assignment.learner?.fullName || assignment.learner?.employeeNumber)}</span><h3>${esc(assignment.process?.title || "Schulung")}</h3></div><strong>${esc(portalLearningProgressStatusLabel(progress))}</strong></header>
          <div class="portal-learning-progress-track"><span style="width:${Math.max(0, Math.min(100, Number(progress.percent || 0)))}%"></span></div>
          <p>${Number(progress.completedStepCount || 0)} von ${Number(progress.totalStepCount || 0)} Schritten · ${Number(progress.percent || 0)} %</p>
          <small>${esc((assignment.trainers || []).map((trainer) => `${trainer.trainerName} · ${trainer.skillTitle}`).join(" · ") || "Keine Trainerbindung")}</small>
          <button class="${mayWrite ? "primary" : "text-button"}" data-portal-learning-progress="${esc(assignment.id)}" type="button">${mayWrite ? "Fortschritt erfassen" : "Fortschritt ansehen"}</button>
        </article>`;
      }).join("")
    : '<p class="empty-state">Im sichtbaren Bereich gibt es noch keine Schulungszuweisung.</p>';
  renderPortalLearningSkillTree();
}

async function loadPersonnelLearningDashboard({ force = false } = {}) {
  if (portalState.personnelLearningDashboardLoading) return;
  if (portalState.personnelLearningDashboard && !force) {
    renderPersonnelLearningDashboardPortal();
    return;
  }
  portalState.personnelLearningDashboardLoading = true;
  message(el.portalLearningDashboardMessage, "");
  renderPersonnelLearningDashboardPortal();
  try {
    const dashboard = await api("/api/portal/v1/personnel-learning/dashboard");
    if (!dashboard || !Array.isArray(dashboard.assignments)
      || !Array.isArray(dashboard.profiles)) {
      throw new Error("Das Schulungsdashboard ist unvollständig.");
    }
    portalState.personnelLearningDashboard = dashboard;
    portalState.personnelLearningDashboardAvailable = dashboard.available === true;
    const profiles = dashboard.profiles || [];
    if (!profiles.some((profile) => (
      profile.employee?.employeeNumber === portalState.personnelLearningDashboardEmployeeNumber
    ))) {
      portalState.personnelLearningDashboardEmployeeNumber =
        profiles[0]?.employee?.employeeNumber || "";
    }
  } catch (error) {
    portalState.personnelLearningDashboard = null;
    portalState.personnelLearningDashboardAvailable = false;
    if (![401, 403].includes(error.status)) {
      message(el.portalLearningDashboardMessage, error.message, true);
    }
  } finally {
    portalState.personnelLearningDashboardLoading = false;
    renderPersonnelLearningDashboardPortal();
    applySelfServiceVisibility();
    applyMobileLeadershipLayout();
    renderMobileHome();
    if (portalState.activeTab === "learningDashboard"
      && !portalTabAllowed("learningDashboard")) setTab(defaultPortalTab());
  }
}

function renderPortalLearningProgressDialog() {
  const assignment = portalState.personnelLearningProgressAssignment;
  if (!assignment || !el.portalLearningProgressDialog) return;
  const progress = assignment.progress || {};
  const canRecord = progress.capabilities?.canRecord === true;
  const canFinalize = progress.capabilities?.canFinalize === true;
  const canCorrect = progress.capabilities?.canCorrect === true;
  const mayWrite = canRecord || canCorrect;
  el.portalLearningProgressTitle.textContent =
    `${assignment.process?.title || "Schulung"} · ${assignment.learner?.fullName || assignment.learner?.employeeNumber}`;
  el.portalLearningProgressAssignmentId.value = assignment.id;
  el.portalLearningProgressAssignmentReceipt.value =
    assignment.currentAssignmentRevisionReceipt || "";
  el.portalLearningProgressExpectedReceipt.value = progress.currentRevisionReceipt || "";
  el.portalLearningProgressSummary.innerHTML = `<strong>${esc(portalLearningProgressStatusLabel(progress))}</strong><p>Gebundene Prozessversion ${Number(assignment.process?.versionNumber || 0)} · Fortschritt wird ausschließlich aus den erledigten Schritten berechnet.</p>`;
  el.portalLearningProgressSteps.innerHTML = (progress.steps || []).map((step) => `
    <label class="portal-learning-progress-step${step.completed ? " completed" : ""}">
      <input type="checkbox" data-portal-learning-step="${esc(step.stepId)}" data-required="${step.required ? "true" : "false"}" ${step.completed ? "checked" : ""} ${mayWrite ? "" : "disabled"} />
      <span><strong>${Number(step.order)}. ${esc(step.title)}</strong><small>${esc(step.completionCriteria || step.instruction || (step.required ? "Pflichtschritt" : "Optional"))}</small></span><em>${step.required ? "Pflicht" : "Optional"}</em>
    </label>`).join("");
  el.portalLearningProgressAssessment.classList.toggle("hidden", !canFinalize && !canCorrect);
  el.portalLearningProgressFinalized.checked = Boolean(progress.finalized);
  el.portalLearningProgressFinalized.disabled = !canFinalize && !canCorrect;
  el.portalLearningProgressResult.value = progress.finalized ? progress.result : "pending";
  el.portalLearningProgressResult.disabled = !canFinalize && !canCorrect;
  el.portalLearningProgressAssessmentNote.value = progress.assessmentNote || "";
  el.portalLearningProgressAssessmentNote.disabled = !canFinalize && !canCorrect;
  el.portalLearningProgressCorrectionReasonField.classList.toggle("hidden", !canCorrect);
  el.portalLearningProgressCorrectionReason.required = canCorrect;
  el.portalLearningProgressCorrectionReason.value = "";
  el.savePortalLearningProgress.classList.toggle("hidden", !mayWrite);
  updatePortalLearningProgressAvailability();
}

function updatePortalLearningProgressAvailability() {
  const assignment = portalState.personnelLearningProgressAssignment;
  if (!assignment || !el.savePortalLearningProgress) return;
  const progress = assignment.progress || {};
  const canRecord = progress.capabilities?.canRecord === true;
  const canFinalize = progress.capabilities?.canFinalize === true;
  const canCorrect = progress.capabilities?.canCorrect === true;
  const mayWrite = canRecord || canCorrect;
  const assessmentWritable = canFinalize || canCorrect;
  const finalized = assessmentWritable && el.portalLearningProgressFinalized.checked;
  const requiredComplete = [...el.portalLearningProgressSteps.querySelectorAll(
    'input[type="checkbox"][data-required="true"]',
  )].every((checkbox) => checkbox.checked);
  const resultSelected = el.portalLearningProgressResult.value !== "pending";
  const correctionReasonPresent = !progress.hasFinalizedRevision
    || el.portalLearningProgressCorrectionReason.value.trim().length > 0;
  el.portalLearningProgressResult.disabled = !assessmentWritable || !finalized;
  el.portalLearningProgressAssessmentNote.disabled = !assessmentWritable || !finalized;
  el.savePortalLearningProgress.disabled = portalState.personnelLearningProgressMutationPending
    || !mayWrite
    || (finalized && (!requiredComplete || !resultSelected))
    || (canCorrect && !correctionReasonPresent);
}

async function openPortalLearningProgress(assignmentId) {
  message(el.portalLearningProgressMessage, "");
  const result = await api(`/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignmentId)}/progress`);
  portalState.personnelLearningProgressAssignment = result.assignment || null;
  if (!portalState.personnelLearningProgressAssignment) {
    throw new Error("Der Schulungsfortschritt ist nicht verfügbar.");
  }
  renderPortalLearningProgressDialog();
  el.portalLearningProgressDialog.showModal();
  el.portalLearningProgressSteps.querySelector("input:not(:disabled)")?.focus();
}

async function savePortalLearningProgress(event) {
  event.preventDefault();
  const assignment = portalState.personnelLearningProgressAssignment;
  if (!assignment || portalState.personnelLearningProgressMutationPending) return;
  const completedStepIds = [...el.portalLearningProgressSteps.querySelectorAll(
    'input[type="checkbox"][data-portal-learning-step]:checked',
  )].map((checkbox) => checkbox.dataset.portalLearningStep);
  const finalized = !el.portalLearningProgressAssessment.classList.contains("hidden")
    && el.portalLearningProgressFinalized.checked;
  const requiredComplete = [...el.portalLearningProgressSteps.querySelectorAll(
    'input[type="checkbox"][data-required="true"]',
  )].every((checkbox) => checkbox.checked);
  if (finalized && !requiredComplete) {
    message(el.portalLearningProgressMessage, "Vor dem Abschluss müssen alle Pflichtschritte erledigt sein.", true);
    return;
  }
  if (finalized && el.portalLearningProgressResult.value === "pending") {
    message(el.portalLearningProgressMessage, "Bitte ein Abschlussergebnis auswählen.", true);
    return;
  }
  portalState.personnelLearningProgressMutationPending = true;
  el.savePortalLearningProgress.disabled = true;
  message(el.portalLearningProgressMessage, "Der neue Fortschrittsstand wird revisionssicher gespeichert.");
  try {
    const result = await api(`/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignment.id)}/progress`, {
      method: "PUT",
      body: JSON.stringify({
        expectedAssignmentRevisionReceipt: el.portalLearningProgressAssignmentReceipt.value,
        expectedProgressRevisionReceipt: el.portalLearningProgressExpectedReceipt.value,
        completedStepIds,
        finalized,
        result: finalized ? el.portalLearningProgressResult.value : "pending",
        assessmentNote: finalized ? el.portalLearningProgressAssessmentNote.value : "",
        correctionReason: assignment.progress?.hasFinalizedRevision
          ? el.portalLearningProgressCorrectionReason.value : "",
      }),
    });
    portalState.personnelLearningProgressAssignment = result.assignment;
    el.portalLearningProgressDialog.close();
    portalState.personnelLearningDashboard = null;
    await loadPersonnelLearningDashboard({ force: true });
  } catch (error) {
    message(el.portalLearningProgressMessage, error.message, true);
  } finally {
    portalState.personnelLearningProgressMutationPending = false;
    renderPortalLearningProgressDialog();
  }
}

function renderPortalGreeting() {
  const greeting = portalState.home?.greeting;
  const text = greeting?.enabled !== false ? String(greeting?.text || "").trim() : "";
  if (!el.timeTrackingGreeting) return;
  el.timeTrackingGreeting.textContent = text;
  el.timeTrackingGreeting.classList.toggle("hidden", !text);
}

async function loadPortalHome() {
  try {
    portalState.home = await api("/api/portal/v1/me/home");
  } catch {
    portalState.home = null;
  }
  renderPortalGreeting();
}

function renderPrivacyRequestTypes() {
  if (!el.privacyRequestType) return;
  const types = portalState.privacyRequestTypes.length
    ? portalState.privacyRequestTypes
    : defaultPrivacyRequestTypes;
  const selected = el.privacyRequestType.value;
  el.privacyRequestType.innerHTML = types
    .filter((item) => item?.id && item?.label)
    .map((item) => `<option value="${esc(item.id)}">${esc(item.label)}</option>`)
    .join("");
  if (types.some((item) => item.id === selected)) el.privacyRequestType.value = selected;
}

function privacyRequestTypeLabel(type) {
  const types = portalState.privacyRequestTypes.length
    ? portalState.privacyRequestTypes
    : defaultPrivacyRequestTypes;
  return types.find((item) => item.id === type)?.label || type || "Datenschutzanfrage";
}

function privacyRequestStatusTone(status) {
  if (["approved", "partially_approved", "fulfilled", "partially_fulfilled"].includes(status)) return "approved";
  if (status === "rejected") return "rejected";
  if (status === "withdrawn") return "withdrawn";
  return "pending";
}

function renderPrivacyRequests() {
  if (!el.privacyRequestList || !hasPortalPermission("own_privacy_requests:read")) return;
  if (portalState.privacyRequestsLoading) {
    el.privacyRequestList.innerHTML = '<p class="empty-state">Datenschutzanfragen werden geladen.</p>';
    return;
  }
  const requests = portalState.privacyRequests;
  el.privacyRequestList.innerHTML = requests.length ? requests.map((request) => {
    const identity = privacyIdentityStatusLabels[request.identityStatus] || request.identityStatus || "Identitätsprüfung offen";
    const scope = Array.isArray(request.scope) && request.scope.length
      ? `<small>${request.scope.length === 1 ? "1 Datenbereich" : `${request.scope.length} Datenbereiche`}</small>`
      : "";
    const due = request.dueAt ? `<small>Zieltermin: ${esc(timestampText(request.dueAt))}</small>` : "";
    const canWithdraw = hasPortalPermission("own_privacy_requests:create")
      && !["rejected", "fulfilled", "partially_fulfilled", "withdrawn"].includes(request.status);
    const canExport = hasPortalPermission("own_privacy_export:read")
      && request.identityStatus === "verified"
      && ["approved", "partially_approved", "fulfilled", "partially_fulfilled"].includes(request.status);
    return `<article class="privacy-request-item">
      <div><strong>${esc(privacyRequestTypeLabel(request.type))}</strong><small>Eingelangt: ${esc(timestampText(request.receivedAt))}</small>${due}${scope}<small>${esc(identity)}</small></div>
      <div class="privacy-request-actions">
        <span class="status ${privacyRequestStatusTone(request.status)}">${esc(privacyRequestStatusLabels[request.status] || request.status || "Offen")}</span>
        ${canExport ? `<a class="text-button" href="/api/portal/v1/self/privacy-requests/${encodeURIComponent(String(request.id))}/export">Datenauskunft laden</a>` : ""}
        ${canWithdraw ? `<button class="cancel-request" data-withdraw-privacy-request="${esc(request.id)}" type="button">Zurücknehmen</button>` : ""}
      </div>
    </article>`;
  }).join("") : '<p class="empty-state">Du hast noch keine Datenschutzanfrage eingereicht.</p>';
}

async function loadPrivacyRequests() {
  if (!hasPortalPermission("own_privacy_requests:read") || portalState.privacyRequestsLoading) return;
  portalState.privacyRequestsLoading = true;
  let loadError = "";
  renderPrivacyRequests();
  try {
    const data = await api("/api/portal/v1/self/privacy-requests");
    portalState.privacyRequests = Array.isArray(data.requests) ? data.requests : [];
    portalState.privacyRequestTypes = Array.isArray(data.requestTypes) && data.requestTypes.length
      ? data.requestTypes
      : defaultPrivacyRequestTypes;
    el.privacyRequestsNotice.textContent = data.notice
      || "Jede Anfrage wird nach einer Identitätsprüfung manuell bearbeitet und nachvollziehbar entschieden.";
    renderPrivacyRequestTypes();
  } catch (error) {
    portalState.privacyRequests = [];
    loadError = error.message;
  } finally {
    portalState.privacyRequestsLoading = false;
    if (loadError) {
      el.privacyRequestList.innerHTML = `<p class="empty-state">${esc(loadError)}</p>`;
    } else {
      renderPrivacyRequests();
    }
  }
}

async function submitPrivacyRequest(event) {
  event.preventDefault();
  if (!hasPortalPermission("own_privacy_requests:create") || !el.privacyRequestType.value) return;
  el.privacyRequestSubmit.disabled = true;
  message(el.privacyRequestMessage, "");
  try {
    const result = await api("/api/portal/v1/self/privacy-requests", {
      method: "POST",
      body: JSON.stringify({ type: el.privacyRequestType.value }),
    });
    message(
      el.privacyRequestMessage,
      "Die Anfrage wurde sicher eingereicht. Identität, Umfang und mögliche Ausnahmen werden manuell geprüft.",
    );
    if (hasPortalPermission("own_privacy_requests:read")) {
      await loadPrivacyRequests();
    } else if (result?.request) {
      el.privacyRequestsNotice.textContent = "Die Anfrage wurde eingereicht und wird manuell bearbeitet.";
    }
  } catch (error) {
    message(el.privacyRequestMessage, error.message, true);
  } finally {
    el.privacyRequestSubmit.disabled = false;
  }
}

async function withdrawPrivacyRequest(id) {
  if (!id || !hasPortalPermission("own_privacy_requests:create")) return;
  if (!confirm("Diese Datenschutzanfrage wirklich zurücknehmen?")) return;
  try {
    await api(`/api/portal/v1/self/privacy-requests/${encodeURIComponent(String(id))}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "withdraw" }),
    });
    message(el.privacyRequestMessage, "Die Datenschutzanfrage wurde zurückgenommen.");
    await loadPrivacyRequests();
  } catch (error) {
    message(el.privacyRequestMessage, error.message, true);
  }
}

function resetCredentialVisibility(input) {
  if (!input) return;
  if (window.GrabenplanerCredentialBoundaries?.resetPasswordVisibility) {
    window.GrabenplanerCredentialBoundaries.resetPasswordVisibility(input);
    return;
  }
  input.type = "password";
  const button = input.closest(".password-field")?.querySelector("[data-password-toggle]");
  if (!button) return;
  button.textContent = "Anzeigen";
  button.setAttribute("aria-label", "Passwort anzeigen");
}

function setPortalLoginControlsEnabled(enabled) {
  if (el.loginPersonnelNumber) el.loginPersonnelNumber.disabled = !enabled;
  if (el.loginPassword) {
    if (!enabled) {
      el.loginPassword.value = "";
      resetCredentialVisibility(el.loginPassword);
    }
    if (enabled) el.loginPassword.readOnly = false;
    el.loginPassword.disabled = !enabled;
  }
}

function portalCredentialUsername() {
  const user = portalUser();
  return String(user?.loginName || user?.employeeNumber || "");
}

function setPasswordResetConfirmControlsEnabled(enabled) {
  [el.passwordResetNewPassword, el.passwordResetRepeatPassword].forEach((input) => {
    if (!input) return;
    if (!enabled) {
      input.value = "";
      resetCredentialVisibility(input);
    }
    if (enabled) input.readOnly = false;
    input.disabled = !enabled;
  });
}

function setPasswordChangeControlsEnabled(enabled) {
  if (el.passwordChangeUsername) {
    el.passwordChangeUsername.value = enabled ? portalCredentialUsername() : "";
    el.passwordChangeUsername.disabled = !enabled;
  }
  [el.currentPassword, el.newPassword, el.repeatPassword].forEach((input) => {
    if (!input) return;
    if (!enabled) {
      input.value = "";
      resetCredentialVisibility(input);
    }
    if (enabled) input.readOnly = false;
    input.disabled = !enabled;
  });
}

function openPasswordChangeDialog() {
  el.passwordForm?.reset();
  el.passwordDialog?.showModal();
  setPasswordChangeControlsEnabled(true);
  window.setTimeout(() => el.currentPassword?.focus(), 0);
}

function closePasswordChangeDialog({ force = false } = {}) {
  if (!force && el.passwordDialog?.dataset.required === "true") return false;
  el.passwordForm?.reset();
  setPasswordChangeControlsEnabled(false);
  if (el.passwordDialog?.open) el.passwordDialog.close();
  return true;
}

function neutralizeCredentialDialogsForLogin() {
  closePasswordChangeDialog({ force: true });
  if (el.passwordDialog) el.passwordDialog.dataset.required = "false";
  if (el.passwordResetConfirmDialog?.open) {
    closePasswordResetConfirm();
  } else {
    if (el.passwordResetToken) el.passwordResetToken.value = "";
    setPasswordResetConfirmControlsEnabled(false);
    message(el.passwordResetConfirmMessage, "");
  }
  el.passwordResetRequestForm?.reset();
  message(el.passwordResetRequestMessage, "");
  if (el.passwordResetRequestDialog?.open) el.passwordResetRequestDialog.close();
}

function showLogin(error = "") {
  const hadProcessTaskOwner = Boolean(
    portalState.processTasksOwnerFingerprint || processTaskActorFingerprint(portalUser()),
  );
  neutralizeBirthdayPresentation();
  neutralizeBirthdayPresentationTheme();
  resetPersonalActionsState("");
  portalState.session = null;
  clearCandidateEvaluationState();
  portalState.personnelLearningDashboard = null;
  portalState.personnelLearningDashboardAvailable = false;
  portalState.personnelLearningProgressAssignment = null;
  neutralizeCredentialDialogsForLogin();
  document.body.classList.remove("branch-organization-account", "branch-mobile-account");
  stopBranchOrderAutosave();
  clearProcessTaskState({ resetAvailability: true, clearRequest: hadProcessTaskOwner });
  portalState.processTasksOwnerFingerprint = "";
  setPortalLoginControlsEnabled(false);
  setPortalLoginControlsEnabled(true);
  el.portalLogin.classList.remove("hidden");
  el.portalApp.classList.add("hidden");
  message(el.loginError, error, Boolean(error));
}

function applySelfServiceVisibility() {
  const canCreatePrivacyRequest = hasPortalPermission("own_privacy_requests:create");
  const canReadPrivacyRequests = hasPortalPermission("own_privacy_requests:read");
  const canReadPrivacyExports = hasPortalPermission("own_privacy_export:read");
  el.privacyRequestsCard?.classList.toggle(
    "hidden",
    !canCreatePrivacyRequest && !canReadPrivacyRequests && !canReadPrivacyExports,
  );
  el.privacyRequestForm?.classList.toggle("hidden", !canCreatePrivacyRequest);
  el.privacyRequestList?.closest(".privacy-request-history")?.classList.toggle(
    "hidden",
    !canReadPrivacyRequests && !canReadPrivacyExports,
  );
  el.privacyRequestList?.classList.toggle("hidden", !canReadPrivacyRequests);
  el.privacyRequestsRefresh?.classList.toggle("hidden", !canReadPrivacyRequests);
  el.privacyExportHint?.classList.toggle("hidden", !canReadPrivacyExports);
  if (canCreatePrivacyRequest && !canReadPrivacyRequests && el.privacyRequestsNotice) {
    el.privacyRequestsNotice.textContent = "Jede Anfrage wird nach einer Identitätsprüfung manuell bearbeitet und nachvollziehbar entschieden.";
  }
  el.vacationAccountCard?.classList.toggle(
    "hidden",
    !hasPortalPermission("own_vacation:read") || !mobileLocationDisplayAllows("requests"),
  );
  el.timeTrackingTab?.classList.toggle("hidden", !portalTabAllowed("timeTracking"));
  el.wifiAutomationCard?.classList.toggle(
    "hidden",
    !wifiTimeSuggestionsCapabilityEnabled()
      || !hasPortalPermission("own_time:read")
      || !mobileLocationDisplayAllows("time"),
  );
  el.scheduleTab?.classList.toggle("hidden", !portalTabAllowed("schedule"));
  el.timeOffTab?.classList.toggle("hidden", !portalTabAllowed("timeOff"));
  el.vacationTab?.classList.toggle("hidden", !portalTabAllowed("vacation"));
  el.historyTab?.classList.toggle("hidden", !portalTabAllowed("history"));
  el.branchOrdersTab?.classList.toggle("hidden", !portalTabAllowed("branchOrders"));
  el.branchOrderSettingsTab?.classList.toggle("hidden", !branchOrderManagementEnabled());
  el.branchVacationTab?.classList.toggle("hidden", !portalTabAllowed("branchVacation"));
  el.amuTab?.classList.toggle("hidden", !portalTabAllowed("amu"));
  el.processTasksTab?.classList.toggle("hidden", !portalTabAllowed("processTasks"));
  el.personnelLearningDashboardTab?.classList.toggle(
    "hidden",
    !portalTabAllowed("learningDashboard"),
  );
  if (!portalTabAllowed("processTasks")) {
    clearProcessTaskState({ clearRequest: true });
  }
  el.leadershipTimeOffShortcut?.classList.toggle("hidden", !portalTabAllowed("timeOff"));
  el.leadershipVacationShortcut?.classList.toggle("hidden", !portalTabAllowed("vacation"));
  el.leadershipAmuShortcut?.classList.toggle("hidden", !portalTabAllowed("amu"));
  el.leadershipProcessTasksShortcut?.classList.toggle("hidden", !portalTabAllowed("processTasks"));
  el.notificationsButton?.classList.toggle("hidden", isOrganizationAccount());
  el.emailSettingsCard?.classList.toggle("hidden", !personalEmailSettingsAvailable());
  el.mobileHomeSettingsCard?.classList.toggle("hidden", isOrganizationAccount());
  el.branchOrderSettingsCard?.classList.toggle("hidden", !branchOrderManagementEnabled());
  el.branchPortalDisplaySettingsCard?.classList.toggle("hidden", !branchPortalDisplaySettingsEnabled());
  el.passwordSettingsCard?.classList.toggle("hidden", isOrganizationAccount());
  if (!hasPortalPermission("own_time_record:read")) {
    el.timeRecordStatementsPanel?.classList.add("hidden");
  }
  renderPrivacyRequestTypes();
}

function populateVacationAccountYears() {
  if (!el.vacationAccountYear) return;
  const currentYear = new Date().getFullYear();
  const requested = Number(portalState.vacationAccountYear) || currentYear;
  const years = Array.from({ length: 7 }, (_, index) => currentYear + 1 - index);
  if (!years.includes(requested)) years.push(requested);
  years.sort((left, right) => right - left);
  el.vacationAccountYear.innerHTML = years
    .map((year) => `<option value="${year}" ${year === requested ? "selected" : ""}>${year}</option>`)
    .join("");
  portalState.vacationAccountYear = String(requested);
}

function showPortal(session) {
  const previousProcessTaskOwner = portalState.processTasksOwnerFingerprint
    || processTaskActorFingerprint(portalUser());
  const nextPersonalActionsActor = portalPersonalActionsActorKey(session?.user);
  if (portalState.personalActionsActorKey !== nextPersonalActionsActor) {
    resetPersonalActionsState(nextPersonalActionsActor);
  }
  if (birthdayPresentationActor() !== birthdayPresentationActor(session?.user)) {
    neutralizeBirthdayPresentation();
    neutralizeBirthdayPresentationTheme();
  }
  portalState.session = session;
  clearCandidateEvaluationState();
  document.body.classList.toggle(
    "branch-organization-account",
    isOrganizationAccount(session?.user) && session?.user?.accountType === "branch",
  );
  document.body.classList.toggle("portal-mobile-session", isMobileUi());
  el.portalSettingsShortcut?.classList.toggle("hidden", !isMobileUi());
  const nextProcessTaskOwner = processTaskActorFingerprint(session?.user);
  if (previousProcessTaskOwner !== nextProcessTaskOwner) {
    clearProcessTaskState({
      resetAvailability: true,
      clearRequest: Boolean(previousProcessTaskOwner),
    });
  }
  portalState.processTasksOwnerFingerprint = nextProcessTaskOwner;
  if (session.status) portalState.status = session.status;
  applyPortalBranding(session.status?.branding || session.branding || portalState.status?.branding || {});
  applyPortalCapabilities();
  setPortalLoginControlsEnabled(false);
  el.portalLogin.classList.add("hidden");
  el.portalApp.classList.remove("hidden");
  const identity = isOrganizationAccount(session.user)
    ? session.user.loginName
    : session.user.employeeNumber;
  el.portalUserName.textContent = `${identity} · ${session.user.nickname || session.user.fullName}`;
  el.portalUserRole.textContent = session.user.roleName;
  el.personalActionsButton?.classList.toggle("hidden", isOrganizationAccount(session.user));
  el.adminAppLink.classList.toggle(
    "hidden",
    isOrganizationAccount(session.user) || !session.user.permissions.includes("schedule:read"),
  );
  const planningOnly = session.user.role === "location_planner";
  el.adminAppLink.textContent = planningOnly ? "Filialplanung öffnen" : "Planung öffnen";
  if (el.leadershipDesktopLink) {
    el.leadershipDesktopLink.classList.toggle(
      "hidden",
      isOrganizationAccount(session.user) || !session.user.permissions.includes("schedule:read"),
    );
    el.leadershipDesktopLink.href = planningOnly ? "/" : "/?desktop=1";
    el.leadershipDesktopLink.querySelector("strong").textContent = planningOnly ? "Filialplanung" : "Desktop-Planung";
    el.leadershipDesktopLink.querySelector("span").textContent = planningOnly
      ? "Vollständige Planung auch am Smartphone"
      : "Vollständige Verwaltung am großen Bildschirm";
  }
  if (el.leadershipMoreDescription) {
    el.leadershipMoreDescription.textContent = planningOnly
      ? "Filialplanung und persönliche Einstellungen."
      : "Persönliche Anträge und weitere Funktionen.";
  }
  document.querySelector('[data-leadership-kind="sickness"]')?.classList.toggle("hidden", !session.user.permissions.includes("sickness:read"));
  el.passwordDialog.dataset.required = session.user.mustChangePassword ? "true" : "false";
  populateVacationAccountYears();
  applySelfServiceVisibility();
  applyMobileLeadershipLayout();
  if (session.user.mustChangePassword) setTimeout(openPasswordChangeDialog, 100);
}

async function login(event) {
  event.preventDefault();
  try {
    const result = await api("/api/portal/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ loginName: el.loginPersonnelNumber.value, password: el.loginPassword.value }),
    });
    el.loginPassword.value = "";
    showPortal(result);
    if (!result.user.mustChangePassword) {
      if (await redirectToPendingCandidateEvaluation(result.user)) return;
      await loadMobileLayout();
      chooseInitialPortalTab();
      await loadPortalData();
      await refreshBirthdayPresentationTheme();
      await claimBirthdayPresentation();
    }
  } catch (error) {
    message(el.loginError, error.message, true);
  }
}

function passwordResetTokenFromHash() {
  const match = String(window.location.hash || "").match(/^#password-reset=([A-Za-z0-9_-]{43})$/);
  return match?.[1] || "";
}

function clearPasswordResetHash() {
  if (!String(window.location.hash || "").startsWith("#password-reset=")) return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

function openPasswordResetRequest() {
  message(el.passwordResetRequestMessage, "");
  el.passwordResetEmail.value = "";
  el.passwordResetRequestDialog.showModal();
  el.passwordResetEmail.focus();
}

function openPasswordResetConfirm(token = passwordResetTokenFromHash()) {
  if (!token) return false;
  el.passwordResetToken.value = token;
  el.passwordResetNewPassword.value = "";
  el.passwordResetRepeatPassword.value = "";
  message(el.passwordResetConfirmMessage, "");
  el.passwordResetConfirmDialog.showModal();
  setPasswordResetConfirmControlsEnabled(true);
  el.passwordResetNewPassword.focus();
  return true;
}

function closePasswordResetConfirm() {
  clearPasswordResetHash();
  el.passwordResetToken.value = "";
  el.passwordResetNewPassword.value = "";
  el.passwordResetRepeatPassword.value = "";
  setPasswordResetConfirmControlsEnabled(false);
  message(el.passwordResetConfirmMessage, "");
  if (el.passwordResetConfirmDialog.open) el.passwordResetConfirmDialog.close();
}

async function requestPasswordReset(event) {
  event.preventDefault();
  if (el.passwordResetRequestSubmit.disabled) return;
  el.passwordResetRequestSubmit.disabled = true;
  message(el.passwordResetRequestMessage, "Der Rücksetzlink wird angefordert.");
  try {
    const result = await api("/api/portal/v1/auth/password-reset/request", {
      method: "POST",
      body: JSON.stringify({ email: el.passwordResetEmail.value.trim() }),
    });
    el.passwordResetEmail.value = "";
    message(
      el.passwordResetRequestMessage,
      result?.message || "Falls ein passender persönlicher Zugang vorhanden ist, wurde ein Rücksetzlink versendet.",
    );
  } catch (error) {
    message(el.passwordResetRequestMessage, error.message, true);
  } finally {
    el.passwordResetRequestSubmit.disabled = false;
  }
}

async function confirmPasswordReset(event) {
  event.preventDefault();
  if (el.passwordResetConfirmSubmit.disabled) return;
  const newPassword = el.passwordResetNewPassword.value;
  const repeatPassword = el.passwordResetRepeatPassword.value;
  if (!repeatPassword || newPassword !== repeatPassword) {
    message(el.passwordResetConfirmMessage, "Die Passwortwiederholung stimmt nicht überein.", true);
    el.passwordResetRepeatPassword.focus();
    return;
  }
  el.passwordResetConfirmSubmit.disabled = true;
  message(el.passwordResetConfirmMessage, "Das neue Passwort wird gespeichert.");
  try {
    await api("/api/portal/v1/auth/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify({
        token: el.passwordResetToken.value,
        newPassword,
        repeatPassword,
      }),
    });
    clearPasswordResetHash();
    setPasswordResetConfirmControlsEnabled(false);
    el.passwordResetConfirmDialog.close();
    showLogin();
    el.loginPassword.value = "";
    message(el.loginError, "Das Passwort wurde geändert. Bitte melde dich mit dem neuen Passwort an.");
    el.loginPersonnelNumber.focus();
  } catch (error) {
    message(el.passwordResetConfirmMessage, error.message, true);
  } finally {
    el.passwordResetConfirmSubmit.disabled = false;
  }
}

let logoutInProgress = false;

async function logout() {
  if (logoutInProgress) return;
  logoutInProgress = true;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  const originalLabel = el.logoutButton.textContent;
  const hadProcessTaskOwner = Boolean(
    portalState.processTasksOwnerFingerprint || processTaskActorFingerprint(portalUser()),
  );
  neutralizeBirthdayPresentationTheme();
  el.logoutButton.disabled = true;
  el.logoutButton.setAttribute("aria-busy", "true");
  el.logoutButton.textContent = "Abmelden…";
  message(el.portalLogoutStatus, "");
  try {
    await api("/api/portal/v1/auth/logout", {
      method: "POST",
      body: "{}",
      keepalive: true,
      signal: controller.signal,
    });
    portalState.session = null;
    stopBranchOrderAutosave();
    clearProcessTaskState({ resetAvailability: true, clearRequest: hadProcessTaskOwner });
    portalState.processTasksOwnerFingerprint = "";
    clearRememberedPortalTab();
    showLogin();
    el.loginPassword.value = "";
    el.loginPersonnelNumber.focus();
  } catch (error) {
    const detail = controller.signal.aborted
      ? "Die Abmeldung wurde nicht rechtzeitig bestätigt. Bitte erneut versuchen."
      : `Die Abmeldung konnte nicht bestätigt werden: ${error.message}`;
    message(el.portalLogoutStatus, detail, true);
    refreshBirthdayPresentationTheme();
  } finally {
    window.clearTimeout(timeout);
    logoutInProgress = false;
    el.logoutButton.disabled = false;
    el.logoutButton.removeAttribute("aria-busy");
    el.logoutButton.textContent = originalLabel;
  }
}

function setTab(tab) {
  if (portalUser() && !portalTabAllowed(tab)) tab = defaultPortalTab();
  if (tab === "timeTracking" && !timeTrackingCapabilityEnabled()) tab = defaultPortalTab();
  if (tab === "loan" && !loanCapabilityEnabled()) tab = defaultPortalTab();
  const tabChanged = portalState.activeTab !== tab;
  portalState.activeTab = tab;
  rememberPortalTab(tab);
  document.body.classList.toggle("portal-settings-active", tab === "settings" && isMobileUi());
  syncPortalTabButtons(tab);
  el.portalSettingsShortcut?.classList.toggle("active", tab === "settings");
  el.portalSettingsShortcut?.setAttribute("aria-label", tab === "settings" ? "Zur Startseite" : "Einstellungen öffnen");
  el.mobileHomeView?.classList.toggle("active", tab === "home");
  el.settingsView.classList.toggle("active", tab === "settings");
  el.scheduleView.classList.toggle("active", tab === "schedule");
  el.timeTrackingView.classList.toggle("active", tab === "timeTracking");
  el.timeOffView.classList.toggle("active", tab === "timeOff");
  el.vacationView.classList.toggle("active", tab === "vacation");
  el.historyView.classList.toggle("active", tab === "history");
  el.loanView?.classList.toggle("active", tab === "loan");
  el.branchOrdersView?.classList.toggle("active", tab === "branchOrders");
  el.branchVacationView?.classList.toggle("active", tab === "branchVacation");
  el.amuView.classList.toggle("active", tab === "amu");
  el.processTasksView?.classList.toggle("active", tab === "processTasks");
  el.personnelLearningDashboardView?.classList.toggle("active", tab === "learningDashboard");
  el.leadershipTeamView?.classList.toggle("active", tab === "leadershipTeam");
  el.leadershipApprovalsView?.classList.toggle("active", tab === "leadershipApprovals");
  el.leadershipMoreView?.classList.toggle("active", tab === "leadershipMore");
  if (tab === "timeOff") loadTimeOffRequests();
  if (tab === "settings") {
    if (hasPortalPermission("own_time:read")) loadWifiAutomation();
    if (hasPortalPermission("own_privacy_requests:read")) loadPrivacyRequests();
    if (personalEmailSettingsAvailable()) loadEmailSettings();
    if (branchOrderManagementEnabled()) Promise.allSettled([loadBranchOrderSettings(), loadBranchOrderHistory()]);
    if (branchPortalDisplaySettingsEnabled()) loadBranchPortalDisplaySettings();
    focusPortalSettingsSection();
  }
  if (tab === "timeTracking") Promise.allSettled([loadPortalHome(), loadTimeTracking(), loadTimeSummary(), loadTimeCorrections()]);
  if (tab === "vacation") {
    loadVacationRequests();
    if (hasPortalPermission("own_vacation:read")) loadVacationAccount();
  }
  if (tab === "history") Promise.allSettled([loadAbsenceHistory(), loadApprovedVacations()]);
  if (tab === "loan") loadLoanModule();
  if (tab === "branchOrders") Promise.allSettled([loadBranchOrderCatalog(), loadBranchOrderPortalHistory()]);
  if (tab === "branchVacation") loadBranchVacationOverview();
  if (tab === "amu") Promise.allSettled([loadSicknessCases(), loadAmuReports(), loadAmuSettings()]);
  if (tab === "processTasks") loadProcessTasks();
  if (tab === "learningDashboard") loadPersonnelLearningDashboard();
  if (tab === "leadershipTeam") loadLeadershipOverview();
  if (tab === "leadershipApprovals") {
    document.querySelectorAll("[data-leadership-kind]").forEach((item) => item.classList.toggle("active", item.dataset.leadershipKind === portalState.leadershipKind));
    loadLeadershipApprovals();
  }
  if (tab !== "branchOrders") portalState.branchOrderReviewVisible = false;
  renderMobileHome();
  renderBranchMobileActionBar();
  if (portalState.session) applyMobileLeadershipLayout();
  if (tabChanged && isMobileUi()) {
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      const heading = document.querySelector(".portal-view.active h1");
      heading?.setAttribute("tabindex", "-1");
      heading?.focus({ preventScroll: true });
    });
  }
}

function branchOrderStatusText(status) {
  return {
    sent: "E-Mail-Übergabe abgeschlossen",
    partial: "Teilweise übergeben",
    failed: "Zustellung technisch nicht bestätigt",
    pending: "Zustellbestätigung noch offen",
  }[status] || "Status unbekannt";
}

function branchOrderTimestampText(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value || "")
    : date.toLocaleString("de-AT", { dateStyle: "short", timeStyle: "short" });
}

function clearBranchOrderItemFields() {
  portalState.branchOrderSelection.clear();
  el.branchOrderGroups?.querySelectorAll("[data-branch-order-item]").forEach((row) => {
    const checkbox = row.querySelector("[data-branch-order-select]");
    const quantity = row.querySelector("[data-branch-order-quantity]");
    const note = row.querySelector("[data-branch-order-note]");
    if (checkbox) checkbox.checked = false;
    if (quantity) quantity.value = "1";
    if (note) note.value = "";
  });
}

function branchOrderSelection() {
  if (!(portalState.branchOrderSelection instanceof Map)) portalState.branchOrderSelection = new Map();
  return portalState.branchOrderSelection;
}

function captureBranchOrderItems() {
  const selected = [...branchOrderSelection().entries()].map(([itemId, value]) => ({ itemId, ...value }));
  const items = selected.map((entry) => {
    const quantity = Number(entry.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) return null;
    return {
      itemId: entry.itemId,
      quantity,
      note: entry.note || "",
    };
  });
  return { selected, items };
}

function syncBranchOrderItemRepresentations(itemId, { sourceRow = null } = {}) {
  const selected = branchOrderSelection().get(String(itemId));
  el.branchOrderGroups?.querySelectorAll(`[data-branch-order-item="${CSS.escape(String(itemId))}"]`).forEach((row) => {
    const checkbox = row.querySelector("[data-branch-order-select]");
    const quantity = row.querySelector("[data-branch-order-quantity]");
    const note = row.querySelector("[data-branch-order-note]");
    if (row !== sourceRow) {
      if (checkbox) checkbox.checked = Boolean(selected);
      if (quantity) quantity.value = String(selected?.quantity ?? 1);
      if (note) note.value = selected?.note || "";
    }
    row.classList.toggle("selected", Boolean(selected));
  });
}

function syncAllBranchOrderItemRepresentations() {
  for (const itemId of branchOrderSelection().keys()) syncBranchOrderItemRepresentations(itemId);
}

function renderBranchOrderDraftState() {
  const employeeNumber = String(el.branchOrderEmployee?.value || "").trim();
  const pending = portalState.branchOrderDraftPending;
  const active = portalState.branchOrderDraft;
  const hasSavedDraft = portalState.branchOrderDraftRevision > 0;
  const { selected, items } = captureBranchOrderItems();
  const validItems = selected.length > 0 && items.every(Boolean);
  const locked = portalState.branchOrderDraftLoading || portalState.branchOrderDraftSaving || portalState.branchOrderSubmitting || Boolean(pending);

  el.branchOrderGroups?.querySelectorAll("[data-branch-order-item]").forEach((row) => {
    const checkbox = row.querySelector("[data-branch-order-select]");
    const selectable = row.dataset.branchOrderReady === "1";
    if (checkbox) checkbox.disabled = locked || !selectable;
    row.querySelectorAll("[data-branch-order-quantity], [data-branch-order-note]")
      .forEach((field) => { field.disabled = locked || !checkbox?.checked || !selectable; });
  });

  if (el.branchOrderSaveDraft) {
    el.branchOrderSaveDraft.disabled = locked || !employeeNumber || !validItems || !portalState.branchOrderDraftDirty;
  }
  if (el.branchOrderSubmit) {
    el.branchOrderSubmit.disabled = locked || !employeeNumber || !validItems;
  }
  renderBranchOrderReview();
  renderBranchMobileActionBar();

  const visible = portalState.branchOrderDraftLoading || Boolean(pending) || hasSavedDraft || portalState.branchOrderDraftDirty;
  el.branchOrderDraftPanel?.classList.toggle("hidden", !visible);
  el.branchOrderContinueDraft?.classList.toggle("hidden", !pending);
  el.branchOrderDiscardDraft?.classList.toggle("hidden", !(pending || hasSavedDraft || portalState.branchOrderDraftDirty));
  if (!visible) return;

  if (portalState.branchOrderDraftLoading) {
    el.branchOrderDraftTitle.textContent = "Entwurf wird geprüft";
    el.branchOrderDraftDetail.textContent = "Gespeicherter Stand wird geladen.";
    return;
  }
  if (pending) {
    el.branchOrderDraftTitle.textContent = "Gespeicherter Entwurf vorhanden";
    const warnings = [];
    if (pending.configurationChanged) warnings.push("Bestellkatalog wurde seitdem geändert");
    if (pending.staleItemCount) warnings.push(`${pending.staleItemCount} Position(en) nicht mehr verfügbar`);
    el.branchOrderDraftDetail.textContent = `${branchOrderTimestampText(pending.updatedAt)} · ${pending.items.length} Position(en)${warnings.length ? ` · ${warnings.join(" · ")}` : ""}`;
    return;
  }
  if (portalState.branchOrderDraftDirty) {
    el.branchOrderDraftTitle.textContent = "Ungespeicherte Änderungen";
    el.branchOrderDraftDetail.textContent = hasSavedDraft && active?.updatedAt
      ? `Letzter gespeicherter Stand: ${branchOrderTimestampText(active.updatedAt)}`
      : "Dieser Stand ist noch nicht serverseitig gespeichert.";
    return;
  }
  el.branchOrderDraftTitle.textContent = "Entwurf gespeichert";
  el.branchOrderDraftDetail.textContent = active?.updatedAt
    ? `Serverseitig gespeichert: ${branchOrderTimestampText(active.updatedAt)}`
    : "Der Entwurf ist serverseitig gespeichert.";
}

function resetBranchOrderDraftState({ clearItems = true } = {}) {
  portalState.branchOrderDraft = null;
  portalState.branchOrderDraftPending = null;
  portalState.branchOrderDraftRevision = 0;
  portalState.branchOrderDraftDirty = false;
  portalState.branchOrderDraftLoading = false;
  portalState.branchOrderReviewVisible = false;
  if (clearItems) clearBranchOrderItemFields();
  renderBranchOrderDraftState();
}

function applyPendingBranchOrderDraft() {
  const draft = portalState.branchOrderDraftPending;
  if (!draft) return;
  clearBranchOrderItemFields();
  let applied = 0;
  for (const item of draft.items || []) {
    if (!item.available) continue;
    branchOrderSelection().set(String(item.itemId), {
      quantity: Number(item.quantity),
      note: item.note || "",
    });
    syncBranchOrderItemRepresentations(item.itemId);
    applied += 1;
  }
  portalState.branchOrderDraft = draft;
  portalState.branchOrderDraftPending = null;
  portalState.branchOrderDraftRevision = Number(draft.revision || 0);
  portalState.branchOrderDraftDirty = false;
  renderBranchOrderDraftState();
  message(
    el.branchOrderMessage,
    applied
      ? `Entwurf wurde fortgesetzt.${draft.staleItemCount ? ` ${draft.staleItemCount} nicht mehr verfügbare Position(en) wurden nicht übernommen.` : ""}`
      : "Der Entwurf enthält keine aktuell verfügbare Position mehr. Bitte neu erfassen oder verwerfen.",
    !applied || Boolean(draft.staleItemCount),
  );
}

async function loadBranchOrderDraft(employeeNumber = el.branchOrderEmployee?.value) {
  const normalizedEmployeeNumber = String(employeeNumber || "").trim();
  portalState.branchOrderDraftEmployeeNumber = normalizedEmployeeNumber;
  if (!normalizedEmployeeNumber) {
    resetBranchOrderDraftState();
    return;
  }
  portalState.branchOrderDraftLoading = true;
  portalState.branchOrderDraft = null;
  portalState.branchOrderDraftPending = null;
  portalState.branchOrderDraftRevision = 0;
  portalState.branchOrderDraftDirty = false;
  clearBranchOrderItemFields();
  renderBranchOrderDraftState();
  try {
    const result = await api(`/api/portal/v1/branch-orders/draft?employeeNumber=${encodeURIComponent(normalizedEmployeeNumber)}`);
    if (String(el.branchOrderEmployee?.value || "").trim() !== normalizedEmployeeNumber) return;
    portalState.branchOrderDraftPending = result.draft || null;
  } catch (error) {
    message(el.branchOrderMessage, error.message, true);
  } finally {
    if (String(el.branchOrderEmployee?.value || "").trim() === normalizedEmployeeNumber) {
      portalState.branchOrderDraftLoading = false;
      renderBranchOrderDraftState();
    }
  }
}

async function saveBranchOrderDraft({ silent = false } = {}) {
  if (portalState.branchOrderDraftSaving || portalState.branchOrderSubmitting) return false;
  const employeeNumber = String(el.branchOrderEmployee?.value || "").trim();
  const { selected, items } = captureBranchOrderItems();
  if (!employeeNumber || !selected.length || items.some((item) => item === null)) {
    if (!silent) message(el.branchOrderMessage, "Bitte mindestens eine Position mit einer ganzen Menge zwischen 1 und 100000 auswählen.", true);
    return false;
  }
  portalState.branchOrderDraftSaving = true;
  renderBranchOrderDraftState();
  try {
    const result = await api("/api/portal/v1/branch-orders/draft", {
      method: "PUT",
      body: JSON.stringify({
        employeeNumber,
        items,
        expectedRevision: portalState.branchOrderDraftRevision,
      }),
    });
    portalState.branchOrderDraft = result.draft;
    portalState.branchOrderDraftPending = null;
    portalState.branchOrderDraftRevision = Number(result.draft?.revision || 0);
    portalState.branchOrderDraftDirty = false;
    if (!silent) message(el.branchOrderMessage, "Entwurf wurde serverseitig gespeichert.");
    return true;
  } catch (error) {
    message(el.branchOrderMessage, error.message, true);
    return false;
  } finally {
    portalState.branchOrderDraftSaving = false;
    renderBranchOrderDraftState();
  }
}

async function discardBranchOrderDraft() {
  if (!confirm("Diesen gespeicherten oder begonnenen Entwurf wirklich verwerfen?")) return;
  const employeeNumber = String(el.branchOrderEmployee?.value || "").trim();
  const expectedRevision = Number(
    portalState.branchOrderDraftPending?.revision
    || portalState.branchOrderDraftRevision
    || 0,
  );
  try {
    await api("/api/portal/v1/branch-orders/draft", {
      method: "DELETE",
      body: JSON.stringify({ employeeNumber, expectedRevision }),
    });
    resetBranchOrderDraftState();
    message(el.branchOrderMessage, "Entwurf wurde verworfen.");
  } catch (error) {
    message(el.branchOrderMessage, error.message, true);
  }
}

function renderBranchOrderCatalog() {
  const catalog = portalState.branchOrderCatalog;
  if (!catalog || !el.branchOrderGroups) return;
  el.branchOrderWeek.textContent = `KW ${catalog.calendarWeek} · Woche ab ${dateText(catalog.weekStart)}`;
  const selfSubmission = catalog.submissionMode === "self";
  const employees = Array.isArray(catalog.employees) ? catalog.employees : [];
  const selectedEmployee = selfSubmission
    ? String(employees[0]?.employeeNumber || "")
    : el.branchOrderEmployee.value;
  el.branchOrderEmployee.innerHTML = [
    selfSubmission ? "" : '<option value="">Bitte Teammitglied auswählen</option>',
    ...employees.map((employee) => (
      `<option value="${esc(employee.employeeNumber)}">${esc(employee.fullName)} · MA-Nr. ${esc(employee.employeeNumber)}</option>`
    )),
  ].join("");
  if (employees.some((employee) => employee.employeeNumber === selectedEmployee)) {
    el.branchOrderEmployee.value = selectedEmployee;
  }
  el.branchOrderEmployee.disabled = selfSubmission || !employees.length;
  const mobileOrdering = isBranchMobileAccount();
  const groups = Array.isArray(catalog.groups) ? catalog.groups : [];
  el.branchOrderGroups.innerHTML = groups.length ? groups.map((group) => {
    const items = Array.isArray(group.items) ? group.items : [];
    return `<details class="branch-order-group" data-branch-order-group="${esc(group.id)}" ${mobileOrdering ? "" : "open"}>
      <summary class="branch-order-group-heading"><div><h2>${esc(group.title)}</h2>${group.hint ? `<p>${esc(group.hint)}</p>` : ""}</div><span class="branch-order-group-toggle" aria-hidden="true">+</span></summary>
      <div class="branch-order-item-list">${items.length ? items.map((item) => `<article class="branch-order-item" data-branch-order-item="${esc(item.id)}" data-branch-order-ready="${item.orderReady === false ? "0" : "1"}">
        <label class="branch-order-item-select"><span><strong>${esc(item.title)}</strong>${item.orderReady === false ? "<small>Diese Position ist derzeit nicht bestellbar.</small>" : ""}</span><input data-branch-order-select type="checkbox" ${item.orderReady === false ? "disabled" : ""} /></label>
        <div class="branch-order-line-fields"><label><span>Menge</span><input data-branch-order-quantity type="number" min="1" max="100000" step="1" inputmode="numeric" value="1" disabled /></label><span class="branch-order-unit">${esc(item.unit)}</span><label class="branch-order-note-field"><span>Bemerkung</span><input data-branch-order-note maxlength="500" disabled /></label></div>
      </article>`).join("") : '<p class="empty-state">Diese Warengruppe enthält noch keine Positionen.</p>'}</div>
    </details>`;
  }).join("") : '<p class="empty-state">Für diesen Standort sind noch keine Bestellpositionen eingerichtet.</p>';
  syncAllBranchOrderItemRepresentations();
  renderBranchOrderDraftState();
}

async function loadBranchOrderCatalog() {
  if (!branchOrderCapabilityEnabled()) return;
  try {
    const catalog = await api("/api/portal/v1/branch-orders/catalog");
    portalState.branchOrderCatalog = catalog;
    configureBranchOrderAutosave();
    renderBranchOrderCatalog();
    await loadBranchOrderDraft(el.branchOrderEmployee?.value);
  } catch (error) {
    el.branchOrderGroups.innerHTML = `<p class="empty-state">${esc(error.message)}</p>`;
    message(el.branchOrderMessage, error.message, true);
  }
}

function branchOrderPdfHref(order, { download = false } = {}) {
  const id = String(order?.id || "").trim();
  if (!id) return "";
  return `/api/portal/v1/branch-orders/${encodeURIComponent(id)}/pdf${download ? "?download=1" : ""}`;
}

function renderBranchOrderPortalHistory() {
  if (!el.branchOrderPortalHistoryList) return;
  const orders = portalState.branchOrderPortalHistory || [];
  el.branchOrderPortalHistoryList.innerHTML = orders.length ? orders.map((order) => {
    const openPdf = branchOrderPdfHref(order);
    const downloadPdf = branchOrderPdfHref(order, { download: true });
    return `<article class="branch-order-history-entry">
      <div><strong>KW ${Number(order.calendarWeek)} · ${esc(order.selectedEmployeeName)} · MA-Nr. ${esc(order.selectedEmployeeNumber)}</strong><small>${esc(branchOrderTimestampText(order.submittedAt))} · ${esc(branchOrderStatusText(order.status))}</small></div>
      <ul>${(order.lines || []).map((line) => `<li>${esc(line.groupTitle)} · ${esc(line.itemTitle)}: ${esc(Number(line.quantity).toLocaleString("de-AT", { maximumFractionDigits: 3 }))} ${esc(line.unit)}${line.note ? ` · ${esc(line.note)}` : ""}</li>`).join("")}</ul>
      <nav class="branch-order-history-actions"><a class="text-button" href="${esc(openPdf)}" target="_blank" rel="noopener">PDF öffnen</a><a class="text-button" href="${esc(downloadPdf)}">Herunterladen</a></nav>
    </article>`;
  }).join("") : '<p class="empty-state">Für diesen Standort wurden noch keine Bestellungen gespeichert.</p>';
}

async function loadBranchOrderPortalHistory() {
  if (!branchOrderCapabilityEnabled()) return;
  try {
    const result = await api("/api/portal/v1/branch-orders/history?limit=50");
    portalState.branchOrderPortalHistory = result.orders || [];
    renderBranchOrderPortalHistory();
  } catch (error) {
    el.branchOrderPortalHistoryList.innerHTML = `<p class="empty-state">${esc(error.message)}</p>`;
  }
}

async function submitBranchOrder(event) {
  event?.preventDefault?.();
  if (portalState.branchOrderSubmitting) return;
  const employeeNumber = String(el.branchOrderEmployee.value || "").trim();
  const { selected, items } = captureBranchOrderItems();
  if (!employeeNumber) {
    message(el.branchOrderMessage, "Bitte das Teammitglied mit Name und Personalnummer auswählen.", true);
    return;
  }
  if (!selected.length) {
    message(el.branchOrderMessage, "Bitte mindestens eine Bestellposition auswählen.", true);
    return;
  }
  if (items.some((item) => item === null)) {
    message(el.branchOrderMessage, "Die Bestellmenge muss eine ganze Zahl zwischen 1 und 100000 sein.", true);
    return;
  }
  portalState.branchOrderSubmitting = true;
  renderBranchOrderDraftState();
  message(el.branchOrderMessage, "");
  try {
    const result = await api("/api/portal/v1/branch-orders", {
      method: "POST",
      body: JSON.stringify({
        employeeNumber,
        items,
        draftRevision: portalState.branchOrderDraftRevision,
      }),
    });
    portalState.branchOrderDraft = null;
    portalState.branchOrderDraftPending = null;
    portalState.branchOrderDraftRevision = 0;
    portalState.branchOrderDraftDirty = false;
    portalState.branchOrderReviewVisible = false;
    await Promise.all([loadBranchOrderCatalog(), loadBranchOrderPortalHistory()]);
    message(
      el.branchOrderMessage,
      result.order?.status === "sent"
        ? "Bestellung wurde gespeichert und an die hinterlegten Stellen übergeben."
        : "Bestellung wurde gespeichert; die E-Mail-Übergabe ist im Bestellverlauf als fehlgeschlagen dokumentiert.",
      result.order?.status !== "sent",
    );
  } catch (error) {
    message(el.branchOrderMessage, error.message, true);
  } finally {
    portalState.branchOrderSubmitting = false;
    renderBranchOrderDraftState();
  }
}

function branchOrderGroupForItem(itemId) {
  return (portalState.branchOrderCatalog?.groups || [])
    .find((group) => (group.items || []).some((item) => item.id === itemId)) || null;
}

function branchOrderInputValid() {
  const employeeNumber = String(el.branchOrderEmployee?.value || "").trim();
  const { selected, items } = captureBranchOrderItems();
  return Boolean(employeeNumber && selected.length && items.every(Boolean));
}

function setBranchOrderReviewVisible(visible) {
  if (visible && !branchOrderInputValid()) {
    message(el.branchOrderMessage, "Bitte Teammitglied und mindestens eine Position mit ganzer Menge auswählen.", true);
    return;
  }
  portalState.branchOrderReviewVisible = Boolean(visible);
  renderBranchOrderDraftState();
}

function renderBranchOrderReview() {
  if (!el.branchOrderReview) return;
  const visible = portalState.activeTab === "branchOrders" && portalState.branchOrderReviewVisible;
  el.branchOrderReview.classList.toggle("hidden", !visible);
  el.branchOrderGroups?.classList.toggle("hidden", visible);
  el.branchOrderEmployee?.closest("label")?.classList.toggle("hidden", visible);
  el.branchOrderDraftPanel?.classList.toggle("hidden", visible || el.branchOrderDraftPanel?.classList.contains("hidden"));
  el.branchOrderForm?.classList.toggle("branch-order-reviewing", visible);
  if (!visible || !el.branchOrderReviewList) return;
  const employee = (portalState.branchOrderCatalog?.employees || [])
    .find((entry) => entry.employeeNumber === String(el.branchOrderEmployee?.value || ""));
  const { items } = captureBranchOrderItems();
  el.branchOrderReviewList.innerHTML = `<div class="branch-order-review-person"><strong>${esc(employee?.fullName || "Teammitglied")}</strong><small>MA-Nr. ${esc(employee?.employeeNumber || "")}</small></div><ul>${items.filter(Boolean).map((item) => {
    const group = branchOrderGroupForItem(item.itemId);
    const catalogItem = (group?.items || []).find((entry) => entry.id === item.itemId);
    return `<li><div><strong>${esc(catalogItem?.title || item.itemId)}</strong><small>${esc(group?.title || "Filialbestellung")}</small></div><span>${esc(String(item.quantity))} ${esc(catalogItem?.unit || "")}${item.note ? `<small>${esc(item.note)}</small>` : ""}</span></li>`;
  }).join("")}</ul>`;
}

function stopBranchOrderAutosave() {
  if (portalState.branchOrderAutosaveTimer) clearInterval(portalState.branchOrderAutosaveTimer);
  portalState.branchOrderAutosaveTimer = null;
}

function configureBranchOrderAutosave() {
  stopBranchOrderAutosave();
  const settings = portalState.branchOrderCatalog?.portalSettings || portalState.branchPortalDisplaySettings;
  if (!settings?.orderAutosaveEnabled) return;
  const minutes = Number(settings.orderAutosaveMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 99) return;
  portalState.branchOrderAutosaveTimer = setInterval(() => {
    if (portalState.activeTab !== "branchOrders" || !portalState.branchOrderDraftDirty) return;
    saveBranchOrderDraft({ silent: true });
  }, minutes * 60 * 1000);
}

function mobileHomeTilesForCurrentAccount() {
  const user = portalUser();
  if (isOrganizationAccount(user)) {
    return ["schedule", "learningDashboard", "branchOrders", "loan", "branchVacation"]
      .map((tab) => mobileHomeTileCatalog.find((tile) => tile.tab === tab)
        || { id: tab, tab, label: tab === "schedule" ? "Dienstplan" : tab, description: "" })
      .filter((tile) => portalTabAllowed(tile.tab, user))
      .map((tile) => ({ ...tile, rgb: [...(mobileHomeDefaultColors[tile.id] || mobileHomeDefaultColors.schedule)] }));
  }
  const layout = normalizedMobilePortalHome(portalState.uiPreferences?.mobilePortalHome);
  const allowed = new Set(availableMobileHomeTiles(user).map((tile) => tile.id));
  return layout.order
    .filter((id) => allowed.has(id))
    .map((id) => {
      const tile = mobileHomeTileById.get(id);
      return tile ? { ...tile, rgb: normalizedRgb(layout.colors[id], mobileHomeDefaultColors[id]) } : null;
    })
    .filter(Boolean);
}

function renderMobileHome() {
  if (!el.mobileHomeTiles) return;
  const visible = isMobileUi() && portalState.activeTab === "home";
  el.mobileHomeTiles.classList.toggle("hidden", !visible);
  if (!visible) return;
  const tiles = mobileHomeTilesForCurrentAccount();
  if (!tiles.length) {
    el.mobileHomeTiles.innerHTML = '<p class="empty-state">Für dieses Konto ist derzeit kein Portalbereich freigeschaltet.</p>';
    return;
  }
  el.mobileHomeTiles.innerHTML = tiles.map((tile) => `
    <button type="button" data-mobile-home-tab="${esc(tile.tab)}" style="--mobile-home-tile-color:rgb(${tile.rgb.join(",")})">
      <span class="mobile-home-tile-accent" aria-hidden="true"></span>
      <span><strong>${esc(tile.label)}</strong><small>${esc(tile.description)}</small></span>
      <b aria-hidden="true">›</b>
    </button>
  `).join("");
}

function renderBranchMobileActionBar() {
  if (!el.branchMobileActionBar) return;
  const visible = isBranchMobileAccount() && portalState.activeTab === "branchOrders";
  el.branchMobileActionBar.classList.toggle("hidden", !visible);
  if (!visible) return;
  const ordering = portalState.activeTab === "branchOrders";
  const reviewing = ordering && portalState.branchOrderReviewVisible;
  const valid = ordering && branchOrderInputValid();
  if (el.branchMobileBack) el.branchMobileBack.disabled = portalState.branchOrderDraftSaving || portalState.branchOrderSubmitting;
  el.branchMobileReview?.classList.toggle("hidden", !ordering || reviewing);
  el.branchMobileSubmit?.classList.toggle("hidden", !ordering || !reviewing);
  el.branchMobileSave?.classList.toggle("hidden", !ordering);
  if (el.branchMobileReview) el.branchMobileReview.disabled = !valid || portalState.branchOrderDraftLoading || portalState.branchOrderDraftSaving || portalState.branchOrderSubmitting;
  if (el.branchMobileSubmit) el.branchMobileSubmit.disabled = !valid || portalState.branchOrderDraftLoading || portalState.branchOrderDraftSaving || portalState.branchOrderSubmitting;
  if (el.branchMobileSave) el.branchMobileSave.disabled = !valid || !portalState.branchOrderDraftDirty || portalState.branchOrderDraftLoading || portalState.branchOrderDraftSaving || portalState.branchOrderSubmitting;
}

function branchMobileBack() {
  if (!isBranchMobileAccount()) return;
  if (portalState.activeTab === "branchOrders" && portalState.branchOrderReviewVisible) {
    setBranchOrderReviewVisible(false);
    return;
  }
  setTab("home");
}

function branchOrderClientId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

const branchOrderDeliveryModes = new Set(["message", "message_pdf", "pdf_only"]);
const branchOrderSettingsCollator = new Intl.Collator("de-AT", {
  numeric: true,
  sensitivity: "base",
});

function normalizedBranchOrderDeliveryMode(value) {
  return branchOrderDeliveryModes.has(value) ? value : "message";
}

function branchOrderItemsAlphabetically(items = []) {
  return items.slice().sort((left, right) => {
    const compared = branchOrderSettingsCollator.compare(
      String(left?.title || "Neue Position"),
      String(right?.title || "Neue Position"),
    );
    if (compared) return compared;
    return branchOrderSettingsCollator.compare(String(left?.id || ""), String(right?.id || ""));
  });
}

function sortBranchOrderGroupItemIdsAlphabetically(group, items = []) {
  if (!group || !Array.isArray(group.itemIds)) return;
  const catalog = new Map(items.map((item) => [item.id, item]));
  group.itemIds = group.itemIds
    .map((id, index) => ({ id, index, item: catalog.get(id) || null }))
    .sort((left, right) => {
      if (!left.item || !right.item) {
        if (!left.item && !right.item) return left.index - right.index;
        return left.item ? -1 : 1;
      }
      const compared = branchOrderSettingsCollator.compare(
        String(left.item.title || "Neue Position"),
        String(right.item.title || "Neue Position"),
      );
      return compared || left.index - right.index;
    })
    .map((entry) => entry.id);
}

const branchOrderSettingsUnitColumns = Object.freeze([
  { key: "position", label: "Position" },
  { key: "title", label: "Maßeinheit" },
]);

function normalizedBranchOrderSettingsUnitSort() {
  const requested = portalState.branchOrderSettingsUnitSort || {};
  const key = branchOrderSettingsUnitColumns.some((column) => column.key === requested.key)
    ? requested.key
    : "position";
  return { key, direction: requested.direction === "desc" ? "desc" : "asc" };
}

function sortedBranchOrderSettingsUnits(units = []) {
  const sort = normalizedBranchOrderSettingsUnitSort();
  const direction = sort.direction === "desc" ? -1 : 1;
  const positions = new Map(units.map((unit, index) => [unit.id, index + 1]));
  return units.slice().sort((left, right) => {
    const compared = sort.key === "position"
      ? (positions.get(left.id) || 0) - (positions.get(right.id) || 0)
      : branchOrderSettingsCollator.compare(String(left.title || ""), String(right.title || ""));
    if (compared) return compared * direction;
    return ((positions.get(left.id) || 0) - (positions.get(right.id) || 0)) * direction;
  });
}

function branchOrderSettingsUnitHeader() {
  const sort = normalizedBranchOrderSettingsUnitSort();
  return `<tr>${branchOrderSettingsUnitColumns.map((column) => {
    const active = sort.key === column.key;
    const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
    const indicator = active ? `<span aria-hidden="true">${sort.direction === "asc" ? "↑" : "↓"}</span>` : "";
    return `<th aria-sort="${ariaSort}"><button class="branch-order-unit-sort-button" type="button" data-branch-order-sort-units="${column.key}">${column.label}${indicator}</button></th>`;
  }).join("")}<th><span class="branch-order-visually-hidden">Aktionen</span></th></tr>`;
}

function clonedBranchOrderConfiguration(configuration = {}) {
  return {
    recipients: (configuration.recipients || []).map((recipient) => ({
      id: recipient.id,
      email: recipient.email || "",
      ccEmail: recipient.ccEmail || "",
      primaryDeliveryMode: normalizedBranchOrderDeliveryMode(recipient.primaryDeliveryMode),
      ccDeliveryMode: normalizedBranchOrderDeliveryMode(recipient.ccDeliveryMode),
      replyToEmail: recipient.replyToEmail || "",
      subjectTemplate: recipient.subjectTemplate || "",
      bodyTemplate: recipient.bodyTemplate || "",
    })),
    units: (configuration.units || []).map((unit) => ({
      id: typeof unit === "string" ? branchOrderClientId("unit") : unit.id,
      title: typeof unit === "string" ? unit : unit.title || "Stück",
    })),
    items: (configuration.items || []).map((item) => ({
      id: item.id,
      recipientId: item.recipientId || "",
      unitId: item.unitId || "",
      title: item.title || "",
    })),
    groups: (configuration.groups || []).map((group) => ({
      id: group.id,
      title: group.title || "",
      hint: group.hint || "",
      itemIds: [...(group.itemIds || (group.items || []).map((item) => item.id))],
    })),
  };
}

function renderBranchOrderSettings() {
  const settings = portalState.branchOrderSettings;
  const draft = portalState.branchOrderSettingsDraft;
  if (!settings || !draft || !el.branchOrderSettingsWorkspace) return;
  const emailDelivery = settings.emailDelivery || {};
  el.branchOrderSettingsSummary.textContent = emailDelivery.available && emailDelivery.attachmentsAvailable
    ? "E-Mail-Übergabe einschließlich Bestell-PDF ist technisch freigeschaltet."
    : emailDelivery.available
      ? "E-Mail-Text ist freigeschaltet; Bestell-PDFs benötigen zusätzlich einen SMTP-Versand."
    : "E-Mail-Übergabe ist noch nicht technisch freigeschaltet.";
  const recipientOptions = (selected) => [
    `<option value="" ${selected ? "" : "selected"}>Kein E-Mail-Ziel</option>`,
    ...draft.recipients.map((recipient) => (
      `<option value="${esc(recipient.id)}" ${recipient.id === selected ? "selected" : ""}>${esc(recipient.email || "Neue Zieladresse")}</option>`
    )),
  ].join("");
  const deliveryModeOptions = (selected) => [
    ["message", "Nur E-Mail-Text"],
    ["message_pdf", "E-Mail-Text + Bestell-PDF"],
    ["pdf_only", "Nur Bestell-PDF"],
  ].map(([value, label]) => (
    `<option value="${value}" ${value === normalizedBranchOrderDeliveryMode(selected) ? "selected" : ""} ${value !== "message" && !emailDelivery.attachmentsAvailable ? "disabled" : ""}>${label}</option>`
  )).join("");
  const recipientRows = draft.recipients.length ? draft.recipients.map((recipient) => `<article class="branch-order-recipient-editor" data-branch-order-recipient="${esc(recipient.id)}">
    <div class="branch-order-editor-heading"><strong>E-Mail-Ziel</strong><button class="text-button danger-button" type="button" data-branch-order-remove-recipient="${esc(recipient.id)}">Entfernen</button></div>
    <div class="branch-order-editor-grid"><label><span>Primäre Zieladresse</span><input type="email" data-branch-order-settings-field="recipient-email" value="${esc(recipient.email)}" maxlength="320" inputmode="email" autocomplete="email" /></label><label><span>Versand an Hauptadresse</span><select data-branch-order-settings-field="recipient-primary-delivery-mode">${deliveryModeOptions(recipient.primaryDeliveryMode)}</select></label><label><span>CC-Adresse (optional)</span><input type="email" data-branch-order-settings-field="recipient-cc-email" value="${esc(recipient.ccEmail)}" maxlength="320" inputmode="email" autocomplete="email" /><small>Die CC-Kopie wird wegen der unabhängigen Versandart separat zugestellt.</small></label><label><span>Versand an CC-Adresse</span><select data-branch-order-settings-field="recipient-cc-delivery-mode">${deliveryModeOptions(recipient.ccDeliveryMode)}</select></label><label><span>Antwortadresse</span><input type="email" data-branch-order-settings-field="recipient-reply-to" value="${esc(recipient.replyToEmail)}" maxlength="320" inputmode="email" autocomplete="email" /><small>Wird im verpflichtenden Antwort-Hinweis genannt.</small></label></div>
    <label><span>E-Mail-Betreff</span><input data-branch-order-settings-field="recipient-subject" value="${esc(recipient.subjectTemplate)}" maxlength="180" /><small>Platzhalter: {{locationName}}, {{calendarWeek}}, {{employeeName}}, {{employeeNickname}}, {{employeeNumber}}, {{weekStart}}, {{submittedAt}}, {{items}}.</small></label>
    <label><span>E-Mail-Text</span><textarea data-branch-order-settings-field="recipient-body" rows="6" maxlength="8000">${esc(recipient.bodyTemplate)}</textarea><small>Der Hinweis zur nicht möglichen Antwort und die Antwortadresse werden automatisch ergänzt.</small></label>
  </article>`).join("") : '<p class="empty-state">Noch kein E-Mail-Ziel angelegt.</p>';
  const unitOptions = (selected) => draft.units.map((unit) => (
    `<option value="${esc(unit.id)}" ${unit.id === selected ? "selected" : ""}>${esc(unit.title || "Neue Einheit")}</option>`
  )).join("");
  const unitPositions = new Map(draft.units.map((unit, index) => [unit.id, index + 1]));
  const unitRows = draft.units.length ? sortedBranchOrderSettingsUnits(draft.units).map((unit) => {
    const index = draft.units.findIndex((entry) => entry.id === unit.id);
    const title = unit.title || "Neue Einheit";
    const editing = portalState.branchOrderSettingsUnitEditingId === unit.id;
    return `<tr class="branch-order-unit-row${editing ? " is-editing" : ""}" data-branch-order-unit-row="${esc(unit.id)}"><td>${unitPositions.get(unit.id) || 0}</td><td><strong>${esc(title)}</strong></td><td><div class="branch-order-unit-actions"><button class="branch-order-unit-order-button" type="button" data-branch-order-move-unit="${esc(unit.id)}" data-direction="-1" aria-label="${esc(`${title} nach oben verschieben`)}" ${index ? "" : "disabled"}>↑</button><button class="branch-order-unit-order-button" type="button" data-branch-order-move-unit="${esc(unit.id)}" data-direction="1" aria-label="${esc(`${title} nach unten verschieben`)}" ${index < draft.units.length - 1 ? "" : "disabled"}>↓</button><button class="branch-order-table-action" type="button" data-branch-order-edit-unit="${esc(unit.id)}">Bearbeiten</button><button class="branch-order-table-action danger" type="button" data-branch-order-remove-unit="${esc(unit.id)}">Löschen</button></div></td></tr>${editing ? `<tr class="branch-order-unit-editor-row"><td colspan="3"><div class="branch-order-unit-editor" data-branch-order-unit-editor="${esc(unit.id)}"><label><span>Maßeinheit</span><input data-branch-order-settings-field="unit-title" value="${esc(unit.title)}" maxlength="40" /></label></div></td></tr>` : ""}`;
  }).join("") : '<tr><td colspan="3" class="branch-order-unit-empty">Noch keine Maßeinheit angelegt.</td></tr>';
  const itemRows = draft.items.length ? draft.items.map((item, index) => `<article class="branch-order-catalog-item" data-branch-order-catalog-item="${esc(item.id)}"><div class="branch-order-editor-heading"><strong>Position ${index + 1}</strong><button class="text-button danger-button" type="button" data-branch-order-remove-catalog-item="${esc(item.id)}">Entfernen</button></div><div class="branch-order-editor-grid"><label><span>Bezeichnung</span><input data-branch-order-settings-field="catalog-item-title" value="${esc(item.title)}" maxlength="180" /></label><label><span>Einheit</span><select data-branch-order-settings-field="catalog-item-unit">${unitOptions(item.unitId)}</select></label><label><span>E-Mail-Ziel</span><select data-branch-order-settings-field="catalog-item-recipient">${recipientOptions(item.recipientId)}</select></label></div></article>`).join("") : '<p class="empty-state">Noch keine Position angelegt.</p>';
  const assignableItems = (group) => branchOrderItemsAlphabetically(
    draft.items.filter((item) => !group.itemIds.includes(item.id)),
  );
  const groupRows = draft.groups.length ? draft.groups.map((group, groupIndex) => {
    const memberships = group.itemIds.map((itemId) => branchOrderDraftItem(itemId)).filter(Boolean);
    const available = assignableItems(group);
    return `<article class="branch-order-group-editor" data-branch-order-group-editor="${esc(group.id)}"><div class="branch-order-editor-heading"><strong>Anzeigegruppe</strong><div class="branch-order-sort-actions"><button class="branch-order-table-action" type="button" data-branch-order-sort-group-items="${esc(group.id)}" aria-label="Positionen in ${esc(group.title || "dieser Anzeigegruppe")} alphanumerisch sortieren">A–Z sortieren</button><button class="text-button" type="button" data-branch-order-move-group="${esc(group.id)}" data-direction="-1" ${groupIndex ? "" : "disabled"}>↑</button><button class="text-button" type="button" data-branch-order-move-group="${esc(group.id)}" data-direction="1" ${groupIndex < draft.groups.length - 1 ? "" : "disabled"}>↓</button><button class="text-button danger-button" type="button" data-branch-order-remove-group="${esc(group.id)}">Entfernen</button></div></div><label><span>Bezeichnung</span><input data-branch-order-settings-field="group-title" value="${esc(group.title)}" maxlength="120" /></label><label><span>Hinweis im Bestellformular</span><input data-branch-order-settings-field="group-hint" value="${esc(group.hint)}" maxlength="400" /></label><div class="branch-order-settings-items">${memberships.length ? memberships.map((item, index) => `<div class="branch-order-settings-item"><strong>${esc(item.title || "Neue Position")}</strong><span>${esc(branchOrderDraftUnit(item.unitId)?.title || "")}</span><div class="branch-order-sort-actions"><button class="text-button" type="button" data-branch-order-move-group-item="${esc(group.id)}" data-item-id="${esc(item.id)}" data-direction="-1" ${index ? "" : "disabled"}>↑</button><button class="text-button" type="button" data-branch-order-move-group-item="${esc(group.id)}" data-item-id="${esc(item.id)}" data-direction="1" ${index < memberships.length - 1 ? "" : "disabled"}>↓</button><button class="text-button danger-button" type="button" data-branch-order-remove-group-item="${esc(group.id)}" data-item-id="${esc(item.id)}">Entfernen</button></div></div>`).join("") : '<p class="empty-state">Noch keine Position zugeordnet.</p>'}</div>${available.length ? `<div class="branch-order-group-add"><select data-branch-order-group-item-select="${esc(group.id)}"><option value="">Position zuordnen</option>${available.map((item) => `<option value="${esc(item.id)}">${esc(item.title || "Neue Position")}</option>`).join("")}</select><button class="text-button" type="button" data-branch-order-add-group-item="${esc(group.id)}">+ Zuordnen</button></div>` : ""}</article>`;
  }).join("") : '<p class="empty-state">Noch keine Anzeigegruppe angelegt.</p>';
  el.branchOrderSettingsWorkspace.innerHTML = `<section class="branch-order-settings-section"><div class="branch-order-editor-heading"><div><h2>E-Mail-Ziele</h2><p>Jedes Ziel erhält Haupt- und optionale CC-Adresse, Versandarten, Betreff, Text und Antwortadresse.</p></div><button class="text-button" type="button" data-branch-order-add-recipient>+ E-Mail-Ziel</button></div>${recipientRows}</section><section class="branch-order-settings-section"><div class="branch-order-editor-heading"><div><h2>Maßeinheiten</h2><p>Einheiten können standortbezogen angelegt, umbenannt, sortiert und entfernt werden.</p></div></div><div class="branch-order-unit-create"><label><span>Neue Maßeinheit</span><input data-branch-order-new-unit-title maxlength="40" placeholder="Bezeichnung eingeben" autocomplete="off" /></label><button class="text-button" type="button" data-branch-order-add-unit>Hinzufügen</button></div><div class="branch-order-unit-table-wrap"><table class="branch-order-unit-table"><thead>${branchOrderSettingsUnitHeader()}</thead><tbody>${unitRows}</tbody></table></div></section><section class="branch-order-settings-section"><div class="branch-order-editor-heading"><div><h2>Positionskatalog</h2><p>Eine Position wird einmal gepflegt und kann mehreren Anzeigegruppen zugeordnet werden.</p></div><button class="text-button" type="button" data-branch-order-add-catalog-item>+ Position</button></div>${itemRows}</section><section class="branch-order-settings-section"><div class="branch-order-editor-heading"><div><h2>Anzeigegruppen</h2><p>Reihenfolge und Zuordnung steuern die Bestellansicht, nicht die E-Mail-Zustellung.</p></div><button class="text-button" type="button" data-branch-order-add-group>+ Anzeigegruppe</button></div>${groupRows}</section>`;
}

function branchOrderDraftRecipient(id) {
  return portalState.branchOrderSettingsDraft?.recipients.find((recipient) => recipient.id === id) || null;
}

function branchOrderDraftGroup(id) {
  return portalState.branchOrderSettingsDraft?.groups.find((group) => group.id === id) || null;
}

function branchOrderDraftUnit(id) {
  return portalState.branchOrderSettingsDraft?.units.find((unit) => unit.id === id) || null;
}

function branchOrderDraftItem(id) {
  return portalState.branchOrderSettingsDraft?.items.find((item) => item.id === id) || null;
}

function revealBranchOrderUnitEditor(id) {
  const input = el.branchOrderSettingsWorkspace?.querySelector(
    `[data-branch-order-unit-editor="${CSS.escape(id)}"] input`,
  );
  if (!input) return;
  input.focus();
  if (typeof input.select === "function") input.select();
}

async function loadBranchOrderSettings() {
  if (!branchOrderManagementEnabled() || portalState.branchOrderSettingsLoading) return;
  portalState.branchOrderSettingsLoading = true;
  try {
    const settings = await api("/api/portal/v1/branch-orders/settings");
    portalState.branchOrderSettings = settings;
    portalState.branchOrderSettingsDraft = clonedBranchOrderConfiguration(settings.configuration);
    portalState.branchOrderSettingsUnitEditingId = "";
    renderBranchOrderSettings();
    message(el.branchOrderSettingsMessage, "");
  } catch (error) {
    message(el.branchOrderSettingsMessage, error.message, true);
  } finally {
    portalState.branchOrderSettingsLoading = false;
  }
}

function renderBranchOrderHistory() {
  if (!el.branchOrderHistoryList) return;
  const orders = portalState.branchOrderHistory || [];
  el.branchOrderHistoryList.innerHTML = orders.length ? orders.map((order) => {
    const openPdf = branchOrderPdfHref(order);
    const downloadPdf = branchOrderPdfHref(order, { download: true });
    return `<article class="branch-order-history-entry">
    <div><strong>KW ${Number(order.calendarWeek)} · ${esc(order.selectedEmployeeName)} · MA-Nr. ${esc(order.selectedEmployeeNumber)}</strong><small>${esc(branchOrderTimestampText(order.submittedAt))} · ${esc(branchOrderStatusText(order.status))}</small></div>
    <small>Erfasst über ${esc(order.submittedByLogin || "Filialkonto")}${order.deliveries?.[0]?.senderEmail ? ` · Absender ${esc(order.deliveries[0].senderEmail)}` : ""}</small>
    <ul>${(order.lines || []).map((line) => `<li>${esc(line.groupTitle)} · ${esc(line.itemTitle)}: ${esc(Number(line.quantity).toLocaleString("de-AT", { maximumFractionDigits: 3 }))} ${esc(line.unit)}${line.note ? ` · ${esc(line.note)}` : ""}</li>`).join("")}</ul>
    <nav class="branch-order-history-actions"><a class="text-button" href="${esc(openPdf)}" target="_blank" rel="noopener">PDF öffnen</a><a class="text-button" href="${esc(downloadPdf)}">Herunterladen</a></nav>
  </article>`;
  }).join("") : '<p class="empty-state">Für diesen Standort wurden noch keine Bestellungen gespeichert.</p>';
}

async function loadBranchOrderHistory() {
  if (!branchOrderManagementEnabled()) return;
  try {
    const result = await api("/api/portal/v1/branch-orders/history?limit=50");
    portalState.branchOrderHistory = result.orders || [];
    renderBranchOrderHistory();
  } catch (error) {
    el.branchOrderHistoryList.innerHTML = `<p class="empty-state">${esc(error.message)}</p>`;
  }
}

async function saveBranchOrderSettings() {
  const draft = captureBranchOrderSettingsDraft();
  if (!branchOrderManagementEnabled() || !draft) return;
  const requiresPdfDelivery = draft.recipients.some((recipient) => (
    recipient.primaryDeliveryMode !== "message"
    || (recipient.ccEmail && recipient.ccDeliveryMode !== "message")
  ));
  if (requiresPdfDelivery && portalState.branchOrderSettings?.emailDelivery?.attachmentsAvailable !== true) {
    message(
      el.branchOrderSettingsMessage,
      "Bestell-PDFs können erst nach Freischaltung eines SMTP-Versands aktiviert werden.",
      true,
    );
    return;
  }
  el.saveBranchOrderSettings.disabled = true;
  message(el.branchOrderSettingsMessage, "");
  try {
    const result = await api("/api/portal/v1/branch-orders/settings", {
      method: "PUT",
      body: JSON.stringify({
        locationId: portalState.branchOrderSettings?.locationId || portalUser()?.homeLocationId || "",
        configuration: draft,
      }),
    });
    portalState.branchOrderSettings = result;
    portalState.branchOrderSettingsDraft = clonedBranchOrderConfiguration(result.configuration);
    portalState.branchOrderSettingsUnitEditingId = "";
    renderBranchOrderSettings();
    message(el.branchOrderSettingsMessage, "Bestellkonfiguration wurde gespeichert.");
  } catch (error) {
    message(el.branchOrderSettingsMessage, error.message, true);
  } finally {
    el.saveBranchOrderSettings.disabled = false;
  }
}

function renderBranchPortalDisplaySettings() {
  const settings = portalState.branchPortalDisplaySettings;
  if (!settings || !el.branchPortalDisplaySettingsForm) return;
  const mode = settings.scheduleDisplayMode === "colored" ? "colored" : "classic";
  el.branchPortalDisplaySettingsForm.querySelectorAll('[name="branchScheduleDisplayMode"]')
    .forEach((input) => { input.checked = input.value === mode; });
  if (el.branchPortalHideElapsedDays) el.branchPortalHideElapsedDays.checked = settings.mobileHideElapsedDays === true;
  if (el.branchOrderAutosaveEnabled) el.branchOrderAutosaveEnabled.checked = settings.orderAutosaveEnabled === true;
  if (el.branchOrderAutosaveMinutes) el.branchOrderAutosaveMinutes.value = String(settings.orderAutosaveMinutes || 10);
  if (el.branchPortalDisplaySettingsSummary) {
    el.branchPortalDisplaySettingsSummary.textContent = mode === "colored"
      ? "Farbig nach Teammitglied · mobile Ansicht angepasst"
      : "Klassische Dienstplanansicht · mobile Ansicht angepasst";
  }
}

async function loadBranchPortalDisplaySettings() {
  if (!branchPortalDisplaySettingsEnabled() || portalState.branchPortalDisplaySettingsLoading) return;
  portalState.branchPortalDisplaySettingsLoading = true;
  try {
    const result = await api("/api/portal/v1/branch-portal-settings");
    portalState.branchPortalDisplaySettings = result.settings || null;
    if (portalState.scheduleData?.displaySettings && result.settings) {
      portalState.scheduleData.displaySettings = result.settings;
      renderSchedule(portalState.scheduleData);
    }
    renderBranchPortalDisplaySettings();
    configureBranchOrderAutosave();
    message(el.branchPortalDisplaySettingsMessage, "");
  } catch (error) {
    message(el.branchPortalDisplaySettingsMessage, error.message, true);
  } finally {
    portalState.branchPortalDisplaySettingsLoading = false;
  }
}

async function saveBranchPortalDisplaySettings(event) {
  event?.preventDefault();
  if (!branchPortalDisplaySettingsEnabled()) return;
  const mode = el.branchPortalDisplaySettingsForm?.querySelector('[name="branchScheduleDisplayMode"]:checked')?.value || "classic";
  const minutes = Number(el.branchOrderAutosaveMinutes?.value || "");
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 99) {
    message(el.branchPortalDisplaySettingsMessage, "Der Speicherabstand muss eine ganze Zahl zwischen 1 und 99 Minuten sein.", true);
    return;
  }
  if (el.saveBranchPortalDisplaySettings) el.saveBranchPortalDisplaySettings.disabled = true;
  try {
    const result = await api("/api/portal/v1/branch-portal-settings", {
      method: "PUT",
      body: JSON.stringify({
        settings: {
          scheduleDisplayMode: mode,
          mobileHideElapsedDays: el.branchPortalHideElapsedDays?.checked === true,
          orderAutosaveEnabled: el.branchOrderAutosaveEnabled?.checked === true,
          orderAutosaveMinutes: minutes,
        },
      }),
    });
    portalState.branchPortalDisplaySettings = result.settings;
    if (portalState.scheduleData) {
      portalState.scheduleData.displaySettings = result.settings;
      renderSchedule(portalState.scheduleData);
    }
    if (portalState.branchOrderCatalog) portalState.branchOrderCatalog.portalSettings = result.settings;
    renderBranchPortalDisplaySettings();
    configureBranchOrderAutosave();
    message(el.branchPortalDisplaySettingsMessage, "Filialkonto-Einstellungen wurden gespeichert.");
  } catch (error) {
    message(el.branchPortalDisplaySettingsMessage, error.message, true);
  } finally {
    if (el.saveBranchPortalDisplaySettings) el.saveBranchPortalDisplaySettings.disabled = false;
  }
}

function schedulePersonColor(value) {
  const explicit = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(explicit)) return explicit;
  const palette = ["#2b7d66", "#2e6f95", "#a05c43", "#7a5c93", "#9a6b21", "#477a58", "#a64d68", "#386f74"];
  let hash = 0;
  for (const character of String(value || "")) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function renderSchedule(data) {
  if (!data) return;
  const organizationView = isOrganizationAccount();
  portalState.weekStart = data.weekStart;
  portalState.scheduleData = data;
  el.scheduleHeading.textContent = organizationView
    ? `${data.location?.name || "Standort"} · KW ${data.calendarWeek} · ${dateText(data.weekStart)} – ${dateText(data.weekEnd)}`
    : `KW ${data.calendarWeek} · ${dateText(data.weekStart)} – ${dateText(data.weekEnd)}`;
  const today = iso(new Date());
  const settings = data.displaySettings || {};
  const hideElapsedDays = organizationView
    && isBranchMobileAccount()
    && settings.mobileHideElapsedDays === true
    && data.weekStart === mondayOf(new Date());
  const colored = organizationView && settings.scheduleDisplayMode === "colored";
  el.scheduleGrid.dataset.scheduleDisplay = colored ? "colored" : "classic";
  const dates = Array.from({ length: 7 }, (_, index) => ({ date: addDays(data.weekStart, index), index }))
    .filter(({ date }) => !hideElapsedDays || date >= today);
  el.scheduleGrid.innerHTML = dates.map(({ date, index }) => {
    const shifts = data.shifts.filter((item) => (item.shift_date || item.date) === date);
    const options = organizationView
      ? []
      : data.options.filter((item) => item.date_from <= date && item.date_to >= date);
    return `<article class="schedule-day ${date === today ? "today" : ""} ${index > 4 ? "weekend" : ""}">
      <header><strong>${weekdayNames[index]}</strong><span>${dateText(date, { day: "2-digit", month: "2-digit" })}</span></header>
      ${shifts.map((shift) => `<div class="shift-card${colored ? " shift-card-colored" : ""}"${colored ? ` style="--schedule-person-color:${schedulePersonColor(shift.employeeColor || shift.employeeName)}"` : ""}>${organizationView && shift.employeeName ? `<span>${esc(shift.employeeName)}</span><br>` : ""}<strong>${esc(shift.start_time || shift.startTime)}–${esc(shift.end_time || shift.endTime)}</strong>${shift.department_name || shift.departmentName ? `<br>${esc(shift.department_name || shift.departmentName)}` : ""}${shift.area ? `<br>${esc(shift.area)}` : ""}</div>`).join("")}
      ${options.map((option) => `<div class="option-card"><strong>${esc(optionNames[option.option_type] || option.option_type)}</strong>${!option.all_day && option.start_time ? `<br>${esc(option.start_time)}–${esc(option.end_time)}` : ""}${option.note ? `<br>${esc(option.note)}` : ""}</div>`).join("")}
      ${!shifts.length && !options.length ? '<span class="empty-day">Kein Eintrag</span>' : ""}
    </article>`;
  }).join("");
  renderMobileHome();
}

async function loadSchedule() {
  const organizationView = isOrganizationAccount();
  const route = organizationView
    ? `/api/portal/v1/location-dashboard/schedule?week=${portalState.weekStart}`
    : `/api/portal/v1/me/schedule?week=${portalState.weekStart}`;
  renderSchedule(await api(route));
}

function branchVacationDateRangeText(entry) {
  const start = dateText(entry.dateFrom);
  const end = dateText(entry.dateTo);
  return entry.dateFrom === entry.dateTo ? start : `${start} – ${end}`;
}

function renderBranchVacationOverview(data) {
  if (!el.branchVacationList) return;
  el.branchVacationWeek.textContent = `${data.location?.name || "Standort"} · KW ${data.calendarWeek} · ${dateText(data.weekStart)} – ${dateText(data.weekEnd)}`;
  const vacations = Array.isArray(data.vacations) ? data.vacations : [];
  el.branchVacationList.innerHTML = vacations.length
    ? vacations.map((entry) => `<article class="branch-vacation-entry"><div><strong>${esc(entry.employeeName)}</strong><span>Urlaub</span></div><time>${esc(branchVacationDateRangeText(entry))}</time></article>`).join("")
    : '<p class="empty-state">Für diese Kalenderwoche sind keine genehmigten Urlaubszeiträume eingetragen.</p>';
}

async function loadBranchVacationOverview() {
  if (!branchVacationCapabilityEnabled() || portalState.branchVacationLoading) return;
  portalState.branchVacationLoading = true;
  message(el.branchVacationMessage, "");
  try {
    const data = await api(`/api/portal/v1/location-dashboard/vacations?week=${portalState.branchVacationWeekStart}`);
    portalState.branchVacationWeekStart = data.weekStart;
    renderBranchVacationOverview(data);
  } catch (error) {
    if (el.branchVacationList) el.branchVacationList.innerHTML = `<p class="empty-state">${esc(error.message)}</p>`;
    message(el.branchVacationMessage, error.message, true);
  } finally {
    portalState.branchVacationLoading = false;
  }
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
  el.timeWeighted.textContent = durationText(data.valuedMinutes ?? data.actualValuedMinutes);
  el.timePause.textContent = durationText(data.breakMinutes);
  const valuedDifferenceMinutes = data.valuedDifferenceMinutes ?? data.differenceMinutes;
  el.timeDifference.textContent = durationText(valuedDifferenceMinutes, true);
  el.timeDifference.classList.toggle("positive", Number(valuedDifferenceMinutes) > 0);
  el.timeDifference.classList.toggle("negative", Number(valuedDifferenceMinutes) < 0);
  const issues = Array.isArray(data.issues) ? data.issues : [];
  el.timeTrackingIssues.classList.toggle("hidden", !issues.length);
  el.timeTrackingIssues.innerHTML = issues.map((issue) => `<article class="${esc(issue.severity || "warning")}"><strong>${esc(issue.label || issue.code)}</strong><span>${esc(issue.message || "")}</span></article>`).join("");

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

function wifiDateText(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("de-AT", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function wifiSuggestionInput(row, showConfirmationLevel = true) {
  const input = (name, label, value) => `<label><span>${label}</span><input type="time" data-wifi-${name} value="${esc(value || "")}" /></label>`;
  return `<article class="wifi-suggestion-row ${esc(row.warning || "pending")}" data-wifi-suggestion="${esc(row.id)}">
    <div><strong>${esc(wifiDateText(row.workDate))}</strong><small>${esc(row.locationName)}${showConfirmationLevel && row.level ? ` · Stufe ${esc(row.level)}` : ""}</small></div>
    ${input("start", "Beginn", row.startTime)}${input("end", "Ende", row.endTime)}${input("break-start", "Pause von", row.breakStartTime)}${input("break-end", "Pause bis", row.breakEndTime)}
    <div class="wifi-suggestion-actions"><button class="confirm" data-wifi-confirm type="button">Bestätigen</button><button class="reject" data-wifi-reject type="button">Verwerfen</button></div>
  </article>`;
}

function wifiSuggestionValues(row) {
  return {
    id: row.dataset.wifiSuggestion,
    startTime: row.querySelector("[data-wifi-start]")?.value || "",
    endTime: row.querySelector("[data-wifi-end]")?.value || "",
    breakStartTime: row.querySelector("[data-wifi-break-start]")?.value || "",
    breakEndTime: row.querySelector("[data-wifi-break-end]")?.value || "",
  };
}

function renderWifiAutomation() {
  const data = portalState.wifiAutomation;
  el.wifiAutomationCard?.classList.toggle(
    "hidden",
    !wifiTimeSuggestionsCapabilityEnabled() || !mobileLocationDisplayAllows("time"),
  );
  if (!data) return;
  const enabled = data.preference?.enabled === true;
  el.wifiAutomationToggle.checked = enabled;
  el.wifiAutomationToggle.disabled = portalState.wifiAutomationLoading || (!data.canEnable && !enabled);
  el.wifiAutomationAvailability.textContent = enabled
    ? `Aktiv für ${data.locationName}. Die Vorschläge bleiben bis zu deiner Bestätigung unverbindlich.`
    : data.canEnable ? `Für ${data.locationName} verfügbar. Du entscheidest selbst, ob die Erkennung aktiv ist.` : data.availabilityReason;
  const levelText = {
    A: "Stufe A · Vorschläge können gesammelt am Ende der Woche bestätigt werden.",
    B: "Stufe B · Spätestens nach drei Tagen und jedenfalls bis zum Wochenabschluss bestätigen.",
    C: "Stufe C · Täglich, spätestens am Folgetag um 12:00 Uhr bestätigen.",
  };
  const showConfirmationLevel = data.confirmationLevelVisible !== false && Boolean(data.confirmationLevel);
  el.wifiConfirmationLevel.classList.toggle("hidden", !showConfirmationLevel);
  el.wifiConfirmationLevel.textContent = showConfirmationLevel ? (levelText[data.confirmationLevel] || levelText.C) : "";
  const pending = (data.suggestions || []).filter((item) => item.status === "pending");
  const history = (data.suggestions || []).filter((item) => item.status !== "pending").slice(0, 8);
  const warningText = data.counts?.overdue
    ? `${data.counts.overdue} Vorschlag/Vorschläge sind überfällig und müssen noch geprüft werden.`
    : data.counts?.dueSoon ? `${data.counts.dueSoon} Vorschlag/Vorschläge bitte innerhalb der nächsten 24 Stunden prüfen.` : "";
  el.wifiSuggestionWarning.textContent = warningText;
  el.wifiSuggestionWarning.classList.toggle("hidden", !warningText);
  el.wifiSuggestionWarning.classList.toggle("overdue", Boolean(data.counts?.overdue));
  const groups = new Map();
  for (const item of pending) {
    if (!groups.has(item.weekStart)) groups.set(item.weekStart, []);
    groups.get(item.weekStart).push(item);
  }
  const pendingHtml = [...groups.entries()].map(([weekStart, items]) => `
    <div class="wifi-week-heading"><strong>Woche ab ${esc(wifiDateText(weekStart))}</strong>${data.canConfirmWeek ? `<button class="wifi-week-confirm" data-wifi-confirm-week="${esc(weekStart)}" type="button">Woche abschließen</button>` : ""}</div>
    ${items.map((item) => wifiSuggestionInput(item, showConfirmationLevel)).join("")}`).join("");
  const historyHtml = history.length ? `<div class="wifi-week-heading"><strong>Zuletzt bearbeitet</strong></div>${history.map((item) => `
    <div class="wifi-history-row"><span>${esc(wifiDateText(item.workDate))} · ${esc(item.startTime)}–${esc(item.endTime)}</span><strong>${item.status === "confirmed" ? "Bestätigt" : "Verworfen"}</strong></div>`).join("")}` : "";
  el.wifiSuggestionList.innerHTML = pendingHtml || historyHtml
    ? `${pendingHtml}${historyHtml}`
    : `<p class="empty-state">${enabled ? "Derzeit wartet kein WLAN-Zeitvorschlag auf deine Prüfung." : "Aktiviere die Automatik freiwillig, um Zeitvorschläge zu erhalten."}</p>`;
}

async function loadWifiAutomation() {
  if (!portalState.session || !wifiTimeSuggestionsCapabilityEnabled() || portalState.wifiAutomationLoading) return;
  portalState.wifiAutomationLoading = true;
  renderWifiAutomation();
  try {
    portalState.wifiAutomation = await api("/api/portal/v1/me/wifi-automation");
    message(el.wifiAutomationMessage, "");
  } catch (error) {
    message(el.wifiAutomationMessage, error.message, true);
  } finally {
    portalState.wifiAutomationLoading = false;
    renderWifiAutomation();
  }
}

async function setWifiAutomationPreference() {
  const enabled = el.wifiAutomationToggle.checked;
  portalState.wifiAutomationLoading = true;
  renderWifiAutomation();
  try {
    portalState.wifiAutomation = await api("/api/portal/v1/me/wifi-automation", {
      method: "PUT", body: JSON.stringify({ enabled }),
    });
    message(el.wifiAutomationMessage, enabled ? "Die WLAN-Automatik wurde freiwillig aktiviert." : "Die WLAN-Automatik wurde ausgeschaltet.");
  } catch (error) {
    el.wifiAutomationToggle.checked = !enabled;
    message(el.wifiAutomationMessage, error.message, true);
  } finally {
    portalState.wifiAutomationLoading = false;
    renderWifiAutomation();
  }
}

async function decideWifiSuggestion(target) {
  const row = target.closest("[data-wifi-suggestion]");
  if (!row) return;
  try {
    if (target.matches("[data-wifi-confirm]")) {
      portalState.wifiAutomation = await api(`/api/portal/v1/me/wifi-suggestions/${encodeURIComponent(row.dataset.wifiSuggestion)}/confirm`, {
        method: "POST", body: JSON.stringify(wifiSuggestionValues(row)),
      });
      message(el.wifiAutomationMessage, "Der bearbeitete Vorschlag wurde in die Zeiterfassung übernommen.");
    } else if (target.matches("[data-wifi-reject]")) {
      const reason = prompt("Optionaler Grund für das Verwerfen:", "") ?? null;
      if (reason === null) return;
      portalState.wifiAutomation = await api(`/api/portal/v1/me/wifi-suggestions/${encodeURIComponent(row.dataset.wifiSuggestion)}/reject`, {
        method: "POST", body: JSON.stringify({ reason }),
      });
      message(el.wifiAutomationMessage, "Der Vorschlag wurde verworfen.");
    }
    renderWifiAutomation();
    await Promise.allSettled([loadTimeTracking(), loadTimeSummary(), loadNotifications()]);
  } catch (error) { message(el.wifiAutomationMessage, error.message, true); }
}

async function confirmWifiSuggestionWeek(weekStart) {
  const suggestions = Array.from(el.wifiSuggestionList.querySelectorAll("[data-wifi-suggestion]"))
    .map((row) => wifiSuggestionValues(row))
    .filter((item) => portalState.wifiAutomation?.suggestions?.find((suggestion) => suggestion.id === item.id)?.weekStart === weekStart);
  if (!suggestions.length) return;
  try {
    portalState.wifiAutomation = await api("/api/portal/v1/me/wifi-suggestions/confirm-week", {
      method: "POST", body: JSON.stringify({ weekStart, suggestions }),
    });
    message(el.wifiAutomationMessage, "Die Woche wurde geprüft und abgeschlossen.");
    renderWifiAutomation();
    await Promise.allSettled([loadTimeTracking(), loadTimeSummary(), loadNotifications()]);
  } catch (error) { message(el.wifiAutomationMessage, error.message, true); }
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
      actualValuedMinutes: Number(day.actualValuedMinutes ?? day.actual_valued_minutes ?? day.actualMinutes ?? 0),
      absenceCreditedMinutes: Number(day.absenceCreditedMinutes ?? day.absence_credited_minutes ?? 0),
      valuedMinutes: Number(day.valuedMinutes ?? day.valued_minutes ?? day.actualValuedMinutes ?? day.actual_valued_minutes ?? day.actualMinutes ?? 0),
      breakMinutes: Number(day.breakMinutes ?? day.break_minutes ?? 0),
      differenceMinutes: Number(day.differenceMinutes ?? day.difference_minutes ?? 0),
      valuedDifferenceMinutes: Number(day.valuedDifferenceMinutes ?? day.valued_difference_minutes ?? day.differenceMinutes ?? day.difference_minutes ?? 0),
      issues: Array.isArray(day.issues) ? day.issues : [],
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
    actualValuedMinutes: days.reduce((sum, day) => sum + day.actualValuedMinutes, 0),
    absenceCreditedMinutes: days.reduce((sum, day) => sum + day.absenceCreditedMinutes, 0),
    valuedMinutes: days.reduce((sum, day) => sum + day.valuedMinutes, 0),
    breakMinutes: days.reduce((sum, day) => sum + day.breakMinutes, 0),
    differenceMinutes: days.reduce((sum, day) => sum + day.differenceMinutes, 0),
    valuedDifferenceMinutes: days.reduce((sum, day) => sum + day.valuedDifferenceMinutes, 0),
  };
  const from = summary.from || days[0]?.date || portalState.timePeriodAnchor;
  const to = summary.to || days.at(-1)?.date || portalState.timePeriodAnchor;
  el.timePeriodHeading.textContent = portalState.timePeriod === "month"
    ? dateText(from, { month: "long", year: "numeric" })
    : `${dateText(from)} – ${dateText(to)}`;
  el.timePeriodSummary.innerHTML = [
    ["Plan", totals.plannedMinutes ?? totals.planned_minutes],
    ["Ist", totals.actualMinutes ?? totals.actual_minutes],
    ["Gewertet", totals.valuedMinutes ?? totals.valued_minutes ?? totals.actualValuedMinutes ?? totals.actual_valued_minutes],
    ["Pausen", totals.breakMinutes ?? totals.break_minutes],
    ["Differenz", totals.valuedDifferenceMinutes ?? totals.valued_difference_minutes ?? totals.differenceMinutes ?? totals.difference_minutes, true],
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
    const issueStatus = day.issues.length ? `<small class="time-period-issues">${day.issues.map((issue) => esc(issue.label || issue.code)).join(" · ")}</small>` : "";
    const difference = Number(day.valuedDifferenceMinutes || 0);
    return `<article class="time-period-day ${day.date === today ? "today" : ""}" data-time-summary-date="${esc(day.date)}">
      <div><strong>${dateText(day.date, { weekday: "short", day: "2-digit", month: "2-digit" })}</strong><small>${esc(entryText)}</small>${issueStatus}${correctionStatus}</div>
      <div class="time-period-value"><span>Plan</span><strong>${durationText(day.plannedMinutes)}</strong></div>
      <div class="time-period-value"><span>Ist</span><strong>${durationText(day.actualMinutes)}</strong></div>
      <div class="time-period-value"><span>Gew.</span><strong>${durationText(day.valuedMinutes)}</strong></div>
      <div class="time-period-value"><span>Pause</span><strong>${durationText(day.breakMinutes)}</strong></div>
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
    await loadTimeRecordStatements();
  } catch (error) {
    el.timePeriodList.innerHTML = `<p class="empty-state">${esc(error.message)}</p>`;
    if (portalState.timePeriod === "month" && hasPortalPermission("own_time_record:read")) {
      await loadTimeRecordStatements();
    }
  }
}

function timeRecordStatementStatusLabel(status) {
  return ({
    finalized: "Finalisiert",
    superseded: "Ersetzt",
    revoked: "Zurückgezogen",
  })[status] || status || "Finalisiert";
}

function renderTimeRecordStatements() {
  if (!el.timeRecordStatementsPanel || !el.timeRecordStatementList) return;
  const visible = portalState.timePeriod === "month" && hasPortalPermission("own_time_record:read");
  el.timeRecordStatementsPanel.classList.toggle("hidden", !visible);
  if (!visible) return;
  const statements = portalState.timeRecordStatements.filter((statement) => statement?.status === "finalized");
  el.timeRecordStatementList.innerHTML = statements.length ? statements.map((statement) => {
    const completeness = statement.completeness === "complete"
      ? "Vollständig"
      : statement.completeness === "incomplete" ? "Unvollständig" : statement.completeness || "";
    const finalized = statement.finalizedAt || statement.createdAt;
    const download = statement.downloadAvailable
      ? `<a class="text-button time-record-download" href="/api/portal/v1/self/time-record-statements/${encodeURIComponent(String(statement.id))}/download">PDF herunterladen</a>`
      : '<span class="time-record-unavailable">Noch kein Download verfügbar</span>';
    return `<article class="time-record-statement">
      <div>
        <strong>Monatsnachweis · Revision ${esc(statement.revision ?? 1)}</strong>
        <small>${finalized ? `Finalisiert: ${esc(timestampText(finalized))}` : "Finalisiert"}</small>
        ${completeness ? `<small>${esc(completeness)}</small>` : ""}
      </div>
      <div class="time-record-actuals" aria-label="Tatsächliche Arbeitszeit">
        <span>Ist-Zeit<strong>${durationText(statement.actualMinutes)}</strong></span>
        <span>Pausen<strong>${durationText(statement.breakMinutes)}</strong></span>
      </div>
      <span class="status approved">${esc(timeRecordStatementStatusLabel(statement.status))}</span>
      ${download}
    </article>`;
  }).join("") : '<p class="empty-state">Für diesen Monat liegt noch kein finalisierter Arbeitszeitnachweis vor.</p>';
}

async function loadTimeRecordStatements() {
  if (!el.timeRecordStatementsPanel || !hasPortalPermission("own_time_record:read") || portalState.timePeriod !== "month") {
    el.timeRecordStatementsPanel?.classList.add("hidden");
    portalState.timeRecordStatements = [];
    portalState.timeRecordStatementsMonth = "";
    return;
  }
  const month = String(portalState.timePeriodAnchor || iso(new Date())).slice(0, 7);
  portalState.timeRecordStatementsMonth = month;
  el.timeRecordStatementsPanel.classList.remove("hidden");
  el.timeRecordStatementList.innerHTML = '<p class="empty-state">Monatsnachweise werden geladen.</p>';
  try {
    const data = await api(`/api/portal/v1/self/time-record-statements?month=${encodeURIComponent(month)}`);
    if (portalState.timeRecordStatementsMonth !== month) return;
    portalState.timeRecordStatements = Array.isArray(data.statements) ? data.statements : [];
    renderTimeRecordStatements();
  } catch (error) {
    if (portalState.timeRecordStatementsMonth !== month) return;
    portalState.timeRecordStatements = [];
    el.timeRecordStatementList.innerHTML = `<p class="empty-state">${esc(error.message)}</p>`;
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
  const user = portalUser();
  const role = user?.role;
  const stage = request.approval_stage || request.approvalStage;
  if (stage === "hr") return user?.permissions?.includes("hr:approve");
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

function amuIdentityStatusText(report) {
  return ({
    matched: "SV-Abgleich bestätigt",
    not_detected: "SV-Angabe nicht eindeutig erkannt · manuell prüfen",
    profile_missing: "SV-Nummer im Personalakt fehlt · manuell prüfen",
    not_checked: "SV-Abgleich noch nicht durchgeführt",
  })[report?.identity_check?.status] || "";
}

function renderLeadershipApprovals() {
  const kind = portalState.leadershipKind;
  let items = [];
  if (kind === "absence") items = portalState.leadershipRequests.filter(leadershipItemInContext);
  else if (kind === "sickness") items = portalState.leadershipSicknessCases.filter(leadershipItemInContext);
  else if (kind === "amu") items = portalState.leadershipAmuReports.filter(leadershipItemInContext);
  else {
    const overview = portalState.leadershipOverview || {};
    items = overview.timeCorrections || overview.time_corrections || overview.corrections || [];
    items = items.filter((item) => (!item.status || item.status === "pending") && leadershipItemInContext(item));
  }
  el.leadershipApprovalList.innerHTML = items.length ? items.map((item) => {
    const employeeNumber = item.employee_number || item.employeeNumber || "";
    const name = item.nickname || item.full_name || item.fullName || "";
    const label = kind === "sickness" ? "Krankmeldung" : kind === "amu" ? "AUM" : kind === "time_correction" ? "Zeitkorrektur" : requestKindLabel(item);
    const period = kind === "sickness"
      ? `${dateText(item.start_date)}${item.expected_end ? ` – ${dateText(item.expected_end)}` : " · Ende offen"}`
      : kind === "amu" ? `${dateText(item.incapacity_from)}${item.incapacity_to ? ` – ${dateText(item.incapacity_to)}` : " · Ende offen"}` : leadershipRequestPeriodText(item);
    const risk = kind === "sickness" && item.staffing_risk?.atRisk ? " · Mindestbesetzung gefährdet" : "";
    const status = kind === "sickness" ? (item.severity || item.status || "reported") : (item.status || "pending");
    const amuStatusText = ({ required: "AUM erforderlich", not_required: "AUM nicht erforderlich", received: "AUM eingelangt", reviewed: "AUM geprüft" })[item.aum_status] || "Krankmeldung erfasst";
    const statusText = kind === "sickness"
      ? ({ red: "Rot eskaliert", yellow: "AUM überfällig", warning: "Besetzung prüfen", normal: amuStatusText }[status] || amuStatusText)
      : (statusLabels[item.status] || item.status || "Offen");
    const identity = kind === "amu" ? amuIdentityStatusText(item) : "";
    const canOpen = kind === "time_correction" || item.capabilities?.view === true;
    return `<article class="leadership-request-row sickness-severity-${esc(status)}" data-leadership-request-id="${esc(item.id)}" data-leadership-request-kind="${esc(kind)}"><div><strong>${esc(label)} · ${esc(employeeNumber)} · ${esc(name)}</strong><small>${esc(period)}${item.note || item.employee_note ? ` · ${esc(item.note || item.employee_note)}` : ""}${identity ? ` · ${esc(identity)}` : ""}${esc(risk)}</small><span class="status ${esc(status)}">${esc(statusText)}</span></div>${canOpen ? '<button type="button" data-open-leadership-request>Öffnen</button>' : ""}</article>`;
  }).join("") : '<p class="empty-state">Für diesen Bereich sind keine offenen oder abgeschlossenen Fälle vorhanden.</p>';
}

async function loadLeadershipApprovals() {
  if (!isLeadershipUser()) return;
  await loadLeadershipContexts();
  el.leadershipApprovalList.innerHTML = '<p class="empty-state">Freigaben werden geladen.</p>';
  portalState.leadershipRequests = [];
  portalState.leadershipAmuReports = [];
  portalState.leadershipSicknessCases = [];
  portalState.leadershipOverview = null;
  const permissions = portalUser()?.permissions || [];
  const canUseProtectedAmuArea = permissions.includes("amu:metadata:read") || permissions.includes("amu:review") || permissions.includes("amu:local:manage");
  document.querySelector('[data-leadership-kind="amu"]')?.classList.toggle("hidden", !canUseProtectedAmuArea);
  if (portalState.leadershipKind === "amu" && !canUseProtectedAmuArea) portalState.leadershipKind = "sickness";
  document.querySelectorAll("[data-leadership-kind]").forEach((button) => button.classList.toggle("active", button.dataset.leadershipKind === portalState.leadershipKind));
  const tasks = [{ kind: "time_correction", request: api(`/api/portal/v1/leadership/overview?${leadershipQuery()}`).then((result) => { portalState.leadershipOverview = normalizedLeadershipOverview(result); }) }];
  if (permissions.includes("vacation:read") || permissions.includes("time:review")) tasks.push({ kind: "absence", request: api(`/api/portal/v1/absence-requests?${leadershipQuery()}`).then((result) => { portalState.leadershipRequests = result.requests || []; }) });
  if (permissions.includes("amu:metadata:read") || permissions.includes("amu:review") || permissions.includes("amu:local:manage")) tasks.push({ kind: "amu", request: api(`/api/portal/v1/amu-reports?${leadershipQuery()}`).then((result) => { portalState.leadershipAmuReports = result.reports || []; }) });
  if (permissions.includes("sickness:read")) tasks.push({ kind: "sickness", request: api(`/api/portal/v1/sickness-cases?${leadershipQuery()}`).then((result) => { portalState.leadershipSicknessCases = result.cases || []; }) });
  const results = await Promise.allSettled(tasks.map((task) => task.request));
  const activeFailure = results.find((result, index) => result.status === "rejected" && tasks[index].kind === portalState.leadershipKind);
  if (activeFailure) {
    el.leadershipApprovalList.innerHTML = `<p class="message error">${esc(activeFailure.reason?.message || "Dieser Bereich konnte nicht geladen werden.")}</p>`;
    return;
  }
  if (results.every((result) => result.status === "rejected")) {
    el.leadershipApprovalList.innerHTML = `<p class="empty-state">${esc(results[0].reason?.message || "Freigaben konnten nicht geladen werden.")}</p>`;
    return;
  }
  renderLeadershipApprovals();
}

function findLeadershipRequest(id, kind) {
  if (kind === "sickness") return portalState.leadershipSicknessCases.find((item) => String(item.id) === String(id));
  if (kind === "amu") return portalState.leadershipAmuReports.find((item) => String(item.id) === String(id));
  if (kind === "time_correction") {
    const overview = portalState.leadershipOverview || {};
    return (overview.timeCorrections || overview.time_corrections || overview.corrections || []).find((item) => String(item.id) === String(id));
  }
  return portalState.leadershipRequests.find((item) => String(item.id) === String(id));
}

function leadershipEventHistoryHtml(events = []) {
  return events.length ? events.map((event) => {
    const actor = event.actor_employee_number || event.actorEmployeeNumber || event.actor || "System";
    const action = event.action_label || event.actionLabel || event.action || "Bearbeitet";
    const timestamp = event.created_at || event.createdAt || event.occurred_at || event.occurredAt;
    const note = event.note || event.reason || "";
    return `<article><strong>${esc(actor)} · ${esc(action)}</strong><small>${timestamp ? esc(new Date(timestamp).toLocaleString("de-AT")) : ""}${note ? ` · ${esc(note)}` : ""}</small></article>`;
  }).join("") : "";
}

function leadershipDialogActions(request, kind) {
  const capabilities = request.capabilities || {};
  if (kind === "sickness") {
    return [
      ...(capabilities.update === true ? [["update", "Falldaten speichern", "secondary-action"]] : []),
      ...(capabilities.close === true ? [["close", "Krankenstand schließen", "primary-action"]] : []),
      ...(capabilities.correctClosed === true ? [["correct_closed", "Abschluss korrigieren", "primary-action"]] : []),
    ];
  }
  if (kind === "amu") {
    return [
      ...(capabilities.returnForCompletion === true ? [["return", "Ergänzung anfordern", "secondary-action"]] : []),
      ...(capabilities.review === true ? [["review", "Als geprüft markieren", "primary-action"]] : []),
      ...(capabilities.addNote === true ? [["add_note", "Vermerk speichern", "secondary-action"]] : []),
    ];
  }
  if (kind === "time_correction") return [["reject", "Ablehnen", "danger-action"], ["approve", "Genehmigen", "primary-action"]];
  return [
    ...(capabilities.decide === true || capabilities.reject === true ? [["reject", "Ablehnen", "danger-action"]] : []),
    ...((capabilities.decide === true || capabilities.preliminary === true) && request.status !== "pending_hr"
      ? [["preliminary", "Vorläufig", "secondary-action"]] : []),
    ...(capabilities.decide === true || capabilities.approve === true ? [["approve", "Genehmigen / weiterleiten", "primary-action"]] : []),
    ...(capabilities.update === true || capabilities.change === true ? [["change", "Änderung speichern", "primary-action"]] : []),
    ...(capabilities.close === true || capabilities.cancel === true ? [["cancel", "Genehmigten Antrag stornieren", "danger-action"]] : []),
  ];
}

async function openLeadershipRequest(id, kind) {
  let request = findLeadershipRequest(id, kind);
  if (!request) return;
  let events = [];
  if (kind === "sickness") {
    try {
      const result = await api(`/api/portal/v1/sickness-cases/${encodeURIComponent(request.id)}`);
      request = result.case || request;
      events = result.events || [];
      const index = portalState.leadershipSicknessCases.findIndex((entry) => String(entry.id) === String(request.id));
      if (index >= 0) portalState.leadershipSicknessCases[index] = request;
    } catch (error) {
      message(el.leadershipRequestMessage, error.message, true);
      return;
    }
  } else if (kind === "amu") {
    try {
      const result = await api(`/api/portal/v1/amu-reports/${encodeURIComponent(request.id)}`);
      request = result.report || request;
      events = result.events || [];
      const index = portalState.leadershipAmuReports.findIndex((entry) => String(entry.id) === String(request.id));
      if (index >= 0) portalState.leadershipAmuReports[index] = request;
    } catch (error) {
      message(el.leadershipRequestMessage, error.message, true);
      return;
    }
  }
  portalState.selectedLeadershipRequest = { request, kind };
  const employeeNumber = request.employee_number || request.employeeNumber || "";
  const name = request.nickname || request.full_name || request.fullName || "";
  const title = kind === "sickness" ? "Krankmeldung" : kind === "amu" ? "AUM prüfen" : kind === "time_correction" ? "Zeitkorrektur prüfen" : `${requestKindLabel(request)} bearbeiten`;
  el.leadershipRequestTitle.textContent = title;
  const sicknessPeriod = `${dateText(request.start_date)}${request.expected_end ? ` – ${dateText(request.expected_end)}` : " · Ende offen"}`;
  const requestPeriod = kind === "sickness" ? sicknessPeriod : kind === "amu" ? `${dateText(request.incapacity_from)}${request.incapacity_to ? ` – ${dateText(request.incapacity_to)}` : " · Ende offen"}` : leadershipRequestPeriodText(request);
  const sicknessDetails = kind === "sickness" && request.staffing_risk?.atRisk
    ? `<p class="message error">Die hinterlegte Mindestbesetzung kann unterschritten werden. Kritische Zeitfenster: ${(request.staffing_risk.slots || []).slice(0, 4).map((slot) => `${esc(dateText(slot.date))} ${esc(slot.time)} Uhr`).join(" · ") || "laut aktuellem Dienstplan"}.</p>` : "";
  const identityDetails = kind === "amu" && amuIdentityStatusText(request)
    ? `<p class="message ${request.identity_check?.status === "matched" ? "success" : "warning"}">${esc(amuIdentityStatusText(request))}</p>` : "";
  el.leadershipRequestSummary.innerHTML = `<strong>${esc(employeeNumber)} · ${esc(name)}</strong><p>${esc(requestPeriod)}</p>${request.note || request.employee_note ? `<p>${esc(request.note || request.employee_note)}</p>` : ""}${identityDetails}${sicknessDetails}`;
  el.leadershipRequestHistory.innerHTML = leadershipEventHistoryHtml(events);
  el.leadershipRequestHistory.classList.toggle("hidden", !events.length);
  const canOpenAmuFiles = kind === "amu" && request.capabilities?.openFiles === true;
  el.leadershipRequestDocuments.innerHTML = canOpenAmuFiles
    ? (request.documents || []).map((document) => `<a href="/api/portal/v1/amu-reports/${Number(request.id)}/documents/${encodeURIComponent(String(document.id))}/content" target="_blank" rel="noopener">${esc(document.original_name || "AUM-Dokument")} öffnen</a>`).join("")
    : "";
  el.leadershipRequestDocuments.classList.toggle("hidden", !canOpenAmuFiles || !(request.documents || []).length);
  el.leadershipRequestNote.value = "";
  el.leadershipSicknessFields.classList.toggle("hidden", kind !== "sickness");
  if (kind === "sickness") {
    el.leadershipSicknessExpectedEnd.value = request.expected_end || "";
    el.leadershipSicknessExpectedEnd.min = request.start_date || "";
    el.leadershipSicknessReturnDate.value = request.return_to_work_date || iso(new Date());
    el.leadershipSicknessReturnDate.min = request.start_date || "";
  }
  el.leadershipCorrectionEntries.innerHTML = "";
  el.leadershipCorrectionEntries.classList.toggle("hidden", kind !== "time_correction");
  el.addLeadershipCorrectionEntry.classList.toggle("hidden", kind !== "time_correction");
  el.leadershipRequestNote.closest("label")?.classList.remove("hidden");
  if (kind === "time_correction") {
    const requested = correctionRequestedChange(request);
    const entries = request.proposedEntries || request.proposed_entries || requested.proposedEntries || requested.entries || [];
    entries.forEach((entry) => appendCorrectionEntry({ ...entry, time: correctionEntryTime(entry, correctionDate(request)) }, el.leadershipCorrectionEntries));
  }
  message(el.leadershipRequestMessage, "");
  const actions = leadershipDialogActions(request, kind);
  el.leadershipRequestActions.innerHTML = `<button type="button" data-close-leadership-request>Dialog schließen</button>${actions.map(([action, label, className]) => `<button class="${className}" data-leadership-action="${action}" type="button">${label}</button>`).join("")}`;
  el.leadershipRequestDialog.showModal();
}

async function decideLeadershipRequest(action) {
  const selected = portalState.selectedLeadershipRequest;
  if (!selected) return;
  const { request, kind } = selected;
  let url;
  let body;
  const note = el.leadershipRequestNote.value.trim();
  if (kind === "sickness") {
    if (action === "correct_closed" && !note) {
      message(el.leadershipRequestMessage, "Eine Korrektur eines abgeschlossenen Falls benötigt eine Begründung.", true);
      return;
    }
    if (action === "close" && !el.leadershipSicknessReturnDate.value) {
      message(el.leadershipRequestMessage, "Bitte das Datum der Wiederaufnahme der Arbeit eingeben.", true);
      return;
    }
    url = `/api/portal/v1/sickness-cases/${request.id}/action`;
    body = {
      action,
      expectedRevision: request.revision,
      expectedStatus: request.status,
      expectedEnd: el.leadershipSicknessExpectedEnd.value,
      returnDate: el.leadershipSicknessReturnDate.value,
      note,
    };
  } else if (kind === "amu") {
    if (["return", "add_note"].includes(action) && !note) {
      message(el.leadershipRequestMessage, action === "return" ? "Bitte die benötigte Ergänzung beschreiben." : "Bitte einen Vermerk eingeben.", true);
      return;
    }
    url = `/api/portal/v1/amu-reports/${request.id}/action`;
    body = { action, note, expectedRevision: request.revision, expectedStatus: request.status };
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
    body = { action, decision: action === "approve" ? "approved" : "rejected", note, entries: proposedEntries, proposedEntries };
  } else {
    const requestKind = ["vacation_change", "vacation_cancel"].includes(request.kind) ? "vacation_change"
      : ["time_off_change", "time_off_cancel"].includes(request.kind) ? "time_off_change" : request.kind;
    url = `/api/portal/v1/absence-requests/${requestKind}/${request.id}/action`;
    body = { action, note };
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
  el.timeOffEnd.innerHTML = '<option value="">Beginn wählen</option>';
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

function vacationExpiryText(account = {}) {
  const status = String(account.expiryStatus || "");
  const date = account.expiryCandidateOn ? dateText(account.expiryCandidateOn) : "";
  if (status === "not_due") return date ? `Verfallsprüfung frühestens ab ${date}` : "Noch nicht zur Verfallsprüfung fällig";
  if (status === "manual_review") return date ? `Manuelle Verfallsprüfung seit ${date}` : "Manuelle Verfallsprüfung erforderlich";
  if (status === "candidate_with_evidence") return date ? `Verfallskandidat ab ${date} · manuell prüfen` : "Verfallskandidat · manuell prüfen";
  if (status === "expired") return date ? `Verfallsprüfung seit ${date}` : "Verfallsprüfung erforderlich";
  if (status === "candidate") return date ? `Mögliche Verfallsprüfung ab ${date}` : "Mögliche Verfallsprüfung";
  if (status === "protected") return "Derzeit kein Verfallskandidat";
  if (status === "none" || status === "not_applicable") return "Keine Verfallsprüfung ausgewiesen";
  return date ? `Prüfdatum: ${date}` : "";
}

function renderVacationAccount() {
  if (!el.vacationAccountCard || !hasPortalPermission("own_vacation:read")) return;
  el.vacationAccountCard.classList.remove("hidden");
  const account = portalState.vacationAccount;
  if (!account) {
    el.vacationAccountSummary.innerHTML = '<p class="empty-state">Für dieses Urlaubsjahr ist noch kein bestätigtes Urlaubskonto vorhanden.</p>';
    return;
  }
  const expiry = vacationExpiryText(account);
  el.vacationAccountSummary.innerHTML = `
    <div class="vacation-account-primary">
      <article><span>Anspruch</span><strong>${numberText(account.totalDays)} Tage</strong></article>
      <article><span>Bereits konsumiert</span><strong>${numberText(account.consumedDays)} Tage</strong></article>
      <article><span>Insgesamt geplant</span><strong>${numberText(account.plannedDays ?? account.consumedDays)} Tage</strong></article>
      <article class="vacation-remaining"><span>Nach Planung verfügbar</span><strong>${numberText(account.remainingDays)} Tage</strong></article>
    </div>
    <div class="vacation-account-details">
      <span>EU-Mindestanspruch<strong>${numberText(account.euMinimumDays)} Tage</strong></span>
      <span>Zusätzlicher Anspruch<strong>${numberText(account.nationalAdditionalDays)} Tage</strong></span>
      <span>Stand<strong>Revision ${esc(account.revision ?? 1)}</strong></span>
      ${expiry ? `<span>Hinweis<strong>${esc(expiry)}</strong></span>` : ""}
    </div>`;
}

function numberText(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return new Intl.NumberFormat("de-AT", { maximumFractionDigits: 2 }).format(numeric);
}

async function loadVacationAccount() {
  if (!hasPortalPermission("own_vacation:read") || !el.vacationAccountCard) return;
  const year = String(Number(portalState.vacationAccountYear) || new Date().getFullYear());
  portalState.vacationAccountYear = year;
  el.vacationAccountCard.classList.remove("hidden");
  el.vacationAccountSummary.innerHTML = '<p class="empty-state">Urlaubsstand wird geladen.</p>';
  el.vacationAccountNotice.textContent = "";
  try {
    const data = await api(`/api/portal/v1/self/vacation-account?year=${encodeURIComponent(year)}`);
    if (portalState.vacationAccountYear !== year) return;
    portalState.vacationAccount = data.account || null;
    el.vacationAccountNotice.textContent = data.notice
      || "Der ausgewiesene Stand basiert auf dem bestätigten Urlaubskonto dieses Urlaubsjahres.";
    renderVacationAccount();
  } catch (error) {
    if (portalState.vacationAccountYear !== year) return;
    portalState.vacationAccount = null;
    el.vacationAccountSummary.innerHTML = `<p class="empty-state">${esc(error.message)}</p>`;
    el.vacationAccountNotice.textContent = "";
  }
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

function personalActionTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Zeitpunkt nicht verfügbar";
  return new Intl.DateTimeFormat("de-AT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function portalPersonalActionsActorKey(user = portalUser()) {
  if (!user || isOrganizationAccount(user)) return "";
  return String(user.employeeNumber || "").trim();
}

function resetPersonalActionsState(actorKey = "") {
  portalState.personalActionsActorKey = String(actorKey || "");
  portalState.personalActionsRequestId += 1;
  portalState.personalActions = [];
  portalState.personalActionsCursor = "";
  portalState.personalActionsLoading = false;
  portalState.personalActionUndoPending = "";
  if (el.personalActionsDialog?.open) el.personalActionsDialog.close();
  el.personalActionsButton?.setAttribute("aria-expanded", "false");
  el.personalActionsList?.replaceChildren();
  message(el.personalActionsMessage, "");
}

function personalActionsRequestIsCurrent(actorKey, requestId) {
  return portalState.personalActionsActorKey === actorKey
    && portalPersonalActionsActorKey() === actorKey
    && portalState.personalActionsRequestId === requestId;
}

function renderPersonalActions() {
  if (!el.personalActionsList) return;
  if (portalState.personalActionsLoading && !portalState.personalActions.length) {
    const loading = document.createElement("p");
    loading.className = "empty-state";
    loading.textContent = "Aktionen werden geladen.";
    el.personalActionsList.replaceChildren(loading);
  } else if (!portalState.personalActions.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = portalState.personalActionsCursor
      ? "Weitere ältere Aktionen können geladen werden."
      : "Noch keine persönlichen Aktionen protokolliert.";
    el.personalActionsList.replaceChildren(empty);
  } else {
    const fragment = document.createDocumentFragment();
    portalState.personalActions.forEach((action) => {
      const row = document.createElement("article");
      row.className = "personal-action-row";
      row.dataset.personalActionId = String(action.id || "");
      row.setAttribute("role", "listitem");

      const copy = document.createElement("div");
      copy.className = "personal-action-copy";
      const title = document.createElement("strong");
      title.textContent = String(action.title || action.label || "Aktion");
      const summary = document.createElement("p");
      summary.textContent = String(action.summary || action.description || "Sicher protokolliert.");
      const meta = document.createElement("small");
      meta.textContent = personalActionTimestamp(action.createdAt || action.created_at);
      copy.append(title, summary, meta);

      const controls = document.createElement("div");
      controls.className = "personal-action-controls";
      const undoAvailable = action.canUndo === true || action.undo?.available === true;
      if (undoAvailable) {
        const undo = document.createElement("button");
        undo.type = "button";
        undo.className = "text-button personal-action-undo";
        undo.dataset.undoPersonalAction = String(action.id || "");
        undo.textContent = String(action.undo?.label || action.undoLabel || "Rückgängig");
        undo.disabled = portalState.personalActionsLoading
          || portalState.personalActionUndoPending === String(action.id || "");
        controls.append(undo);
      } else {
        const status = document.createElement("span");
        status.className = "personal-action-final";
        status.textContent = String(action.undo?.reason || action.undoBlockedReason || "Nicht rückgängig");
        controls.append(status);
      }
      row.append(copy, controls);
      fragment.append(row);
    });
    el.personalActionsList.replaceChildren(fragment);
  }
  if (el.personalActionsLoadMore) {
    el.personalActionsLoadMore.classList.toggle("hidden", !portalState.personalActionsCursor);
    el.personalActionsLoadMore.disabled = portalState.personalActionsLoading;
  }
}

async function loadPersonalActions({ append = false } = {}) {
  if (portalState.personalActionsLoading) return;
  const actorKey = portalPersonalActionsActorKey();
  if (!actorKey || portalState.personalActionsActorKey !== actorKey) return;
  const requestId = ++portalState.personalActionsRequestId;
  portalState.personalActionsLoading = true;
  if (!append) {
    portalState.personalActions = [];
    portalState.personalActionsCursor = "";
  }
  message(el.personalActionsMessage, "");
  renderPersonalActions();
  try {
    const cursor = append ? portalState.personalActionsCursor : "";
    const query = new URLSearchParams({ limit: "25" });
    if (cursor) query.set("cursor", cursor);
    const result = await api(`/api/portal/v1/me/actions?${query}`);
    if (!personalActionsRequestIsCurrent(actorKey, requestId)) return;
    const actions = Array.isArray(result?.actions) ? result.actions : [];
    portalState.personalActions = append ? [...portalState.personalActions, ...actions] : actions;
    portalState.personalActionsCursor = String(result?.nextCursor || "");
  } catch (error) {
    if (personalActionsRequestIsCurrent(actorKey, requestId)) {
      message(el.personalActionsMessage, error.message, true);
    }
  } finally {
    if (personalActionsRequestIsCurrent(actorKey, requestId)) {
      portalState.personalActionsLoading = false;
      renderPersonalActions();
    }
  }
}

async function openPersonalActions() {
  if (!el.personalActionsDialog) return;
  el.personalActionsButton?.setAttribute("aria-expanded", "true");
  el.personalActionsDialog.showModal();
  await loadPersonalActions();
}

function closePersonalActions() {
  if (el.personalActionsDialog?.open) el.personalActionsDialog.close();
}

async function undoPersonalAction(actionId) {
  const action = portalState.personalActions.find((entry) => String(entry.id) === String(actionId));
  if (!action || portalState.personalActionsLoading || portalState.personalActionUndoPending) return;
  const actorKey = portalPersonalActionsActorKey();
  if (!actorKey || portalState.personalActionsActorKey !== actorKey) return;
  const label = String(action.title || action.label || "diese Aktion");
  if (!window.confirm(`„${label}“ wirklich rückgängig machen? Die ursprüngliche Historie bleibt erhalten.`)) return;
  const requestId = ++portalState.personalActionsRequestId;
  portalState.personalActionUndoPending = String(actionId);
  message(el.personalActionsMessage, "");
  renderPersonalActions();
  try {
    await api(`/api/portal/v1/me/actions/${encodeURIComponent(actionId)}/undo`, {
      method: "POST",
      body: "{}",
    });
    if (!personalActionsRequestIsCurrent(actorKey, requestId)) return;
    await loadPersonalActions();
    if (portalPersonalActionsActorKey() === actorKey) {
      message(el.personalActionsMessage, "Die Gegenaktion wurde sicher protokolliert.");
    }
  } catch (error) {
    if (personalActionsRequestIsCurrent(actorKey, requestId)) {
      message(el.personalActionsMessage, error.message, true);
    }
  } finally {
    if (portalPersonalActionsActorKey() === actorKey) {
      portalState.personalActionUndoPending = "";
      renderPersonalActions();
    }
  }
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
    const targetUrl = target.startsWith("/") ? new URL(target, location.origin) : null;
    const legacyProcessTarget = targetUrl?.pathname === "/"
      && targetUrl.searchParams.get("view") === "rightsDashboard"
      && targetUrl.searchParams.get("dashboard") === "processes";
    const entityType = String(item?.entity_type || item?.entityType || "");
    if (legacyProcessTarget || /(?:^|_)process(?:_|$)/.test(entityType)) {
      portalState.processTaskRequestedRunId = String(
        item?.run_id || item?.runId || targetUrl?.searchParams.get("run") || item?.entity_id || item?.entityId || "",
      ).slice(0, 120);
      portalState.processTaskRequestedStepId = String(
        item?.step_id || item?.stepId || targetUrl?.searchParams.get("step") || "",
      ).slice(0, 120);
      el.notificationsDialog.close();
      setTab("processTasks");
    } else if (target.startsWith("/portal")) {
      const requested = targetUrl.searchParams.get("tab");
      const requestedKind = targetUrl.searchParams.get("kind");
      if (["absence", "sickness", "amu", "time_correction"].includes(requestedKind)) portalState.leadershipKind = requestedKind;
      const tab = normalizedPortalTab(requested);
      if (tab === "processTasks") {
        portalState.processTaskRequestedRunId = String(targetUrl.searchParams.get("run") || "").slice(0, 120);
        portalState.processTaskRequestedStepId = String(targetUrl.searchParams.get("step") || "").slice(0, 120);
      }
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

function processTaskValue(task, ...paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((current, key) => current?.[key], task);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function normalizeProcessTask(task = {}) {
  const runId = String(processTaskValue(task, "runId", "run_id", "processRunId", "process_run_id"));
  const stepId = String(processTaskValue(task, "stepId", "step_id", "step.id"));
  const activationCount = Number(processTaskValue(task, "activationCount", "activation_count") || 1);
  const position = Number(processTaskValue(task, "position", "stepPosition", "step_position", "step.position", "step.sequence") || 1);
  const stepCount = Number(processTaskValue(task, "stepCount", "step_count", "totalSteps", "total_steps", "progress.total") || position);
  return {
    runId,
    stepId,
    activationCount: Number.isInteger(activationCount) && activationCount > 0 ? activationCount : 1,
    key: `${runId}:${Number.isInteger(activationCount) && activationCount > 0 ? activationCount : 1}:${stepId}`,
    processId: String(processTaskValue(task, "processId", "process_id", "process.id")),
    processTitle: String(processTaskValue(task, "processTitle", "process_title", "process.title") || "Prozess"),
    processSymbol: String(processTaskValue(task, "processSymbol", "process_symbol", "process.symbol") || "AP").slice(0, 5),
    stepTitle: String(processTaskValue(task, "stepTitle", "step_title", "title", "step.title") || "Arbeitsschritt"),
    stepDescription: String(processTaskValue(task, "stepDescription", "step_description", "description", "step.description")),
    conditionText: String(processTaskValue(task, "conditionText", "condition_text", "condition.text", "step.conditionText", "step.condition.text")),
    scopeLabel: String(processTaskValue(task, "scopeLabel", "scope_label", "scope.label") || "Unternehmen"),
    position: Number.isFinite(position) && position > 0 ? position : 1,
    stepCount: Number.isFinite(stepCount) && stepCount > 0 ? Math.max(stepCount, position) : position,
    status: String(processTaskValue(task, "status", "taskStatus", "task_status") || "open"),
    assignedAt: String(processTaskValue(task, "assignedAt", "assigned_at", "createdAt", "created_at")),
    dueAt: String(processTaskValue(task, "dueAt", "due_at")),
    canComplete: processTaskValue(task, "canComplete", "can_complete") !== false && task.blocked !== true && task.current !== false,
    completionNoteRequired: processTaskValue(task, "completionNoteRequired", "completion_note_required") === true,
    personnelWorkflow: task.personnelWorkflow === true,
  };
}

function normalizeProcessTaskSummary(summary = {}) {
  const openCount = Number(summary?.openCount);
  const activeRuns = Number(summary?.activeRuns);
  return {
    openCount: Number.isInteger(openCount) && openCount >= 0 ? openCount : 0,
    activeRuns: Number.isInteger(activeRuns) && activeRuns >= 0 ? activeRuns : 0,
  };
}

function processTaskActorFingerprint(user = portalUser()) {
  if (!user) return "";
  const permissions = [...new Set((Array.isArray(user.permissions) ? user.permissions : [])
    .map((permission) => String(permission || "").trim())
    .filter(Boolean))].sort();
  const scopes = (Array.isArray(user.scopes) ? user.scopes : []).map((scope) => [
    scope?.locationId ?? scope?.location_id ?? "",
    scope?.departmentId ?? scope?.department_id ?? "",
    scope?.scopeType ?? scope?.scope_type ?? "",
  ].map((value) => String(value || "")))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify({
    actorId: String(user.employeeNumber || user.accountId || user.loginName || ""),
    accountType: String(user.accountType || ""),
    isEmployee: user.isEmployee !== false,
    role: String(user.role || ""),
    profileId: String(user.profileId || user.profile?.id || ""),
    homeLocationId: String(user.homeLocationId || ""),
    positionId: String(user.positionId || ""),
    mustChangePassword: user.mustChangePassword === true,
    permissions,
    scopes,
  });
}

function processTaskRequestContextCurrent(generation, actorFingerprint) {
  return Boolean(
    portalState.session
      && actorFingerprint
      && portalState.processTasksRequestGeneration === generation
      && portalState.processTasksOwnerFingerprint === actorFingerprint
      && processTaskActorFingerprint(portalUser()) === actorFingerprint,
  );
}

function clearProcessTaskState({ resetAvailability = false, clearRequest = false } = {}) {
  portalState.processTasksRequestGeneration += 1;
  portalState.processTasks = [];
  portalState.processTaskSummary = null;
  portalState.processTasksLoading = false;
  portalState.processTasksLoadPromise = null;
  portalState.processTasksError = "";
  portalState.processTaskFlash = "";
  portalState.processTaskCompletionPending.clear();
  portalState.processTaskCompletionKeys.clear();
  portalState.processTaskCompletionPayloads.clear();
  portalState.processTaskNotes.clear();
  portalState.processTaskMessages.clear();
  portalState.processTaskRequestedRunId = "";
  portalState.processTaskRequestedStepId = "";
  if (resetAvailability) portalState.processTasksAvailable = true;
  if (clearRequest) clearProcessTaskRequest();
  if (el.refreshProcessTasks) el.refreshProcessTasks.disabled = false;
  renderProcessTasks();
}

function processTaskDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("de-AT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function clearProcessTaskRequest() {
  portalState.processTaskRequestedRunId = "";
  portalState.processTaskRequestedStepId = "";
  try {
    const url = new URL(location.href);
    url.searchParams.delete("run");
    url.searchParams.delete("step");
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {}
}

function openProcessTaskCount() {
  return portalState.processTasks.filter((task) => !["completed", "resolved", "cancelled"].includes(task.status)).length;
}

function renderProcessTasks() {
  const openCount = openProcessTaskCount();
  const runCount = new Set(portalState.processTasks.filter((task) => !["completed", "resolved", "cancelled"].includes(task.status)).map((task) => task.runId)).size;
  if (el.processTasksTabCount) {
    el.processTasksTabCount.textContent = openCount > 99 ? "99+" : String(openCount);
    el.processTasksTabCount.classList.toggle("hidden", openCount < 1);
  }
  if (el.processTaskSummary) {
    el.processTaskSummary.innerHTML = `<article><span>Offene Schritte</span><strong>${openCount}</strong></article><article><span>Laufende Prozesse</span><strong>${runCount}</strong></article>`;
  }
  if (!el.processTaskList) return;
  const requestedRunId = portalState.processTaskRequestedRunId;
  const requestedStepId = portalState.processTaskRequestedStepId;
  const requestedMissing = !portalState.processTasksLoading && requestedRunId && !portalState.processTasks.some((task) => task.runId === requestedRunId && (!requestedStepId || task.stepId === requestedStepId));
  const flash = portalState.processTaskFlash ? `<p class="message process-task-flash">${esc(portalState.processTaskFlash)}</p>` : "";
  const missing = requestedMissing ? '<p class="message">Diese Aufgabe ist nicht mehr offen oder wurde bereits von einer zuständigen Person erledigt.</p>' : "";
  const loadError = portalState.processTasksError ? `<div class="portal-card"><p class="message error">${esc(portalState.processTasksError)}</p></div>` : "";
  const tasks = portalState.processTasks.filter((task) => !["completed", "resolved", "cancelled"].includes(task.status));
  el.processTaskList.innerHTML = `${flash}${missing}${loadError || (tasks.length ? tasks.map((task) => {
    const pending = portalState.processTaskCompletionPending.has(task.key);
    const taskMessage = portalState.processTaskMessages.get(task.key) || "";
    const completionPayload = portalState.processTaskCompletionPayloads.get(task.key);
    const taskNote = completionPayload?.note ?? portalState.processTaskNotes.get(task.key) ?? "";
    const highlighted = task.runId === requestedRunId && (!requestedStepId || task.stepId === requestedStepId);
    const assigned = processTaskDateTime(task.assignedAt);
    const due = processTaskDateTime(task.dueAt);
    return `<article class="portal-card process-task-card ${highlighted ? "deep-linked" : ""}" data-process-task-key="${esc(task.key)}" data-process-run-id="${esc(task.runId)}" data-process-step-id="${esc(task.stepId)}">
      <header><span class="process-task-symbol">${esc(task.processSymbol)}</span><div><span class="eyebrow">Schritt ${task.position} von ${task.stepCount}</span><h2>${esc(task.stepTitle)}</h2><p>${esc(task.processTitle)} · ${esc(task.scopeLabel)}</p></div><span class="status ${task.canComplete ? "pending" : "returned"}">${task.canComplete ? "Bereit" : "Wartet"}</span></header>
      ${task.stepDescription ? `<p class="process-task-description">${esc(task.stepDescription)}</p>` : ""}
      ${task.conditionText ? `<aside class="process-task-condition"><strong>Gilt, wenn</strong><span>${esc(task.conditionText)}</span></aside>` : ""}
      ${(assigned || due) ? `<div class="process-task-meta">${assigned ? `<span>Zugewiesen ${esc(assigned)}</span>` : ""}${due ? `<span>Fällig ${esc(due)}</span>` : ""}</div>` : ""}
      <div class="process-task-completion ${task.canComplete ? "" : "hidden"}">${task.personnelWorkflow ? '<p class="settings-note">Der Abschluss wird in M5 ohne Notiz gespeichert.</p>' : `<label><span>Abschlussnotiz${task.completionNoteRequired ? " · erforderlich" : " · optional"}${completionPayload ? " · Wiederholung unverändert" : ""}</span><textarea data-process-task-note rows="2" maxlength="500" ${task.completionNoteRequired ? "required" : ""} ${completionPayload ? "disabled" : ""} placeholder="Kurze, sachliche Rückmeldung">${esc(taskNote)}</textarea></label>`}<button class="primary" data-complete-process-task type="button" ${pending ? "disabled" : ""}>${pending ? "Wird gespeichert …" : completionPayload ? "Erneut versuchen" : "Schritt erledigen"}</button></div>
      ${taskMessage ? `<p class="message error process-task-message">${esc(taskMessage)}</p>` : ""}
    </article>`;
  }).join("") : '<div class="portal-card process-task-empty"><span aria-hidden="true">✓</span><h2>Alles erledigt</h2><p>Derzeit ist dir kein offener Prozessschritt zugewiesen.</p></div>')}`;
  el.processTaskList.setAttribute("aria-busy", String(portalState.processTasksLoading));
  if (requestedRunId && portalState.activeTab === "processTasks") {
    requestAnimationFrame(() => {
      const target = [...el.processTaskList.querySelectorAll("[data-process-run-id]")].find((card) => card.dataset.processRunId === requestedRunId && (!requestedStepId || card.dataset.processStepId === requestedStepId));
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
  if (requestedMissing) clearProcessTaskRequest();
}

async function loadProcessTasks(options = {}) {
  const afterCurrent = options?.afterCurrent === true;
  if (!portalState.session) return;
  const currentActorFingerprint = processTaskActorFingerprint(portalUser());
  if (portalState.processTasksOwnerFingerprint !== currentActorFingerprint) {
    const previousOwner = portalState.processTasksOwnerFingerprint;
    clearProcessTaskState({
      resetAvailability: true,
      clearRequest: Boolean(previousOwner),
    });
    portalState.processTasksOwnerFingerprint = currentActorFingerprint;
  }
  if (!currentActorFingerprint || !portalState.processTasksAvailable) return;
  if (!portalTabAllowed("processTasks")) {
    const hasTaskState = portalState.processTasks.length > 0
      || portalState.processTaskSummary
      || portalState.processTasksLoading
      || portalState.processTasksError
      || portalState.processTaskCompletionPending.size > 0
      || portalState.processTaskCompletionKeys.size > 0
      || portalState.processTaskCompletionPayloads.size > 0
      || portalState.processTaskNotes.size > 0
      || portalState.processTaskMessages.size > 0;
    if (hasTaskState) clearProcessTaskState({ clearRequest: true });
    return;
  }
  if (portalState.processTasksLoading) {
    const waitingGeneration = portalState.processTasksRequestGeneration;
    const waitingActorFingerprint = portalState.processTasksOwnerFingerprint;
    const currentLoad = portalState.processTasksLoadPromise;
    if (!afterCurrent) return currentLoad;
    if (currentLoad) await currentLoad;
    if (!processTaskRequestContextCurrent(waitingGeneration, waitingActorFingerprint)
        || !portalState.processTasksAvailable
        || !portalTabAllowed("processTasks")) return;
    return loadProcessTasks();
  }
  const requestGeneration = portalState.processTasksRequestGeneration;
  const actorFingerprint = portalState.processTasksOwnerFingerprint;
  portalState.processTasksLoading = true;
  if (el.refreshProcessTasks) el.refreshProcessTasks.disabled = true;
  el.processTaskList?.setAttribute("aria-busy", "true");
  const request = (async () => {
    try {
      portalState.processTasksError = "";
      const data = await api("/api/portal/v1/me/process-tasks");
      if (!processTaskRequestContextCurrent(requestGeneration, actorFingerprint)) return;
      if (data?.available === false) {
        portalState.processTasksAvailable = false;
        clearProcessTaskState({ clearRequest: true });
        el.processTasksTab?.classList.add("hidden");
        if (portalState.activeTab === "processTasks") setTab("schedule");
        return;
      }
      portalState.processTasks = (Array.isArray(data?.tasks) ? data.tasks : Array.isArray(data?.items) ? data.items : []).map(normalizeProcessTask)
        .filter((task) => task.runId && task.stepId)
        .sort((left, right) => String(left.assignedAt).localeCompare(String(right.assignedAt)) || left.position - right.position);
      const activeKeys = new Set(portalState.processTasks.map((task) => task.key));
      [portalState.processTaskNotes, portalState.processTaskMessages, portalState.processTaskCompletionKeys, portalState.processTaskCompletionPayloads].forEach((entries) => {
        for (const key of entries.keys()) if (!activeKeys.has(key)) entries.delete(key);
      });
      portalState.processTaskSummary = normalizeProcessTaskSummary(data?.summary);
      portalState.processTasksAvailable = true;
      el.processTasksTab?.classList.toggle("hidden", !portalTabAllowed("processTasks"));
    } catch (error) {
      if (!processTaskRequestContextCurrent(requestGeneration, actorFingerprint)) return;
      if ([403, 404].includes(error.status)) {
        portalState.processTasksAvailable = false;
        clearProcessTaskState({ clearRequest: true });
        el.processTasksTab?.classList.add("hidden");
        if (portalState.activeTab === "processTasks") setTab("schedule");
      } else portalState.processTasksError = error.message;
    } finally {
      if (!processTaskRequestContextCurrent(requestGeneration, actorFingerprint)) return;
      portalState.processTasksLoading = false;
      if (el.refreshProcessTasks) el.refreshProcessTasks.disabled = false;
      renderProcessTasks();
    }
  })();
  portalState.processTasksLoadPromise = request;
  try {
    return await request;
  } finally {
    if (portalState.processTasksLoadPromise === request) portalState.processTasksLoadPromise = null;
  }
}

async function completeProcessTask(task, card) {
  if (!task?.canComplete || portalState.processTaskCompletionPending.has(task.key)) return;
  const requestGeneration = portalState.processTasksRequestGeneration;
  const actorFingerprint = portalState.processTasksOwnerFingerprint;
  if (!processTaskRequestContextCurrent(requestGeneration, actorFingerprint)
      || !portalTabAllowed("processTasks")
      || !portalState.processTasks.some((entry) => entry.key === task.key)) return;
  const previousPayload = portalState.processTaskCompletionPayloads.get(task.key);
  const note = task.personnelWorkflow
    ? ""
    : previousPayload?.note ?? String(card?.querySelector("[data-process-task-note]")?.value || "").trim();
  if (task.completionNoteRequired && !note) {
    portalState.processTaskMessages.set(task.key, "Bitte eine kurze Abschlussnotiz eintragen.");
    renderProcessTasks();
    return;
  }
  const existingKey = portalState.processTaskCompletionKeys.get(task.key);
  const generatedUuid = globalThis.crypto?.randomUUID?.() || "";
  if (task.personnelWorkflow && !existingKey && !generatedUuid) {
    portalState.processTaskMessages.set(
      task.key,
      "Dieser Browser kann keine sichere Vorgangs-ID erzeugen. Bitte aktualisieren oder einen anderen Browser verwenden.",
    );
    renderProcessTasks();
    return;
  }
  const idempotencyKey = existingKey
    || generatedUuid
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  portalState.processTaskCompletionKeys.set(task.key, idempotencyKey);
  portalState.processTaskCompletionPayloads.set(task.key, { idempotencyKey, note });
  portalState.processTaskCompletionPending.add(task.key);
  portalState.processTaskMessages.delete(task.key);
  portalState.processTaskFlash = "";
  renderProcessTasks();
  try {
    const options = task.personnelWorkflow
      ? {
        method: "POST",
        body: JSON.stringify({ action: "complete", operationId: idempotencyKey }),
      }
      : {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ idempotencyKey, note, activationCount: task.activationCount }),
      };
    await api(
      `/api/portal/v1/me/process-tasks/${encodeURIComponent(task.runId)}/${encodeURIComponent(task.stepId)}/complete`,
      options,
    );
    if (!processTaskRequestContextCurrent(requestGeneration, actorFingerprint)) return;
    portalState.processTaskCompletionKeys.delete(task.key);
    portalState.processTaskCompletionPayloads.delete(task.key);
    portalState.processTaskNotes.delete(task.key);
    if (portalState.processTaskRequestedRunId === task.runId
        && (!portalState.processTaskRequestedStepId || portalState.processTaskRequestedStepId === task.stepId)) {
      clearProcessTaskRequest();
    }
    portalState.processTaskFlash = "Der Arbeitsschritt wurde nachvollziehbar abgeschlossen.";
    await Promise.allSettled([loadProcessTasks({ afterCurrent: true }), loadNotifications()]);
  } catch (error) {
    if (!processTaskRequestContextCurrent(requestGeneration, actorFingerprint)) return;
    portalState.processTaskMessages.set(task.key, `${error.message} Beim erneuten Versuch wird dieselbe Vorgangs-ID verwendet.`);
  } finally {
    if (!processTaskRequestContextCurrent(requestGeneration, actorFingerprint)) return;
    portalState.processTaskCompletionPending.delete(task.key);
    renderProcessTasks();
  }
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

function sicknessStatusText(item) {
  if (item.status === "withdrawn") return "Zurückgezogen";
  if (item.status === "recovered") return item.return_to_work_date
    ? `Wieder arbeitsfähig ab ${dateText(item.return_to_work_date)}` : "Wieder arbeitsfähig";
  if (item.status === "aum_received") return "AUM vorhanden";
  if (item.aum_allowance?.required === false) return "Ohne AUM zulässig";
  if (item.severity === "red") return "AUM-Frist überschritten";
  if (item.severity === "yellow") return "AUM überfällig";
  if (item.staffing_risk?.atRisk) return "Besetzung wird geprüft";
  return "Gemeldet";
}

function renderSicknessCases() {
  const attachableCases = portalState.sicknessCases.filter((item) => ["reported", "aum_received", "recovered"].includes(item.status));
  el.sicknessCaseList.innerHTML = portalState.sicknessCases.length ? portalState.sicknessCases.map((item) => {
    const period = `${dateText(item.start_date)}${item.expected_end ? `–${dateText(item.expected_end)}` : item.status === "recovered" ? " · abgeschlossen" : " · Ende offen"}`;
    const canWithdraw = item.status === "reported" && !item.aum_received_at;
    const canReturn = ["reported", "aum_received"].includes(item.status);
    const canAttach = item.status !== "withdrawn";
    const reports = portalState.amuReports.filter((report) => Number(report.sickness_case_id || 0) === Number(item.id));
    const risk = item.staffing_risk?.atRisk ? '<span class="sickness-risk-note">Mindestbesetzung wird durch die Leitung geprüft</span>' : "";
    const reportNote = reports.length ? `<span>${reports.length} ${reports.length === 1 ? "AUM" : "AUMs"} verschlüsselt hinterlegt</span>` : "";
    const creditedMinutes = Number(item.sickness_valuation?.total_minutes || 0);
    const creditNote = creditedMinutes > 0 ? `<span>Angerechnete Krankenstandszeit: ${esc(durationText(creditedMinutes))}</span>` : "";
    const actions = [
      canAttach ? '<button class="text-button" data-add-amu type="button">AUM nachreichen</button>' : "",
      canReturn ? '<button class="text-button" data-recover-sickness type="button">Arbeitsfähigkeit melden</button>' : "",
      canWithdraw ? '<button class="cancel-request" data-withdraw-sickness type="button">Zurückziehen</button>' : "",
    ].filter(Boolean).join("");
    return `<article class="request-item sickness-case" data-sickness-case-id="${Number(item.id)}"><div><strong>${esc(period)}</strong>${item.employee_note ? `<span>${esc(item.employee_note)}</span>` : ""}${reportNote}${creditNote}${risk}<span class="status ${esc(item.severity || item.status)}">${esc(sicknessStatusText(item))}</span></div>${actions ? `<div class="sickness-case-actions">${actions}</div>` : ""}</article>`;
  }).join("") : '<p class="empty-state">Noch keine Krankmeldung vorhanden.</p>';
  const currentValue = el.amuSicknessCaseId.value;
  el.amuSicknessCaseId.innerHTML = '<option value="">Automatisch zuordnen</option>' + attachableCases.map((item) => `<option value="${Number(item.id)}">${dateText(item.start_date)}${item.expected_end ? `–${dateText(item.expected_end)}` : " · Ende offen"}${item.status === "recovered" ? " · abgeschlossen" : ""}</option>`).join("");
  if ([...el.amuSicknessCaseId.options].some((option) => option.value === currentValue)) el.amuSicknessCaseId.value = currentValue;
}

async function loadSicknessCases() {
  try {
    const data = await api("/api/portal/v1/me/sickness-cases");
    portalState.sicknessCases = data.cases || [];
    portalState.sicknessAumAllowance = data.aumAllowance || null;
    renderSicknessCases();
    renderSicknessAumAllowance();
  } catch (error) {
    el.sicknessCaseList.innerHTML = `<p class="message error">${esc(error.message)}</p>`;
  }
}

async function submitSicknessCase(event) {
  event.preventDefault();
  const startDate = el.sicknessStartDate.value;
  const expectedEnd = el.sicknessExpectedEnd.value;
  if (!startDate) {
    message(el.sicknessMessage, "Bitte den Beginn der Krankmeldung im Kalender auswählen.", true);
    return;
  }
  if (expectedEnd && expectedEnd < startDate) {
    message(el.sicknessMessage, "Das voraussichtliche Ende darf nicht vor dem Beginn liegen.", true);
    return;
  }
  el.sicknessSubmitButton.disabled = true;
  try {
    const directDocuments = selectedAmuFiles("sickness");
    if (directDocuments.length) {
      await uploadAmuForContext("sickness", {
        sicknessCaseId: "",
        employeeNote: el.sicknessEmployeeNote.value,
        sicknessNote: el.sicknessEmployeeNote.value,
        messageElement: el.sicknessMessage,
      });
      el.sicknessCaseForm.reset();
      el.sicknessStartDate.value = iso(new Date());
      el.sicknessExpectedEnd.value = "";
      resetAmuOcrState("sickness");
      updateSicknessRangeControls();
      message(el.sicknessMessage, "Krankmeldung und AUM wurden gemeinsam übermittelt. Das Dokument ist geschützt gespeichert.");
      await Promise.allSettled([loadSicknessCases(), loadAmuReports(), loadNotifications()]);
      return;
    }
    const result = await api("/api/portal/v1/me/sickness-cases", {
      method: "POST",
      body: JSON.stringify({ startDate, expectedEnd, note: el.sicknessEmployeeNote.value }),
    });
    el.sicknessCaseForm.reset();
    el.sicknessStartDate.value = iso(new Date());
    el.sicknessExpectedEnd.value = "";
    updateSicknessRangeControls();
    message(el.sicknessMessage, result.case?.staffing_risk?.atRisk
      ? "Die Krankmeldung wurde gesendet. Die Leitung wurde auch auf die mögliche Unterschreitung der Mindestbesetzung hingewiesen."
      : "Die Krankmeldung wurde gesendet und die zuständige Leitung informiert.");
    await Promise.allSettled([loadSicknessCases(), loadNotifications()]);
  } catch (error) {
    if (!error.handled) message(el.sicknessMessage, error.message, true);
  } finally {
    el.sicknessSubmitButton.disabled = false;
  }
}

async function withdrawSicknessCase(id) {
  if (!confirm("Diese Krankmeldung wirklich zurückziehen?")) return;
  try {
    await api(`/api/portal/v1/me/sickness-cases/${encodeURIComponent(String(id))}/withdraw`, { method: "POST", body: "{}" });
    await Promise.allSettled([loadSicknessCases(), loadNotifications()]);
  } catch (error) {
    message(el.sicknessMessage, error.message, true);
  }
}

function selectSicknessCaseForAmu() {
  resetAmuOcrState({ clearAutoFilled: true });
  const selected = portalState.sicknessCases.find((item) => String(item.id) === el.amuSicknessCaseId.value);
  if (!selected) {
    el.amuIncapacityFrom.value = "";
    el.amuIncapacityTo.value = "";
    el.amuIncapacityTo.min = addDays(iso(new Date()), -3650);
    updateSicknessRangeControls();
    return;
  }
  el.amuIncapacityFrom.value = selected.start_date || "";
  el.amuIncapacityTo.min = selected.start_date || el.amuIncapacityTo.min;
  el.amuIncapacityTo.value = selected.expected_end || "";
  portalState.amuOcr.startManuallyEdited = false;
  portalState.amuOcr.endManuallyEdited = false;
  updateSicknessRangeControls();
}

function openAmuForSicknessCase(id) {
  el.amuSicknessCaseId.value = String(id);
  selectSicknessCaseForAmu();
  el.amuUploadPanel.open = true;
  el.amuUploadPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => el.amuDateRangeButton?.focus(), 350);
}

function openSicknessRecovery(id) {
  const item = portalState.sicknessCases.find((entry) => Number(entry.id) === Number(id));
  if (!item) return;
  el.sicknessRecoveryCaseId.value = String(item.id);
  el.sicknessRecoveryDate.min = item.start_date;
  el.sicknessRecoveryDate.max = addDays(iso(new Date()), 31);
  el.sicknessRecoveryDate.value = item.return_to_work_date || iso(new Date());
  message(el.sicknessRecoveryMessage, "");
  el.sicknessRecoveryDialog.showModal();
}

async function submitSicknessRecovery(event) {
  event.preventDefault();
  const id = el.sicknessRecoveryCaseId.value;
  el.sicknessRecoverySubmit.disabled = true;
  try {
    await api(`/api/portal/v1/me/sickness-cases/${encodeURIComponent(id)}/return-to-work`, {
      method: "POST",
      body: JSON.stringify({ returnDate: el.sicknessRecoveryDate.value }),
    });
    el.sicknessRecoveryDialog.close();
    message(el.sicknessMessage, "Die Arbeitsfähigkeit wurde gemeldet. Die zuständige Leitung wurde informiert.");
    await Promise.allSettled([loadSicknessCases(), loadNotifications()]);
  } catch (error) {
    message(el.sicknessRecoveryMessage, error.message, true);
  } finally {
    el.sicknessRecoverySubmit.disabled = false;
  }
}

let amuOcrClient = null;
let amuPdfClient = null;

function amuOcrContext(contextName = "amu") {
  const sickness = contextName === "sickness";
  return {
    name: sickness ? "sickness" : "amu",
    stateKey: sickness ? "sicknessAmuOcr" : "amuOcr",
    from: sickness ? el.sicknessStartDate : el.amuIncapacityFrom,
    to: sickness ? el.sicknessExpectedEnd : el.amuIncapacityTo,
    documents: sickness ? el.sicknessAmuDocuments : el.amuDocuments,
    camera: sickness ? el.sicknessAmuCamera : el.amuCamera,
    status: sickness ? el.sicknessAmuOcrStatus : el.amuOcrStatus,
    statusTitle: sickness ? el.sicknessAmuOcrStatusTitle : el.amuOcrStatusTitle,
    statusText: sickness ? el.sicknessAmuOcrStatusText : el.amuOcrStatusText,
    confirmField: sickness ? el.sicknessAmuOcrConfirmField : el.amuOcrConfirmField,
    confirmed: sickness ? el.sicknessAmuOcrConfirmed : el.amuOcrConfirmed,
  };
}

function renderSicknessAumAllowance() {
  if (!el.sicknessAumAllowance) return;
  const allowance = portalState.sicknessAumAllowance;
  if (!allowance || allowance.enabled !== true) {
    el.sicknessAumAllowance.classList.add("hidden");
    el.sicknessAumAllowance.textContent = "";
    return;
  }
  el.sicknessAumAllowance.classList.remove("hidden");
  if (allowance.eligible) {
    el.sicknessAumAllowance.textContent = `Ohne AUM möglich · noch ${allowance.remainingCases} von ${allowance.maxCasesPerYear} Fällen verfügbar · maximal ${allowance.maxCalendarDaysPerCase} Kalendertag${allowance.maxCalendarDaysPerCase === 1 ? "" : "e"} je Fall.`;
  } else if (allowance.reason === "quota_exhausted") {
    el.sicknessAumAllowance.textContent = `AUM erforderlich · das Kontingent für ${allowance.policyYear} ist ausgeschöpft.`;
  } else {
    el.sicknessAumAllowance.textContent = "AUM laut aktueller Unternehmensregel erforderlich.";
  }
}

function updateAmuOcrStatus(contextName, title, text, state = "working") {
  const ui = amuOcrContext(contextName);
  if (!ui.status) return;
  ui.status.classList.remove("hidden", "working", "success", "warning", "error");
  ui.status.classList.add(state);
  ui.statusTitle.textContent = title;
  ui.statusText.textContent = text;
}

function resetAmuOcrState(contextName = "amu", options = {}) {
  if (typeof contextName === "object") {
    options = contextName;
    contextName = "amu";
  }
  const { keepStatus = false, preserveManual = false, clearAutoFilled = false } = options;
  const ui = amuOcrContext(contextName);
  const previous = portalState[ui.stateKey] || {};
  if (clearAutoFilled) {
    if (previous.autoFilledStart && !previous.startManuallyEdited) ui.from.value = "";
    if (previous.autoFilledEnd && !previous.endManuallyEdited) ui.to.value = "";
  }
  portalState[ui.stateKey] = {
    busy: false,
    assisted: false,
    startManuallyEdited: preserveManual && previous.startManuallyEdited === true,
    endManuallyEdited: preserveManual && previous.endManuallyEdited === true,
    autoFilledStart: false,
    autoFilledEnd: false,
    identityDetected: false,
    fileKey: "",
    runToken: Number(previous.runToken || 0) + 1,
  };
  ui.confirmed.checked = false;
  ui.confirmField.classList.add("hidden");
  if (!keepStatus) ui.status.classList.add("hidden");
  updateSicknessRangeControls();
}

function ocrProgressLabel(status, progress) {
  const labels = {
    "loading tesseract core": "Texterkennung wird vorbereitet",
    "initializing tesseract": "Texterkennung wird gestartet",
    "loading language traineddata": "Deutsches Sprachmodell wird geladen",
    "initializing api": "Dokument wird vorbereitet",
    "recognizing text": "Beginn und Ende werden gesucht",
  };
  const percentage = Number.isFinite(progress) ? ` · ${Math.round(progress * 100)} %` : "";
  return `${labels[status] || "Lokale Datenerkennung läuft"}${percentage}`;
}

function ensureAmuOcrClient() {
  if (amuOcrClient) return amuOcrClient;
  amuOcrClient = window.GrabenplanerAmuOcrClient.createAmuOcrClient({
    onProgress({ status, progress }) {
      const contextName = portalState.activeAmuOcrContext || "amu";
      const state = portalState[amuOcrContext(contextName).stateKey];
      if (!state?.busy) return;
      updateAmuOcrStatus(contextName, "Lokale Datenerkennung", ocrProgressLabel(status, progress), "working");
    },
  });
  return amuOcrClient;
}

function ensureAmuPdfClient() {
  if (amuPdfClient) return amuPdfClient;
  amuPdfClient = window.GrabenplanerAmuPdfClient.createAmuPdfClient({
    limits: { maxFileBytes: Number(portalState.amuPolicy?.uploadMaxMb || 10) * 1024 * 1024 },
    recognizeCanvas(canvas, context) {
      return ensureAmuOcrClient().recognize(canvas, { referenceDate: context.referenceDate });
    },
    onProgress({ event, pageNumber, pageCount }) {
      const contextName = portalState.activeAmuOcrContext || "amu";
      const state = portalState[amuOcrContext(contextName).stateKey];
      if (!state?.busy) return;
      const labels = {
        loading: "PDF wird lokal geöffnet",
        extracting_text: "PDF-Text wird lokal geprüft",
        rendering: "PDF-Seite wird lokal vorbereitet",
        recognizing: "PDF-Seite wird lokal erkannt",
      };
      const pages = pageNumber && pageCount ? ` · Seite ${pageNumber} von ${pageCount}` : "";
      updateAmuOcrStatus(contextName, "Lokale PDF-Erkennung", `${labels[event] || "PDF wird lokal ausgewertet"}${pages}`, "working");
    },
  });
  return amuPdfClient;
}

function isPdfFile(file) {
  return String(file?.type || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(String(file?.name || ""));
}

function isImageFile(file) {
  return String(file?.type || "").startsWith("image/") || /\.(?:jpe?g|png|webp|tiff?)$/i.test(String(file?.name || ""));
}

async function recognizeAmuFiles(files, contextName = "amu") {
  const ui = amuOcrContext(contextName);
  const state = portalState[ui.stateKey];
  const documents = [...files].filter((file) => isImageFile(file) || isPdfFile(file)).slice(0, 3);
  if (!documents.length || portalState.status?.capabilities?.localAmuOcr !== true
    || portalState.amuPolicy?.ocrEnabled !== true) return;
  const fileKey = documents.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join("|");
  const runToken = Number(state.runToken || 0) + 1;
  state.fileKey = fileKey;
  state.runToken = runToken;
  state.busy = true;
  portalState.activeAmuOcrContext = ui.name;
  updateAmuOcrStatus(ui.name, "Lokale Datenerkennung", "Foto oder PDF wird nur auf diesem Gerät ausgewertet. Beim Senden wird das Dokument an Grabenplaner übertragen, geprüft und verschlüsselt gespeichert.", "working");
  try {
    const results = [];
    for (const file of documents) {
      if (state.fileKey !== fileKey || state.runToken !== runToken) return;
      const result = isPdfFile(file)
        ? await ensureAmuPdfClient().recognize(file, { referenceDate: iso(new Date()) })
        : await ensureAmuOcrClient().recognize(file, { referenceDate: iso(new Date()) });
      results.push(result);
      if (result.complete && result.autoFill && result.socialSecurityStatus === "detected") break;
    }
    if (state.fileKey !== fileKey || state.runToken !== runToken) return;
    const result = window.GrabenplanerAmuOcrClient.mergeAumOcrResults(results);
    let applied = false;
    if (result.dateFrom && result.autoFillFields?.dateFrom && !state.startManuallyEdited) {
      ui.from.value = result.dateFrom;
      state.autoFilledStart = true;
      applied = true;
    }
    if (result.dateTo && result.autoFillFields?.dateTo && !state.endManuallyEdited) {
      ui.to.value = result.dateTo;
      state.autoFilledEnd = true;
      applied = true;
    }
    ui.to.min = ui.from.value || ui.to.min;
    state.assisted = applied;
    state.identityDetected = result.socialSecurityStatus === "detected";
    updateSicknessRangeControls();
    const identityText = state.identityDetected
      ? "SV-Angabe lokal erkannt; der geschützte Abgleich erfolgt beim Senden."
      : "SV-Angabe nicht eindeutig erkannt; die Personalleitung kann den Fall manuell prüfen.";
    if (applied) {
      ui.confirmField.classList.remove("hidden");
      const period = result.dateTo
        ? `${dateText(result.dateFrom)} bis ${dateText(result.dateTo)}`
        : `${dateText(result.dateFrom)} · Ende nicht angegeben`;
      updateAmuOcrStatus(ui.name, result.dateTo ? "Datumswerte erkannt" : "Beginn erkannt", `${period} · ${identityText} Bitte Datumswerte vor dem Senden prüfen.`, "success");
    } else if (!result.dateFrom && !result.dateTo) {
      updateAmuOcrStatus(ui.name, state.identityDetected ? "SV-Angabe erkannt" : "Keine eindeutigen Werte erkannt", `${identityText} Bitte den Beginn im Zeitraumskalender eintragen. Das Ende darf offenbleiben.`, state.identityDetected ? "success" : "warning");
    } else {
      const explanation = state.startManuallyEdited || state.endManuallyEdited
        ? "Manuelle Eingaben wurden nicht überschrieben."
        : "Die Erkennung ist für ein automatisches Eintragen nicht eindeutig genug; bitte Werte manuell prüfen.";
      const detected = [result.dateFrom ? `Beginn ${dateText(result.dateFrom)}` : "", result.dateTo ? `Ende ${dateText(result.dateTo)}` : ""].filter(Boolean).join(" · ");
      updateAmuOcrStatus(ui.name, "Datumswerte gefunden", `${detected} · ${explanation} ${identityText}`, "warning");
    }
  } catch (error) {
    if (state.fileKey === fileKey && state.runToken === runToken) {
      const cancelled = error?.code === "AMU_PDF_ABORTED";
      if (!cancelled) updateAmuOcrStatus(ui.name, "Datenerkennung nicht verfügbar", "Bitte den Beginn manuell eintragen. Foto oder PDF kann trotzdem hochgeladen und durch die Personalleitung geprüft werden.", "error");
    }
  } finally {
    if (state.fileKey === fileKey && state.runToken === runToken) state.busy = false;
  }
}

function handleAmuFileSelection(event) {
  if (portalState.session && portalState.activeTab !== "amu") setTab("amu");
  const contextName = event.currentTarget.dataset.amuContext === "sickness" ? "sickness" : "amu";
  const ui = amuOcrContext(contextName);
  void amuPdfClient?.cancel?.();
  resetAmuOcrState(contextName, { preserveManual: true, clearAutoFilled: true });
  const currentFiles = [...(event.currentTarget.files || [])];
  const remainingFiles = event.currentTarget === ui.camera
    ? [...(ui.documents?.files || [])]
    : [...(ui.camera?.files || [])];
  const files = [...currentFiles, ...remainingFiles];
  if (files.length) recognizeAmuFiles(files, contextName);
}

const personalNotificationChannels = Object.freeze(["email", "sms", "whatsapp"]);

function channelLabel(channel) {
  return ({ email: "E-Mail", sms: "SMS", whatsapp: "WhatsApp" })[channel] || channel;
}

function notificationTargetKey(channel) {
  return channel === "email" ? "email" : "phone";
}

function notificationTarget(data, targetKey) {
  const targets = data?.targets && typeof data.targets === "object" ? data.targets : {};
  if (targets[targetKey] && typeof targets[targetKey] === "object") return targets[targetKey];
  if (targetKey === "email" && data?.address && typeof data.address === "object") return data.address;
  return {};
}

function notificationTargetMasked(target) {
  return String(target?.masked || "").trim();
}

function notificationTargetState(target) {
  const status = String(target?.status || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (target?.verifiedAt || ["verified", "confirmed", "bestätigt"].includes(status)) return "verified";
  if (["pending", "unverified", "verification_pending", "confirmation_pending"].includes(status)) return "pending";
  if (target?.available === false && notificationTargetMasked(target)) return "unavailable";
  return "missing";
}

function notificationTargetStatusText(state) {
  return ({
    verified: "Bestätigt",
    pending: "Bestätigung ausständig",
    unavailable: "Nicht verfügbar",
    missing: "Nicht hinterlegt",
  })[state] || "Nicht verfügbar";
}

function notificationChannelPreference(data, channel) {
  const raw = data?.channels?.[channel] && typeof data.channels[channel] === "object"
    ? data.channels[channel]
    : {};
  const target = notificationTarget(data, notificationTargetKey(channel));
  const targetState = notificationTargetState(target);
  const masked = notificationTargetMasked(target);
  const selectable = raw.selectable === true || (raw.selectable !== false && Boolean(masked));
  const deliveryReady = selectable
    && targetState === "verified"
    && raw.verificationRequired !== true
    && (raw.deliveryReady === true || raw.available === true);
  return {
    enabled: selectable && raw.enabled === true,
    selectable,
    deliveryReady,
    masked,
    targetState,
    verificationRequired: raw.verificationRequired === true,
    verificationAvailable: raw.verificationAvailable === true,
  };
}

function notificationQuietHoursEditable(data = portalState.emailSettings) {
  return hasPortalPermission("notifications:settings") && data?.quietHours?.editable === true;
}

function emailCategoryItems(data = portalState.emailSettings) {
  if (Array.isArray(data?.categories)) return data.categories;
  if (Array.isArray(data?.categories?.items)) return data.categories.items;
  return [];
}

function notificationEarliestTime(data = portalState.emailSettings) {
  const value = String(data?.quietHours?.earliestTime || "08:00");
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : "08:00";
}

function notificationVerificationChannels(targetKey) {
  return targetKey === "email" ? ["email"] : ["sms", "whatsapp"];
}

function notificationVerificationMarkup(data, targetKey) {
  const target = notificationTarget(data, targetKey);
  const masked = notificationTargetMasked(target);
  if (!masked || notificationTargetState(target) === "verified") return "";

  const selectableChannels = notificationVerificationChannels(targetKey).filter((channel) => {
    const raw = data?.channels?.[channel];
    return raw?.selectable === true || (raw?.selectable !== false && Boolean(masked));
  });
  if (!selectableChannels.length) return "";

  const verification = data?.verification && typeof data.verification === "object"
    ? data.verification
    : {};
  const activeChannel = selectableChannels.includes(verification.channel) && verification.required === true
    ? verification.channel
    : "";
  if (activeChannel) {
    const resendAvailable = data?.channels?.[activeChannel]?.verificationAvailable === true;
    return `<div class="notification-target-verification" data-notification-verification="${esc(targetKey)}">
      <p>Code für ${esc(channelLabel(activeChannel))} eingeben. Das Ziel bleibt unveränderbar.</p>
      <div class="notification-verification-code">
        <label><span>Sechsstelliger Bestätigungscode</span><input type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="000000" data-notification-verification-code /></label>
        <button class="primary" type="button" data-notification-verification-confirm="${esc(activeChannel)}">Bestätigen</button>
      </div>
      ${resendAvailable ? `<button class="text-button notification-verification-resend" type="button" data-notification-verification-request="${esc(activeChannel)}">Code erneut anfordern</button>` : ""}
    </div>`;
  }

  const candidates = selectableChannels.filter((channel) => {
    const raw = data?.channels?.[channel];
    return raw?.verificationRequired === true && raw?.verificationAvailable === true;
  });
  if (!candidates.length) {
    return `<div class="notification-target-verification unavailable" data-notification-verification="${esc(targetKey)}"><p>Die Bestätigung ist derzeit technisch nicht verfügbar.</p></div>`;
  }

  return `<div class="notification-target-verification" data-notification-verification="${esc(targetKey)}">
    <p>Dieses Stammdatenziel muss einmalig bestätigt werden.</p>
    <div class="notification-verification-actions">${candidates.map((channel) => `<button class="text-button" type="button" data-notification-verification-request="${esc(channel)}">Code per ${esc(channelLabel(channel))} anfordern</button>`).join("")}</div>
  </div>`;
}

function renderEmailSettings() {
  const data = portalState.emailSettings || {};
  const targets = [
    { key: "email", label: "E-Mail" },
    { key: "phone", label: "Telefon · für SMS und WhatsApp" },
  ];
  el.notificationTargetList.innerHTML = targets.map(({ key, label }) => {
    const target = notificationTarget(data, key);
    const state = notificationTargetState(target);
    const masked = notificationTargetMasked(target);
    return `<div class="notification-target-row" data-notification-target="${esc(key)}">
      <div><strong>${esc(label)}</strong><small>${esc(masked || "Nicht in den Personalstammdaten hinterlegt")}</small></div>
      <span class="verification-status ${esc(state)}">${esc(notificationTargetStatusText(state))}</span>
      ${notificationVerificationMarkup(data, key)}
    </div>`;
  }).join("");

  const preferences = personalNotificationChannels.map((channel) => ({
    channel,
    ...notificationChannelPreference(data, channel),
  }));
  el.notificationChannelSelection.innerHTML = preferences.map((preference) => {
    const reason = !preference.selectable
      ? "Kein Ziel in den Personalstammdaten"
      : !preference.enabled
        ? `${preference.masked} · Auswahl möglich`
        : preference.targetState === "pending" || preference.verificationRequired
          ? "Ausgewählt · Ziel noch nicht bestätigt"
          : !preference.deliveryReady
            ? "Ausgewählt · Versand noch nicht verfügbar"
            : preference.masked;
    return `<label class="notification-channel-choice ${preference.selectable ? "" : "unavailable"} ${preference.deliveryReady ? "delivery-ready" : "delivery-pending"}" data-notification-channel="${esc(preference.channel)}">
      <span><strong>${esc(channelLabel(preference.channel))}</strong><small>${esc(reason)}</small></span>
      <input type="checkbox" data-notification-channel-enabled ${preference.enabled ? "checked" : ""} ${preference.selectable ? "" : "disabled"} />
    </label>`;
  }).join("");

  const selectedCount = preferences.filter((preference) => preference.enabled).length;
  const readyCount = preferences.filter((preference) => preference.enabled && preference.deliveryReady).length;
  el.emailSettingsSummary.textContent = selectedCount
    ? `${selectedCount} Kanäle vorgemerkt · ${readyCount} versandbereit`
    : "Keine externen Kanäle ausgewählt";

  const earliestTime = notificationEarliestTime(data);
  const quietHoursEditable = notificationQuietHoursEditable(data);
  el.notificationEarliestTime.value = earliestTime;
  el.notificationEarliestTime.disabled = !quietHoursEditable;
  el.notificationQuietHoursBadge.textContent = `Ruhezeit bis ${earliestTime} Uhr`;
  el.notificationQuietHoursHint.textContent = quietHoursEditable
    ? "Für deine Rolle persönlich anpassbar"
    : "Zentral vorgegeben · nur lesbar";

  const categories = emailCategoryItems(data);
  if (!categories.length) {
    el.emailCategoryList.innerHTML = `<div class="email-category-row"><div><strong>Fachereignisse</strong><small>Die Auswahl wird in einem späteren Schritt freigeschaltet.</small></div><span>Noch nicht aktiviert</span></div>`;
    return;
  }
  el.emailCategoryList.innerHTML = categories.map((category) => `
    <div class="email-category-row" data-email-category="${esc(category.id || "")}">
      <div><strong>${esc(category.label || category.title || category.id || "Benachrichtigung")}</strong>${category.description ? `<small>${esc(category.description)}</small>` : ""}</div>
      <span>Noch nicht aktiviert</span>
    </div>
  `).join("");
}

function emailSettingsResponsePayload(result) {
  if (result?.settings && typeof result.settings === "object") return result.settings;
  if (result && typeof result === "object"
    && (result.targets || result.channels || result.quietHours || result.categories || result.address)) return result;
  return null;
}

async function loadEmailSettings({ force = false } = {}) {
  if (!personalEmailSettingsAvailable()) return;
  if (portalState.emailSettingsLoading && !force) return;
  portalState.emailSettingsLoading = true;
  try {
    const result = await api("/api/portal/v1/me/email-settings");
    portalState.emailSettings = emailSettingsResponsePayload(result) || {};
    renderEmailSettings();
    message(el.emailSettingsMessage, "");
  } catch (error) {
    if (!portalState.emailSettings) {
      el.emailSettingsSummary.textContent = "Derzeit nicht verfügbar";
      el.notificationTargetList.innerHTML = `<p class="empty-state">Zustellziele konnten nicht geladen werden.</p>`;
      el.notificationChannelSelection.innerHTML = `<p class="empty-state">Kanäle konnten nicht geladen werden.</p>`;
      el.emailCategoryList.innerHTML = `<p class="empty-state">Die Kategorien konnten nicht geladen werden.</p>`;
    }
    message(el.emailSettingsMessage, error.message, true);
  } finally {
    portalState.emailSettingsLoading = false;
  }
}

async function requestNotificationVerification(button) {
  const channel = String(button?.dataset.notificationVerificationRequest || "");
  if (!personalNotificationChannels.includes(channel)) return;
  button.disabled = true;
  message(el.emailSettingsMessage, "");
  try {
    const result = await api("/api/portal/v1/me/email-settings/verification", {
      method: "POST",
      body: JSON.stringify({ channel }),
    });
    portalState.emailSettings = emailSettingsResponsePayload(result) || portalState.emailSettings || {};
    renderEmailSettings();
    message(el.emailSettingsMessage, `Der Bestätigungscode für ${channelLabel(channel)} wurde angefordert.`);
    el.notificationTargetList.querySelector("[data-notification-verification-code]")?.focus();
  } catch (error) {
    message(el.emailSettingsMessage, error.message, true);
    button.disabled = false;
  }
}

async function confirmNotificationVerification(button) {
  const channel = String(button?.dataset.notificationVerificationConfirm || "");
  if (!personalNotificationChannels.includes(channel)) return;
  const container = button.closest("[data-notification-verification]");
  const codeInput = container?.querySelector("[data-notification-verification-code]");
  const code = String(codeInput?.value || "").trim();
  if (!/^\d{6}$/.test(code)) {
    message(el.emailSettingsMessage, "Bitte den sechsstelligen Bestätigungscode vollständig eingeben.", true);
    codeInput?.focus();
    return;
  }
  button.disabled = true;
  message(el.emailSettingsMessage, "");
  try {
    const result = await api("/api/portal/v1/me/email-settings/verification/confirm", {
      method: "POST",
      body: JSON.stringify({ channel, code }),
    });
    portalState.emailSettings = emailSettingsResponsePayload(result) || portalState.emailSettings || {};
    renderEmailSettings();
    message(el.emailSettingsMessage, `${channelLabel(channel)} wurde für das maskierte Stammdatenziel bestätigt.`);
  } catch (error) {
    message(el.emailSettingsMessage, error.message, true);
    button.disabled = false;
    codeInput?.focus();
  }
}

async function saveNotificationPreferences(event) {
  event.preventDefault();
  if (!personalEmailSettingsAvailable()) return;
  const channels = {};
  for (const channel of personalNotificationChannels) {
    const input = el.notificationChannelSelection.querySelector(
      `[data-notification-channel="${channel}"] [data-notification-channel-enabled]`,
    );
    channels[channel] = Boolean(input && !input.disabled && input.checked);
  }

  const body = { channels };
  const quietHoursEditable = notificationQuietHoursEditable();
  if (quietHoursEditable) body.earliestTime = el.notificationEarliestTime.value;

  el.notificationPreferencesSaveButton.disabled = true;
  message(el.emailSettingsMessage, "");
  try {
    const result = await api("/api/portal/v1/me/email-settings/categories", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    portalState.emailSettings = emailSettingsResponsePayload(result) || portalState.emailSettings || {};
    renderEmailSettings();
    message(
      el.emailSettingsMessage,
      quietHoursEditable
        ? "Kanalwahl und Schlafmodus wurden gespeichert."
        : "Deine Kanalwahl wurde gespeichert.",
    );
  } catch (error) {
    message(el.emailSettingsMessage, error.message, true);
  } finally {
    el.notificationPreferencesSaveButton.disabled = false;
  }
}

async function loadAmuSettings() {
  try {
    const data = await api("/api/portal/v1/amu-settings");
    portalState.amuPolicy = data.policy || null;
    if (data.policy) {
      const conversion = data.policy.convertImagesToPdf ? ` · Fotos werden${data.policy.grayscaleImages ? " in Graustufen" : ""} als PDF gespeichert` : "";
      const ocr = data.policy.ocrEnabled ? " · lokale Datums- und SV-Erkennung" : "";
      const hint = `PDF oder Foto · höchstens 3 Dateien · je max. ${String(data.policy.uploadMaxMb).replace(".", ",")} MB${conversion}${ocr}`;
      if (el.amuUploadHint) el.amuUploadHint.textContent = hint;
      if (el.sicknessAmuUploadHint) el.sicknessAmuUploadHint.textContent = hint;
    }
    if (data.policy?.ocrEnabled && portalState.status?.capabilities?.localAmuOcr === true) {
      for (const contextName of ["amu", "sickness"]) {
        const ui = amuOcrContext(contextName);
        const state = portalState[ui.stateKey];
        const selectedFiles = [...(ui.camera?.files || []), ...(ui.documents?.files || [])];
        if (selectedFiles.length && !state.busy && !state.fileKey) recognizeAmuFiles(selectedFiles, contextName);
      }
    }
  } catch {
    portalState.amuPolicy = null;
  }
}

function renderAmuReports() {
  el.amuReportList.innerHTML = portalState.amuReports.length ? portalState.amuReports.map((report) => {
    const documents = report.documents || [];
    const canWithdraw = ["pending", "submitted", "pending_local", "returned"].includes(report.status);
    const period = `${dateText(report.incapacity_from)}${report.incapacity_to ? `–${dateText(report.incapacity_to)}` : " · Ende offen"}`;
    return `<article class="request-item amu-report" data-amu-report-id="${Number(report.id)}"><div><strong>${period}</strong>${report.employee_note ? `<span>${esc(report.employee_note)}</span>` : ""}<span class="status ${esc(report.status)}">${esc(amuReportStatusText(report))}</span><div class="document-links">${documents.map((document) => { const size = document.byte_size || document.size; return `<a href="/api/portal/v1/me/amu-reports/${Number(report.id)}/documents/${encodeURIComponent(String(document.id))}/content" target="_blank" rel="noopener">${esc(document.original_filename || document.original_name || document.filename || "Dokument")}${size ? ` · ${formatBytes(size)}` : ""}</a>`; }).join("")}</div></div>${canWithdraw ? '<button class="cancel-request" data-withdraw-amu type="button">Zurückziehen</button>' : ""}</article>`;
  }).join("") : '<p class="empty-state">Noch keine AUM-Meldung vorhanden.</p>';
}

async function loadAmuReports() {
  try {
    const data = await api("/api/portal/v1/me/amu-reports");
    portalState.amuReports = data.reports || data.items || [];
    renderAmuReports();
    renderSicknessCases();
  } catch (error) {
    el.amuReportList.innerHTML = `<p class="message error">${esc(error.message)}</p>`;
  }
}

function selectedAmuFiles(contextName = "amu") {
  const ui = amuOcrContext(contextName);
  return [...(ui.documents?.files || []), ...(ui.camera?.files || [])];
}

function validateAmuUpload(contextName, messageElement) {
  const ui = amuOcrContext(contextName);
  const state = portalState[ui.stateKey];
  const documents = selectedAmuFiles(contextName);
  if (!documents.length) {
    message(messageElement, "Bitte mindestens ein Dokument auswählen oder mit der Kamera fotografieren.", true);
    return null;
  }
  if (documents.length > 3) {
    message(messageElement, "Bitte höchstens drei Dokumente auswählen.", true);
    return null;
  }
  if (!ui.from.value) {
    message(messageElement, "Bitte den Beginn der Arbeitsunfähigkeit im Zeitraumskalender auswählen.", true);
    return null;
  }
  if (ui.to.value && ui.to.value < ui.from.value) {
    message(messageElement, "Das Enddatum darf nicht vor dem Beginn liegen.", true);
    return null;
  }
  if (state.busy) {
    message(messageElement, "Die lokale Datenerkennung läuft noch. Bitte kurz warten.", true);
    return null;
  }
  if (state.assisted && !ui.confirmed.checked) {
    message(messageElement, "Bitte die durch die lokale Datenerkennung vorgeschlagenen Datumswerte vor dem Senden bestätigen.", true);
    return null;
  }
  const allowedTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/tiff"]);
  const allowedExtensions = /\.(pdf|jpe?g|png|webp|tiff?)$/i;
  if (documents.some((file) => file.type ? !allowedTypes.has(file.type) : !allowedExtensions.test(file.name || ""))) {
    message(messageElement, "Erlaubt sind PDF-, JPG-, PNG-, WEBP- und TIFF-Dateien.", true);
    return null;
  }
  const maxBytes = Number(portalState.amuPolicy?.uploadMaxMb || 10) * 1024 * 1024;
  if (documents.some((file) => file.size > maxBytes)) {
    message(messageElement, `Eine Datei ist größer als ${String(portalState.amuPolicy?.uploadMaxMb || 10).replace(".", ",")} MB.`, true);
    return null;
  }
  return { ui, state, documents };
}

async function uploadAmuForContext(contextName, {
  sicknessCaseId = "",
  employeeNote = "",
  sicknessNote = "",
  messageElement = el.amuMessage,
} = {}) {
  const valid = validateAmuUpload(contextName, messageElement);
  if (!valid) throw Object.assign(new Error("AMU_VALIDATION_FAILED"), { handled: true });
  const { ui, state, documents } = valid;
  const body = new FormData();
  body.append("incapacityFrom", ui.from.value);
  body.append("incapacityTo", ui.to.value);
  body.append("employeeNote", employeeNote);
  body.append("sicknessCaseId", sicknessCaseId);
  if (contextName === "sickness") {
    body.append("sicknessNote", sicknessNote);
    body.append("directSicknessReport", "1");
  }
  body.append("ocrAssisted", state.assisted ? "1" : "0");
  body.append("ocrConfirmed", ui.confirmed.checked ? "1" : "0");
  documents.forEach((file) => body.append("documents", file));
  return api("/api/portal/v1/me/amu-reports", { method: "POST", body });
}

async function submitAmuReport(event) {
  event.preventDefault();
  el.amuSubmitButton.disabled = true;
  try {
    await uploadAmuForContext("amu", {
      sicknessCaseId: el.amuSicknessCaseId.value,
      employeeNote: el.amuEmployeeNote.value,
      messageElement: el.amuMessage,
    });
    el.amuReportForm.reset();
    resetAmuOcrState("amu");
    updateSicknessRangeControls();
    message(el.amuMessage, "Die AUM wurde übermittelt und verschlüsselt gespeichert.");
    await Promise.allSettled([loadSicknessCases(), loadAmuReports(), loadNotifications()]);
  } catch (error) {
    if (!error.handled) message(el.amuMessage, error.message, true);
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
    if (portalState.session?.user) portalState.session.user.mustChangePassword = false;
    el.passwordForm.reset();
    message(el.passwordMessage, "Passwort wurde geändert.");
    setTimeout(async () => {
      closePasswordChangeDialog({ force: true });
      if (await redirectToPendingCandidateEvaluation(portalState.session?.user)) return;
      await loadMobileLayout();
      chooseInitialPortalTab();
      await loadPortalData();
      await refreshBirthdayPresentationTheme();
      await claimBirthdayPresentation();
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

const loanConditionLabels = {
  good: "Sehr gut / vollständig",
  used: "Gebrauchsspuren",
  damaged: "Beschädigt",
  incomplete: "Unvollständig",
};

function currentLoanPhotoPdfPolicy() {
  const policy = portalState.loanStatus?.location?.photoPdf || {};
  return {
    outputMode: policy.outputMode === "blackwhite" ? "blackwhite" : "grayscale",
    originalRetention: policy.originalRetention === "delete" ? "delete" : "retain",
  };
}

function loanPhotoOutputModeText(value) {
  return value === "blackwhite" ? "Schwarzweiß" : "Graustufen";
}

function loanPhotoOriginalRetentionText(value) {
  return value === "delete"
    ? "Die aufbereiteten Farbfassungen werden nach der PDF-Verarbeitung gelöscht."
    : "Die metadatenfrei verkleinerten Farbfassungen werden geschützt aufbewahrt; die unveränderten Handydateien werden nicht gespeichert.";
}

function renderLoanPhotoPolicy() {
  const policy = currentLoanPhotoPdfPolicy();
  const processing = `Die Fotos werden verkleinert, in ${loanPhotoOutputModeText(policy.outputMode)} als geschützte PDF-Beilage zusammengefasst. ${loanPhotoOriginalRetentionText(policy.originalRetention)}`;
  if (el.loanIssuePhotoPolicy) {
    el.loanIssuePhotoPolicy.textContent = `Optional · bis zu 9 Fotos · je 10 MB, zusammen 45 MB. ${processing}`;
  }
  if (el.loanReturnPhotoPolicy) {
    el.loanReturnPhotoPolicy.textContent = `${processing} Die Rückgabe-Beilage wird gespeichert und bei einer Gegenprüfung dem zweiten Teammitglied angezeigt.`;
  }
}

function loanPhotoFiles(phase) {
  return phase === "return" ? portalState.loanReturnPhotoFiles : portalState.loanIssuePhotoFiles;
}

function setLoanPhotoFiles(phase, files) {
  if (phase === "return") portalState.loanReturnPhotoFiles = files;
  else portalState.loanIssuePhotoFiles = files;
  renderLoanPhotoSelection(phase);
}

function loanPhotoSize(bytes) {
  const value = Number(bytes || 0);
  return value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1).replace(".", ",")} MB`
    : `${Math.max(1, Math.round(value / 1024))} KB`;
}

function renderLoanPhotoSelection(phase) {
  const node = phase === "return" ? el.loanReturnPhotoSummary : el.loanIssuePhotoSummary;
  if (!node) return;
  const files = loanPhotoFiles(phase);
  node.innerHTML = files.length ? files.map((file, index) => `
    <span><strong>${esc(file.name || `Foto ${index + 1}`)}</strong><small>${esc(loanPhotoSize(file.size))}</small><button type="button" data-loan-photo-remove="${index}" data-loan-photo-phase="${phase}" aria-label="Foto entfernen">×</button></span>
  `).join("") : '<small>Noch keine Fotos ausgewählt.</small>';
}

function addLoanPhotoFiles(phase, fileList) {
  const current = [...loanPhotoFiles(phase)];
  const originalCount = current.length;
  const incoming = [...(fileList || [])];
  const allowedExtension = /\.(?:jpe?g|png|webp|tiff?|heic|heif)$/i;
  for (const file of incoming) {
    if (!String(file.type || "").startsWith("image/") && !allowedExtension.test(String(file.name || ""))) {
      message(phase === "return" ? el.loanReturnMessage : el.loanIssueMessage, "Für Leihfotos werden ausschließlich Bilddateien unterstützt.", true);
      continue;
    }
    if (Number(file.size || 0) > 10 * 1024 * 1024) {
      message(phase === "return" ? el.loanReturnMessage : el.loanIssueMessage, `${file.name}: Das Foto ist größer als 10 MB.`, true);
      continue;
    }
    if (current.length >= 9) break;
    if (current.reduce((sum, selected) => sum + Number(selected.size || 0), 0) + Number(file.size || 0) > 45 * 1024 * 1024) {
      message(phase === "return" ? el.loanReturnMessage : el.loanIssueMessage, "Die ausgewählten Fotos dürfen zusammen höchstens 45 MB groß sein.", true);
      break;
    }
    current.push(file);
  }
  setLoanPhotoFiles(phase, current);
  if (incoming.length && originalCount + incoming.length > 9) {
    message(phase === "return" ? el.loanReturnMessage : el.loanIssueMessage, "Pro Ausgabe oder Rücknahme sind höchstens neun Fotos möglich.", true);
  }
}

async function uploadLoanPhotos(loanId, phase, files) {
  if (!files?.length) return null;
  const data = new FormData();
  data.set("phase", phase);
  files.forEach((file) => data.append("photos", file, file.name || `${phase}-foto.jpg`));
  return api(`/api/portal/v1/loans/${encodeURIComponent(loanId)}/photos`, {
    method: "POST",
    body: data,
  });
}

function loanPhotoGallery(photos, phase = "") {
  const selected = (photos || []).filter((photo) => !phase || photo.phase === phase);
  if (!selected.length) return "";
  return `<div class="loan-photo-gallery">${selected.map((photo, index) => {
    const phaseLabel = photo.phase === "return" ? "Rückgabe" : "Ausgabe";
    const retention = photo.originalRetained === true
      ? "Aufbereitete Farbfassung verfügbar"
      : photo.originalRetained === false
        ? "Farbfassung nicht aufbewahrt"
        : "Status der Farbfassung nicht ausgewiesen";
    const preview = photo.contentUrl
      ? `<a href="${esc(photo.contentUrl)}" target="_blank" rel="noopener"><img src="${esc(photo.contentUrl)}" alt="${phaseLabel} ${Number(photo.position || index + 1)}" loading="lazy" /></a>`
      : `<span class="loan-photo-placeholder" aria-label="Keine Einzelvorschau verfügbar">Nur in der PDF-Beilage</span>`;
    return `<figure class="loan-photo-entry">${preview}<figcaption>${esc(retention)}</figcaption></figure>`;
  }).join("")}</div>`;
}

function loanPhotoAttachmentList(attachments, phase = "") {
  const selected = (Array.isArray(attachments) ? attachments : [])
    .filter((attachment) => attachment && ["issue", "return"].includes(attachment.phase)
      && (!phase || attachment.phase === phase))
    .sort((left, right) => {
      const phaseOrder = Number(left.phase === "return") - Number(right.phase === "return");
      return phaseOrder || Number(left.revision || 0) - Number(right.revision || 0);
    });
  if (!selected.length) return "";
  return `<div class="loan-photo-attachments">${selected.map((attachment) => {
    const phaseLabel = attachment.phase === "return" ? "Rückgabe" : "Ausgabe";
    const count = Number(attachment.sourcePhotoCount || 0);
    const retention = attachment.originalRetention === "delete"
      ? "Farbfassungen nicht aufbewahrt"
      : attachment.originalRetention === "retain"
        ? "Aufbereitete Farbfassungen geschützt aufbewahrt"
        : "Status der Farbfassung nicht ausgewiesen";
    const actions = [
      attachment.previewUrl
        ? `<a href="${esc(attachment.previewUrl)}" target="_blank" rel="noopener">Vorschau</a>`
        : "",
      attachment.downloadUrl
        ? `<a href="${esc(attachment.downloadUrl)}">PDF herunterladen</a>`
        : "",
    ].filter(Boolean).join("");
    return `<article class="loan-photo-attachment ${esc(attachment.phase)}">
      <div><strong>Fotobeilage ${phaseLabel}</strong><small>Beilage B${Number(attachment.revision || 1)} · ${count} ${count === 1 ? "Foto" : "Fotos"} · ${esc(loanPhotoOutputModeText(attachment.outputMode))} · ${esc(retention)}</small></div>
      ${actions ? `<nav aria-label="Fotobeilage ${phaseLabel}">${actions}</nav>` : ""}
    </article>`;
  }).join("")}</div>`;
}

function newLoanDraftItem() {
  return {
    identifier: "",
    serialNumber: "",
    conditionOut: "good",
    note: "",
    resolved: null,
    busy: false,
    error: "",
    needsManual: false,
    manualArticleNumber: "",
    manualDescription: "",
  };
}

function resetLoanDraft() {
  portalState.loanDraftItems = [newLoanDraftItem()];
  setLoanPhotoFiles("issue", []);
  if (el.loanIssueForm) {
    el.loanDueDate.value = "";
    el.loanIssueNote.value = "";
    el.loanIssuePhotos.value = "";
    el.loanIssueCamera.value = "";
  }
  renderLoanDraftItems();
}

function loanConditionOptions(selected) {
  return Object.entries(loanConditionLabels)
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`)
    .join("");
}

function renderLoanDraftItems() {
  if (!el.loanItemEditor) return;
  if (!portalState.loanDraftItems.length) portalState.loanDraftItems.push(newLoanDraftItem());
  el.loanItemEditor.innerHTML = portalState.loanDraftItems.map((item, index) => {
    const identifierLabel = item.resolved
      ? `<div class="loan-resolved-article"><span>✓ Zugeordnet</span><strong>${esc(item.resolved.articleNumber)} · ${esc(item.resolved.description)}</strong></div>`
      : "";
    const manual = item.needsManual ? `<div class="loan-manual-mapping">
      <label><span>Interne Artikelnummer</span><input data-loan-field="manualArticleNumber" data-loan-index="${index}" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" value="${esc(item.manualArticleNumber)}" placeholder="6-stellig" /></label>
      <label><span>Artikelbezeichnung</span><input data-loan-field="manualDescription" data-loan-index="${index}" maxlength="300" value="${esc(item.manualDescription)}" placeholder="Einmalig ergänzen" /></label>
      <small>Diese bestätigte Verbindung wird beim nächsten Scan automatisch verwendet.</small>
    </div>` : "";
    return `<article class="loan-item-row" data-loan-item="${index}">
      <header><strong>Position ${index + 1}</strong>${portalState.loanDraftItems.length > 1 ? `<button type="button" data-loan-remove="${index}" aria-label="Position entfernen">×</button>` : ""}</header>
      <div class="loan-item-fields">
        <label class="loan-identifier-field"><span>Artikelnummer oder EAN</span><div><input data-loan-field="identifier" data-loan-index="${index}" inputmode="numeric" maxlength="14" pattern="[0-9]*" autocomplete="off" value="${esc(item.identifier)}" placeholder="6, 8, 12, 13 oder 14 Ziffern" /><button class="text-button" data-loan-resolve="${index}" type="button" ${item.busy ? "disabled" : ""}>${item.busy ? "Suche …" : "Zuordnen"}</button></div></label>
        <label><span>Seriennummer</span><input data-loan-field="serialNumber" data-loan-index="${index}" maxlength="100" value="${esc(item.serialNumber)}" placeholder="Optional" /></label>
        <label><span>Zustand</span><select data-loan-field="conditionOut" data-loan-index="${index}">${loanConditionOptions(item.conditionOut)}</select></label>
        <label><span>Bemerkung</span><input data-loan-field="note" data-loan-index="${index}" maxlength="500" value="${esc(item.note)}" placeholder="Optional" /></label>
      </div>
      ${identifierLabel}
      ${item.error ? `<p class="loan-item-error">${esc(item.error)}</p>` : ""}
      ${manual}
    </article>`;
  }).join("");
  el.loanAddItem?.classList.toggle("hidden", portalState.loanDraftItems.length >= 5);
}

async function resolveLoanDraftItem(index) {
  const item = portalState.loanDraftItems[index];
  if (!item || item.busy) return;
  item.busy = true;
  item.error = "";
  renderLoanDraftItems();
  try {
    const result = await api("/api/portal/v1/loans/articles/resolve", {
      method: "POST",
      body: JSON.stringify({
        locationId: portalState.loanStatus?.location?.id,
        identifier: item.identifier,
        manualArticleNumber: item.manualArticleNumber,
        manualDescription: item.manualDescription,
      }),
    });
    item.resolved = result.article;
    item.needsManual = false;
    item.error = result.lookupWarning?.message || "";
  } catch (error) {
    item.resolved = null;
    item.error = error.message;
    item.needsManual = ![
      "ARTICLE_IDENTIFIER_INVALID",
      "ARTICLE_IDENTIFIER_CHECKSUM_INVALID",
      "ARTICLE_NUMBER_INVALID",
    ].includes(error.code);
  } finally {
    item.busy = false;
    renderLoanDraftItems();
  }
}

async function loadLoanTeamMembers() {
  try {
    const query = new URLSearchParams({ locationId: portalState.loanStatus?.location?.id || "" });
    const result = await api(`/api/portal/v1/loans/team-members?${query}`);
    portalState.loanTeamMembers = Array.isArray(result.members) ? result.members : [];
  } catch {
    portalState.loanTeamMembers = [];
  }
}

function loanStatusText(status) {
  return {
    draft: "Entwurf",
    issued: "Offen",
    returned: "Zurückgegeben",
    cancelled: "Storniert",
  }[status] || status || "";
}

function loanConditionText(condition) {
  return {
    good: "Einwandfrei",
    used: "Gebrauchsspuren",
    damaged: "Beschädigt",
    incomplete: "Unvollständig",
  }[condition] || condition || "Nicht angegeben";
}

function renderLoanOverview() {
  if (!el.loanOverviewTableBody || !el.loanOverviewTableHeader) return;
  const columns = normalizedLoanOverviewColumns(portalState.loanOverviewColumns);
  const query = String(el.loanOverviewSearch?.value || "").trim().toLocaleLowerCase("de-AT");
  const items = portalState.loanOverviewItems.filter((item) => !query || columns
    .some((columnId) => String(item[columnId] || "").toLocaleLowerCase("de-AT").includes(query)));
  el.loanOverviewTableHeader.innerHTML = columns.map((columnId) => {
    const column = loanOverviewColumnById.get(columnId);
    return `<th scope="col">${esc(column?.label || "")}</th>`;
  }).join("");
  if (el.loanOverviewDescription) {
    el.loanOverviewDescription.textContent = columns.includes("borrowerName")
      ? "Name und die von der Filialleitung freigegebenen Gerätedaten. Notizen, Fotos, Belege und Bearbeitungsfunktionen bleiben ausgeschlossen."
      : "Gerätestatus ohne Personen-, Beleg- oder interne Vorgangsdaten.";
  }
  el.loanOverviewTableBody.innerHTML = items.length ? items.map((item) => `
    <tr>
      ${columns.map((columnId) => {
        const column = loanOverviewColumnById.get(columnId);
        const value = columnId === "dueDate" && item.dueDate
          ? dateText(item.dueDate)
          : item[columnId] || column?.fallback || "–";
        return `<td data-loan-column="${esc(columnId)}"><span class="loan-cell-label" aria-hidden="true">${esc(column?.label || "")}</span><span>${esc(value)}</span></td>`;
      }).join("")}
    </tr>
  `).join("") : `<tr><td class="loan-overview-empty" colspan="${columns.length}">${
    query ? "Kein offenes Gerät entspricht dieser Suche." : "Am Standort sind derzeit keine Geräte als ausgeliehen erfasst."
  }</td></tr>`;
}

async function loadLoanOverview() {
  if (portalState.loanStatus?.permissions?.overviewRead !== true) {
    portalState.loanOverviewItems = [];
    portalState.loanOverviewColumns = [];
    portalState.loanOverviewSearchEnabled = false;
    el.loanOpenOverview?.classList.add("hidden");
    return;
  }
  el.loanOpenOverview?.classList.remove("hidden");
  const parameters = new URLSearchParams({
    locationId: portalState.loanStatus.location?.id || "",
  });
  try {
    const result = await api(`/api/portal/v1/loans/open-overview?${parameters}`);
    portalState.loanOverviewItems = Array.isArray(result.items) ? result.items : [];
    portalState.loanOverviewColumns = normalizedLoanOverviewColumns(result.columns);
    const searchEnabled = result.searchEnabled === true
      && portalState.loanOverviewItems.length > LOAN_OVERVIEW_SEARCH_THRESHOLD;
    portalState.loanOverviewSearchEnabled = searchEnabled;
    el.loanOverviewSearchField?.classList.toggle("hidden", !searchEnabled);
    if (!searchEnabled && el.loanOverviewSearch) el.loanOverviewSearch.value = "";
    renderLoanOverview();
  } catch (error) {
    portalState.loanOverviewItems = [];
    portalState.loanOverviewColumns = [];
    portalState.loanOverviewSearchEnabled = false;
    el.loanOverviewSearchField?.classList.add("hidden");
    renderLoanOverview();
    el.loanOverviewTableBody.innerHTML = `<tr><td class="loan-overview-empty" colspan="${defaultLoanOverviewColumnIds.length}">${esc(error.message)}</td></tr>`;
  }
}

function renderLoanList() {
  if (!el.loanList) return;
  const ownNumber = portalUser()?.employeeNumber || "";
  const canManage = portalState.loanStatus?.permissions?.locationManage === true;
  const canReturnOwn = portalState.loanStatus?.permissions?.ownReturn === true;
  el.loanList.innerHTML = portalState.loans.length ? portalState.loans.map((loan) => {
    const items = (loan.items || []).map((item) =>
      `<li><strong>${esc(item.articleNumber)} · ${esc(item.description)}</strong>${item.serialNumber ? `<small>Seriennummer: ${esc(item.serialNumber)}</small>` : ""}</li>`,
    ).join("");
    const canReturn = loan.status === "issued"
      && !loan.pendingReturnConfirmation
      && (canManage || (canReturnOwn && loan.borrower?.employeeNumber === ownNumber));
    const canReadDocuments = portalState.loanStatus?.permissions?.documentsRead === true
      || [
        loan.borrower?.employeeNumber,
        loan.createdBy?.employeeNumber,
        loan.returnRecordedByEmployeeNumber,
        loan.returnWitness?.employeeNumber,
      ].includes(ownNumber);
    const documents = canReadDocuments && Array.isArray(loan.documents) && loan.documents.length
      ? `<div class="loan-documents">${loan.documents.map((document) =>
        `<a href="${esc(document.downloadUrl)}" target="_blank" rel="noopener">${esc(document.label)} · R${esc(document.revision)}</a>`
      ).join("")}</div>`
      : "";
    const returnCopy = loan.returnWitness
      ? `<small>Rücknahme bestätigt durch ${esc(loan.returnWitness.employeeNumber)} · ${esc(loan.returnWitness.name)}</small>`
      : "";
    const pendingCopy = loan.pendingReturnConfirmation
      ? `<small class="loan-pending-confirmation">Bestätigung ausständig bei ${esc(loan.pendingReturnConfirmation.witness.employeeNumber)} · ${esc(loan.pendingReturnConfirmation.witness.name)} – gültig bis ${esc(timestampText(loan.pendingReturnConfirmation.expiresAt))}</small>`
      : "";
    const preparationCopy = loan.returnPreparation && !loan.pendingReturnConfirmation
      ? `<small class="loan-return-preparation">Rücknahme vorbereitet von ${esc(loan.returnPreparation.requestedBy.employeeNumber)} · ${esc(loan.returnPreparation.requestedBy.name)} – zuletzt gespeichert ${esc(timestampText(loan.returnPreparation.updatedAt))}</small>`
      : "";
    const photos = loanPhotoGallery(loan.photos);
    const photoAttachments = loanPhotoAttachmentList(loan.photoAttachments);
    const actions = [
      canManage ? `<button class="text-button" data-loan-manage="${esc(loan.id)}" type="button">Bearbeiten</button>` : "",
      canReturn ? `<button class="primary" data-loan-return="${esc(loan.id)}" type="button">${loan.returnPreparation ? "Rücknahme fortsetzen" : "Zurücknehmen"}</button>` : "",
    ].filter(Boolean).join("");
    return `<article class="loan-list-item">
      <div class="loan-list-main"><span class="status ${loan.status === "returned" ? "approved" : "pending"}">${esc(loanStatusText(loan.status))}</span><strong>${esc(loan.borrower?.employeeNumber)} · ${esc(loan.borrower?.name)}</strong><small>Ausgabe: ${esc(timestampText(loan.issuedAt || loan.createdAt))}${loan.dueDate ? ` · geplant bis ${esc(dateText(loan.dueDate))}` : ""}</small>${returnCopy}${pendingCopy}${preparationCopy}<ul>${items}</ul>${photos}${photoAttachments}${documents}</div>
      ${actions ? `<div class="loan-list-actions">${actions}</div>` : ""}
    </article>`;
  }).join("") : '<p class="empty-state">In diesem Bereich sind noch keine Leihvorgänge vorhanden.</p>';
}

async function loadLoans() {
  if (!portalState.loanStatus?.available) return;
  const scope = el.loanScope?.value || "mine";
  const status = el.loanStatusFilter?.value || "open";
  const parameters = new URLSearchParams({
    scope,
    status,
    locationId: portalState.loanStatus.location?.id || "",
  });
  try {
    const result = await api(`/api/portal/v1/loans?${parameters}`);
    portalState.loans = Array.isArray(result.loans) ? result.loans : [];
    renderLoanList();
  } catch (error) {
    portalState.loans = [];
    el.loanList.innerHTML = `<p class="empty-state">${esc(error.message)}</p>`;
  }
}

async function loadLoanModule() {
  if (!loanCapabilityEnabled() || !el.loanWorkspace) return;
  try {
    portalState.loanStatus = await api("/api/portal/v1/loans/status");
    renderLoanPhotoPolicy();
    const available = portalState.loanStatus.available === true;
    el.loanWorkspace.classList.toggle("hidden", !available);
    message(
      el.loanAvailabilityMessage,
      available ? "" : "Die Leihe ist für deinen Standort noch nicht freigeschaltet.",
      !available,
    );
    if (!available) return;
    const canManage = portalState.loanStatus.permissions?.locationManage === true;
    const canCreate = portalState.loanStatus.permissions?.ownCreate === true;
    const canReadDetails = portalState.loanStatus.permissions?.ownRead === true
      || portalState.loanStatus.permissions?.locationRead === true
      || canManage;
    el.loanIssueForm?.classList.toggle("hidden", !canCreate);
    document.querySelector("#loanIssueSection")?.classList.toggle("hidden", !canCreate);
    el.loanPersonalOverview?.classList.toggle("hidden", !canReadDetails);
    el.loanScopeField?.classList.toggle(
      "hidden",
      !canManage && portalState.loanStatus.permissions?.locationRead !== true,
    );
    if (canCreate) {
      const today = iso(new Date());
      el.loanDueDate.min = today;
      el.loanDueDate.max = addDays(today, 3650);
      if (!portalState.loanDraftItems.length) resetLoanDraft();
    }
    const requests = [loadLoanOverview()];
    if (portalState.loanStatus.permissions?.ownReturn === true || canManage) {
      requests.push(loadLoanTeamMembers());
    }
    if (canReadDetails) requests.push(loadLoans());
    if (portalState.loanStatus.permissions?.ownRead === true
      || portalState.loanStatus.permissions?.ownReturn === true
      || canManage) {
      requests.push(loadPendingLoanConfirmations());
    }
    await Promise.all(requests);
  } catch (error) {
    portalState.loanStatus = null;
    el.loanWorkspace.classList.add("hidden");
    message(el.loanAvailabilityMessage, error.message, true);
  }
}

async function submitLoanIssue(event) {
  event.preventDefault();
  if (!portalState.loanStatus?.available) return;
  const unresolved = portalState.loanDraftItems.findIndex((item) => !item.resolved);
  if (unresolved >= 0) {
    message(el.loanIssueMessage, `Bitte Position ${unresolved + 1} zuerst eindeutig zuordnen.`, true);
    return;
  }
  el.loanIssueSubmit.disabled = true;
  message(el.loanIssueMessage, "");
  try {
    const result = await api("/api/portal/v1/loans", {
      method: "POST",
      body: JSON.stringify({
        locationId: portalState.loanStatus.location?.id,
        dueDate: el.loanDueDate.value,
        notes: el.loanIssueNote.value,
        items: portalState.loanDraftItems.map((item) => ({
          articleNumber: item.resolved.articleNumber,
          serialNumber: item.serialNumber,
          conditionOut: item.conditionOut,
          note: item.note,
        })),
      }),
    });
    let photoWarning = "";
    if (portalState.loanIssuePhotoFiles.length) {
      try {
        await uploadLoanPhotos(result.loan.id, "issue", portalState.loanIssuePhotoFiles);
      } catch (error) {
        photoWarning = ` Die Leihe ist gespeichert, die Fotos konnten jedoch nicht ergänzt werden: ${error.message}`;
      }
    }
    message(el.loanIssueMessage, `Die Leihe und der Ausgabebeleg wurden erfasst.${photoWarning}`, Boolean(photoWarning));
    resetLoanDraft();
    await Promise.all([loadLoans(), loadLoanOverview()]);
  } catch (error) {
    message(el.loanIssueMessage, error.message, true);
  } finally {
    el.loanIssueSubmit.disabled = false;
  }
}

async function openLoanReturn(loanId) {
  await loadLoanTeamMembers();
  const loan = portalState.loans.find((item) => item.id === loanId);
  if (!loan) return;
  portalState.selectedLoan = loan;
  const preparation = loan.returnPreparation || null;
  const preparedItems = new Map((preparation?.items || []).map((item) => [Number(item.position), item]));
  el.loanReturnTitle.textContent = `Leihe von ${loan.borrower?.name || loan.borrower?.employeeNumber}`;
  el.loanReturnSummary.innerHTML = `<strong>${esc(loan.borrower?.employeeNumber)} · ${esc(loan.borrower?.name)}</strong><span>${loan.items.length} ${loan.items.length === 1 ? "Artikel" : "Artikel"} · Revision ${loan.revision}</span>`;
  el.loanReturnItems.innerHTML = loan.items.map((item) => {
    const prepared = preparedItems.get(Number(item.position));
    return `<article class="loan-return-item" data-loan-return-position="${item.position}">
    <div><strong>${esc(item.articleNumber)} · ${esc(item.description)}</strong>${item.serialNumber ? `<small>Seriennummer: ${esc(item.serialNumber)}</small>` : ""}</div>
    <label><span>Zustand bei Rückgabe</span><select data-loan-return-condition="${item.position}">${loanConditionOptions(prepared?.conditionReturn || item.conditionOut || "good")}</select></label>
    <label><span>Bemerkung</span><input data-loan-return-note="${item.position}" maxlength="500" placeholder="Optional" value="${esc(prepared?.returnNote || "")}" /></label>
  </article>`;
  }).join("");
  const canManage = portalState.loanStatus?.permissions?.locationManage === true;
  el.loanReturnWitness.innerHTML = `<option value="">${canManage ? "Ohne zweite Person direkt abschließen" : "Jetzt speichern – Gegenprüfung später anfordern"}</option>` + portalState.loanTeamMembers
    .filter((member) => member.employeeNumber !== loan.borrower?.employeeNumber
      && member.employeeNumber !== portalUser()?.employeeNumber)
    .map((member) => `<option value="${esc(member.employeeNumber)}">${esc(member.employeeNumber)} · ${esc(member.name)}</option>`)
    .join("");
  el.loanReturnNote.value = preparation?.note || "";
  el.loanReturnWitnessHint.textContent = canManage
    ? "Ohne Auswahl schließt die zuständige Leitung direkt ab. Mit Auswahl kann ein zweites Teammitglied bis 23:59 Uhr gegenprüfen."
    : "Ohne Auswahl wird die Rücknahme gespeichert. Ein zweites Teammitglied kann auch später ausgewählt werden und bis 23:59 Uhr gegenprüfen.";
  el.loanReturnSubmit.textContent = canManage ? "Rücknahme abschließen" : "Rücknahme speichern";
  setLoanPhotoFiles("return", []);
  el.loanReturnPhotos.value = "";
  el.loanReturnCamera.value = "";
  message(el.loanReturnMessage, "");
  el.loanReturnDialog.showModal();
}

async function submitLoanReturn(event) {
  event.preventDefault();
  const loan = portalState.selectedLoan;
  if (!loan) return;
  el.loanReturnSubmit.disabled = true;
  message(el.loanReturnMessage, "");
  try {
    if (portalState.loanReturnPhotoFiles.length) {
      await uploadLoanPhotos(loan.id, "return", portalState.loanReturnPhotoFiles);
      setLoanPhotoFiles("return", []);
      el.loanReturnPhotos.value = "";
      el.loanReturnCamera.value = "";
    }
    const result = await api(`/api/portal/v1/loans/${encodeURIComponent(loan.id)}/return`, {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: loan.revision,
        witnessEmployeeNumber: el.loanReturnWitness.value,
        borrowerConfirmed: loan.borrower?.employeeNumber === portalUser()?.employeeNumber,
        note: el.loanReturnNote.value,
        items: loan.items.map((item) => ({
          position: item.position,
          conditionReturn: el.loanReturnItems.querySelector(`[data-loan-return-condition="${item.position}"]`)?.value,
          note: el.loanReturnItems.querySelector(`[data-loan-return-note="${item.position}"]`)?.value || "",
        })),
      }),
    });
    el.loanReturnDialog.close();
    portalState.selectedLoan = null;
    const completionCopy = result.direct
      ? "Die Rücknahme wurde durch die zuständige Leitung abgeschlossen."
      : result.confirmation
        ? `Bestätigung bei ${result.confirmation.witness.employeeNumber} · ${result.confirmation.witness.name} bis heute 23:59 Uhr angefordert. Die Leihe bleibt bis dahin offen.`
        : "Die Rücknahme wurde gespeichert und kann später fortgesetzt oder zur Gegenprüfung weitergegeben werden.";
    message(el.loanAvailabilityMessage, completionCopy);
    await loadLoans();
  } catch (error) {
    message(el.loanReturnMessage, error.message, true);
  } finally {
    el.loanReturnSubmit.disabled = false;
  }
}

async function openLoanManagement(loanId) {
  try {
    const result = await api(`/api/portal/v1/loans/${encodeURIComponent(loanId)}`);
    const loan = result.loan;
    portalState.selectedManagedLoan = loan;
    el.loanManageTitle.textContent = `Leihe von ${loan.borrower?.name || loan.borrower?.employeeNumber} bearbeiten`;
    el.loanManageSummary.innerHTML = `
      <strong>${esc(loan.borrower?.employeeNumber)} · ${esc(loan.borrower?.name)}</strong>
      <span>${esc(loanStatusText(loan.status))} · ${loan.items.length} ${loan.items.length === 1 ? "Artikel" : "Artikel"} · Revision ${loan.revision}</span>`;
    el.loanManageDueDate.value = loan.dueDate || "";
    el.loanManageDueDate.max = addDays(iso(new Date()), 3650);
    el.loanManageNote.value = loan.notes || "";
    el.loanManageItems.innerHTML = loan.items.map((item) => {
      const returnCondition = item.conditionReturn || item.conditionOut || "good";
      return `<article class="loan-manage-item" data-loan-manage-position="${item.position}">
        <div><strong>${esc(item.articleNumber)} · ${esc(item.description)}</strong><small>Position ${item.position}</small></div>
        <label><span>Seriennummer</span><input data-loan-manage-serial="${item.position}" maxlength="100" value="${esc(item.serialNumber || "")}" placeholder="Optional" /></label>
        <label><span>Zustand bei Ausgabe</span><select data-loan-manage-condition-out="${item.position}">${loanConditionOptions(item.conditionOut || "good")}</select></label>
        <label><span>Zustand bei Rückgabe</span><select data-loan-manage-condition-return="${item.position}">${loanConditionOptions(returnCondition)}</select></label>
        <label class="loan-manage-item-note"><span>Artikelbemerkung</span><input data-loan-manage-note="${item.position}" maxlength="500" value="${esc(item.note || "")}" placeholder="Optional" /></label>
      </article>`;
    }).join("");
    const open = loan.status === "issued";
    el.loanManageClose.classList.toggle("hidden", !open);
    el.loanManageReopen.classList.toggle("hidden", open);
    el.loanManageClose.dataset.confirmed = "false";
    el.loanManageClose.textContent = "Ohne Rücknahmebeleg schließen";
    el.loanManageActionHint.textContent = open
      ? "Beim manuellen Schließen werden die Rückgabezustände gespeichert, aber keine Gegenbestätigung und kein neuer Rücknahmebeleg erzeugt."
      : "Beim Wiederöffnen bleiben vorhandene Belege und Verlaufseinträge unverändert erhalten; die Rückgabezustände werden für die neue offene Revision geleert.";
    message(el.loanManageMessage, "");
    el.loanManageDialog.showModal();
  } catch (error) {
    message(el.loanAvailabilityMessage, error.message, true);
  }
}

function loanManagementPayload(loan, { closing = false } = {}) {
  return {
    expectedRevision: loan.revision,
    dueDate: el.loanManageDueDate.value,
    notes: el.loanManageNote.value,
    items: loan.items.map((item) => ({
      position: item.position,
      serialNumber: el.loanManageItems.querySelector(`[data-loan-manage-serial="${item.position}"]`)?.value || "",
      conditionOut: el.loanManageItems.querySelector(`[data-loan-manage-condition-out="${item.position}"]`)?.value || "",
      conditionReturn: closing || loan.status === "returned"
        ? el.loanManageItems.querySelector(`[data-loan-manage-condition-return="${item.position}"]`)?.value || ""
        : "",
      note: el.loanManageItems.querySelector(`[data-loan-manage-note="${item.position}"]`)?.value || "",
    })),
  };
}

function setLoanManagementBusy(busy) {
  [el.loanManageSave, el.loanManageClose, el.loanManageReopen].forEach((button) => {
    if (button) button.disabled = busy;
  });
}

async function finishLoanManagement(result, successMessage) {
  portalState.selectedManagedLoan = null;
  el.loanManageDialog.close();
  message(el.loanAvailabilityMessage, successMessage);
  await Promise.all([loadLoans(), loadLoanOverview()]);
  return result;
}

async function submitLoanManagement(event) {
  event.preventDefault();
  const loan = portalState.selectedManagedLoan;
  if (!loan) return;
  setLoanManagementBusy(true);
  message(el.loanManageMessage, "");
  try {
    const result = await api(`/api/portal/v1/loans/${encodeURIComponent(loan.id)}/management`, {
      method: "PUT",
      body: JSON.stringify(loanManagementPayload(loan)),
    });
    await finishLoanManagement(result, `Änderungen als Revision ${result.loan.revision} gespeichert.`);
  } catch (error) {
    message(el.loanManageMessage, error.message, true);
  } finally {
    setLoanManagementBusy(false);
  }
}

async function runLoanManagementAction(action) {
  const loan = portalState.selectedManagedLoan;
  if (!loan) return;
  if (action === "close" && el.loanManageClose.dataset.confirmed !== "true") {
    el.loanManageClose.dataset.confirmed = "true";
    el.loanManageClose.textContent = "Schließen jetzt bestätigen";
    message(
      el.loanManageMessage,
      "Es wird kein Rücknahmebeleg erstellt und kein zweites Teammitglied bestätigt. Bitte den roten Knopf erneut drücken.",
      true,
    );
    return;
  }
  setLoanManagementBusy(true);
  message(el.loanManageMessage, "");
  try {
    const suffix = action === "close" ? "close" : "reopen";
    const body = action === "close"
      ? loanManagementPayload(loan, { closing: true })
      : { expectedRevision: loan.revision };
    const result = await api(
      `/api/portal/v1/loans/${encodeURIComponent(loan.id)}/management/${suffix}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    const copy = action === "close"
      ? `Leihe ohne neuen Rücknahmebeleg als Revision ${result.loan.revision} geschlossen.`
      : `Leihe als Revision ${result.loan.revision} wieder geöffnet.`;
    await finishLoanManagement(result, copy);
  } catch (error) {
    message(el.loanManageMessage, error.message, true);
  } finally {
    setLoanManagementBusy(false);
  }
}

function showLoanConfirmation(confirmation) {
  if (!confirmation || !el.loanConfirmationDialog || el.loanConfirmationDialog.open) return;
  portalState.activeLoanConfirmation = confirmation;
  const borrower = confirmation.loan?.borrower || {};
  el.loanConfirmationTitle.textContent = `Rücknahme von ${borrower.name || borrower.employeeNumber || "Teammitglied"}`;
  el.loanConfirmationSummary.innerHTML = `
    <strong>${esc(borrower.employeeNumber)} · ${esc(borrower.name)}</strong>
    <span>Angefordert von ${esc(confirmation.requestedBy.employeeNumber)} · ${esc(confirmation.requestedBy.name)}</span>`;
  el.loanConfirmationItems.innerHTML = (confirmation.items || []).map((item) => `
    <article class="loan-confirmation-item">
      <div>
        <strong>${esc(item.articleNumber)} · ${esc(item.description)}</strong>
        ${item.serialNumber ? `<small>Seriennummer: ${esc(item.serialNumber)}</small>` : ""}
      </div>
      <span class="loan-condition-pill">${esc(loanConditionText(item.conditionReturn))}</span>
      ${item.returnNote ? `<small>Bemerkung: ${esc(item.returnNote)}</small>` : ""}
    </article>`).join("");
  const photos = (confirmation.photos || []);
  const photoAttachments = confirmation.photoAttachments || confirmation.loan?.photoAttachments || [];
  const returnAttachment = loanPhotoAttachmentList(photoAttachments, "return");
  el.loanConfirmationPhotos.classList.toggle("hidden", !photos.length && !returnAttachment);
  el.loanConfirmationPhotos.querySelector("div").innerHTML = `${loanPhotoGallery(photos, "return")}${returnAttachment}`;
  el.loanConfirmationNote.value = "";
  el.loanConfirmationExpiry.textContent = `Die Anfrage läuft um ${timestampText(confirmation.expiresAt)} ab. Ohne deine Bestätigung bleibt die Leihe offen.`;
  message(el.loanConfirmationMessage, "");
  el.loanConfirmationDialog.showModal();
}

function presentNextLoanConfirmation() {
  if (el.loanConfirmationDialog?.open) return;
  const next = portalState.pendingLoanConfirmations.find((confirmation) => confirmation.status === "pending");
  if (next) showLoanConfirmation(next);
}

async function loadPendingLoanConfirmations({ present = true } = {}) {
  if (!loanCapabilityEnabled() || portalState.loanConfirmationLoading) return;
  portalState.loanConfirmationLoading = true;
  try {
    const result = await api("/api/portal/v1/loans/return-confirmations/pending");
    portalState.pendingLoanConfirmations = Array.isArray(result.confirmations) ? result.confirmations : [];
    if (present) presentNextLoanConfirmation();
  } catch {
    portalState.pendingLoanConfirmations = [];
  } finally {
    portalState.loanConfirmationLoading = false;
  }
}

async function respondToLoanConfirmation(decision) {
  const confirmation = portalState.activeLoanConfirmation;
  if (!confirmation || !["confirm", "reject"].includes(decision)) return;
  el.loanConfirmationSubmit.disabled = true;
  el.loanConfirmationReject.disabled = true;
  message(el.loanConfirmationMessage, "");
  try {
    await api(`/api/portal/v1/loans/return-confirmations/${encodeURIComponent(confirmation.id)}/respond`, {
      method: "POST",
      body: JSON.stringify({
        decision,
        note: el.loanConfirmationNote.value,
      }),
    });
    el.loanConfirmationDialog.close();
    portalState.activeLoanConfirmation = null;
    portalState.pendingLoanConfirmations = portalState.pendingLoanConfirmations
      .filter((entry) => entry.id !== confirmation.id);
    if (portalState.loanStatus?.available) {
      await Promise.all([loadLoans(), loadLoanOverview()]);
    }
    presentNextLoanConfirmation();
  } catch (error) {
    message(el.loanConfirmationMessage, error.message, true);
  } finally {
    el.loanConfirmationSubmit.disabled = false;
    el.loanConfirmationReject.disabled = false;
  }
}

el.portalLoginForm.addEventListener("submit", login);
el.loginPersonnelNumber.addEventListener("input", scheduleLoginBrandingPreview);
el.loginPersonnelNumber.addEventListener("blur", previewLoginBranding);
el.forgotPasswordButton?.addEventListener("click", openPasswordResetRequest);
el.passwordResetRequestForm?.addEventListener("submit", requestPasswordReset);
el.passwordResetConfirmForm?.addEventListener("submit", confirmPasswordReset);
document.querySelectorAll("[data-close-password-reset-request]").forEach((button) => button.addEventListener("click", () => el.passwordResetRequestDialog.close()));
document.querySelectorAll("[data-close-password-reset-confirm]").forEach((button) => button.addEventListener("click", closePasswordResetConfirm));
el.passwordResetConfirmDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePasswordResetConfirm();
});
el.logoutButton.addEventListener("click", logout);
el.settingsPasswordButton?.addEventListener("click", openPasswordChangeDialog);
el.portalSettingsShortcut?.addEventListener("click", () => setTab(portalState.activeTab === "settings" ? "home" : "settings"));
el.personalActionsButton?.addEventListener("click", openPersonalActions);
el.personalActionsLoadMore?.addEventListener("click", () => loadPersonalActions({ append: true }));
el.personalActionsList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-undo-personal-action]");
  if (button) undoPersonalAction(button.dataset.undoPersonalAction);
});
document.querySelectorAll("[data-close-personal-actions]").forEach((button) => button.addEventListener("click", closePersonalActions));
el.personalActionsDialog?.addEventListener("close", () => el.personalActionsButton?.setAttribute("aria-expanded", "false"));
el.mobileSettingsHome?.addEventListener("click", () => setTab("home"));
el.mobileHomeTiles?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-mobile-home-tab]");
  if (button) setTab(button.dataset.mobileHomeTab);
});
el.leadershipSettingsButton?.addEventListener("click", () => setTab("settings"));
el.mobileHomeSettingsList?.addEventListener("change", (event) => {
  const row = event.target.closest("[data-mobile-home-item]");
  if (!row) return;
  if (event.target.closest("[data-mobile-home-color-picker]")) {
    updateMobileHomeColorFromPicker(row);
    return;
  }
  if (event.target.closest("[data-mobile-home-rgb]")) {
    const rgb = mobileHomeRgbFromRow(row);
    if (!updateMobileHomeColor(String(row.dataset.mobileHomeItem || ""), row, rgb)) {
      message(el.mobileHomeSettingsMessage, "RGB-Werte müssen ganze Zahlen zwischen 0 und 255 sein.", true);
    }
  }
});
el.mobileHomeSettingsList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-mobile-home-move]");
  const row = button?.closest("[data-mobile-home-item]");
  if (button && row) moveMobileHomeItem(row.dataset.mobileHomeItem, Number(button.dataset.mobileHomeMove));
});
el.resetMobileHomeButton?.addEventListener("click", resetMobileHomeSettings);
el.saveMobileHomeButton?.addEventListener("click", saveMobileHomeSettings);
el.mobileNavigationSettingsList?.addEventListener("change", (event) => {
  const input = event.target.closest("[data-mobile-navigation-visible]");
  if (!input) return;
  if (!updateMobileNavigationSelection(input.value, input.checked)) {
    input.checked = !input.checked;
    renderMobileNavigationSettings();
  }
});
el.mobileNavigationSettingsList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-mobile-navigation-move]");
  const row = button?.closest("[data-mobile-navigation-item]");
  if (button && row) moveMobileNavigationItem(row.dataset.mobileNavigationItem, Number(button.dataset.mobileNavigationMove));
});
el.resetMobileNavigationButton?.addEventListener("click", resetMobileNavigationSettings);
el.saveMobileNavigationButton?.addEventListener("click", saveMobileNavigationSettings);
document.querySelectorAll('input[name="mobilePortalPalette"],input[name="mobilePortalSurface"]').forEach((input) => {
  input.addEventListener("change", () => {
    applyMobilePortalAppearance(mobileAppearanceFromSettings());
    message(el.mobileAppearanceSettingsMessage, "Vorschau aktiv. Bitte speichern, um die Auswahl zu behalten.");
  });
});
el.saveMobileAppearanceButton?.addEventListener("click", saveMobileAppearanceSettings);
el.emailSettingsCard?.addEventListener("toggle", () => {
  if (el.emailSettingsCard.open && personalEmailSettingsAvailable()) loadEmailSettings();
});
el.notificationTargetList?.addEventListener("click", (event) => {
  const requestButton = event.target.closest("[data-notification-verification-request]");
  if (requestButton) {
    requestNotificationVerification(requestButton);
    return;
  }
  const confirmButton = event.target.closest("[data-notification-verification-confirm]");
  if (confirmButton) confirmNotificationVerification(confirmButton);
});
el.notificationPreferencesForm?.addEventListener("submit", saveNotificationPreferences);
el.passwordForm.addEventListener("submit", changePassword);
document.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-password-toggle]");
  if (toggle) togglePassword(toggle);
});
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => {
  closePasswordChangeDialog();
}));
el.passwordDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePasswordChangeDialog();
});
el.passwordDialog?.addEventListener("close", () => setPasswordChangeControlsEnabled(false));
el.passwordResetConfirmDialog?.addEventListener("close", () => setPasswordResetConfirmControlsEnabled(false));
document.querySelectorAll("[data-settings-focus]").forEach((button) => button.addEventListener("click", () => {
  window.setTimeout(() => focusPortalSettingsSection(button.dataset.settingsFocus), 0);
}));
document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
el.refreshPortalLearningDashboard?.addEventListener("click", () => {
  portalState.personnelLearningDashboard = null;
  loadPersonnelLearningDashboard({ force: true });
});
el.portalLearningDashboardEmployee?.addEventListener("change", (event) => {
  portalState.personnelLearningDashboardEmployeeNumber = event.target.value;
  renderPortalLearningSkillTree();
});
el.portalLearningDashboardAssignments?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-portal-learning-progress]");
  if (!button) return;
  openPortalLearningProgress(button.dataset.portalLearningProgress)
    .catch((error) => message(el.portalLearningDashboardMessage, error.message, true));
});
el.portalLearningProgressForm?.addEventListener("submit", savePortalLearningProgress);
el.portalLearningProgressSteps?.addEventListener("change", (event) => {
  event.target.closest(".portal-learning-progress-step")?.classList.toggle(
    "completed",
    event.target.checked,
  );
  updatePortalLearningProgressAvailability();
});
[
  el.portalLearningProgressFinalized,
  el.portalLearningProgressResult,
  el.portalLearningProgressCorrectionReason,
].forEach((field) => {
  field?.addEventListener(field === el.portalLearningProgressCorrectionReason ? "input" : "change", updatePortalLearningProgressAvailability);
});
document.querySelectorAll("[data-close-portal-learning-progress]").forEach((button) => {
  button.addEventListener("click", () => el.portalLearningProgressDialog.close());
});
el.portalLearningProgressDialog?.addEventListener("close", () => {
  portalState.personnelLearningProgressAssignment = null;
  message(el.portalLearningProgressMessage, "");
});
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
el.timeTrackingRefresh.addEventListener("click", () => Promise.allSettled([loadPortalHome(), loadTimeTracking()]));
el.privacyRequestForm?.addEventListener("submit", submitPrivacyRequest);
el.privacyRequestsRefresh?.addEventListener("click", loadPrivacyRequests);
el.privacyRequestList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-withdraw-privacy-request]");
  if (button) withdrawPrivacyRequest(button.dataset.withdrawPrivacyRequest);
});
el.vacationAccountYear?.addEventListener("change", () => {
  portalState.vacationAccountYear = el.vacationAccountYear.value;
  portalState.vacationAccount = null;
  loadVacationAccount();
});
el.wifiAutomationToggle?.addEventListener("change", setWifiAutomationPreference);
el.wifiSuggestionList?.addEventListener("click", (event) => {
  const action = event.target.closest("[data-wifi-confirm],[data-wifi-reject]");
  if (action) decideWifiSuggestion(action);
  const week = event.target.closest("[data-wifi-confirm-week]");
  if (week) confirmWifiSuggestionWeek(week.dataset.wifiConfirmWeek);
});
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
document.querySelectorAll("[data-request-tab]").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.requestTab)));
el.previousWeek.addEventListener("click", () => { portalState.weekStart = addDays(portalState.weekStart, -7); loadSchedule(); });
el.nextWeek.addEventListener("click", () => { portalState.weekStart = addDays(portalState.weekStart, 7); loadSchedule(); });
el.currentWeek.addEventListener("click", () => { portalState.weekStart = mondayOf(new Date()); loadSchedule(); });
el.branchVacationPrevious?.addEventListener("click", () => { portalState.branchVacationWeekStart = addDays(portalState.branchVacationWeekStart, -7); loadBranchVacationOverview(); });
el.branchVacationNext?.addEventListener("click", () => { portalState.branchVacationWeekStart = addDays(portalState.branchVacationWeekStart, 7); loadBranchVacationOverview(); });
el.branchVacationCurrent?.addEventListener("click", () => { portalState.branchVacationWeekStart = mondayOf(new Date()); loadBranchVacationOverview(); });
  el.branchOrderRefresh?.addEventListener("click", () => {
    if (portalState.branchOrderDraftDirty) {
      message(el.branchOrderMessage, "Bitte den Entwurf vor dem Aktualisieren speichern oder verwerfen.", true);
      return;
    }
    Promise.allSettled([loadBranchOrderCatalog(), loadBranchOrderPortalHistory()]);
  });
  el.branchOrderForm?.addEventListener("submit", submitBranchOrder);
el.branchOrderEmployee?.addEventListener("change", () => {
  const nextEmployeeNumber = String(el.branchOrderEmployee.value || "").trim();
  if (portalState.branchOrderDraftDirty
    && portalState.branchOrderDraftEmployeeNumber
    && nextEmployeeNumber !== portalState.branchOrderDraftEmployeeNumber) {
    el.branchOrderEmployee.value = portalState.branchOrderDraftEmployeeNumber;
    message(el.branchOrderMessage, "Bitte den begonnenen Entwurf zuerst speichern oder verwerfen.", true);
    return;
  }
  loadBranchOrderDraft(nextEmployeeNumber);
});
el.branchOrderGroups?.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-branch-order-select]");
  const row = event.target.closest("[data-branch-order-item]");
  if (!row) return;
  const itemId = String(row.dataset.branchOrderItem || "");
  if (!itemId) return;
  if (checkbox) {
    if (checkbox.checked) {
      const quantity = Number(row.querySelector("[data-branch-order-quantity]")?.value || 1);
      branchOrderSelection().set(itemId, { quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1, note: row.querySelector("[data-branch-order-note]")?.value || "" });
    } else {
      branchOrderSelection().delete(itemId);
    }
  } else if (event.target.closest("[data-branch-order-quantity], [data-branch-order-note]")) {
    const current = branchOrderSelection().get(itemId);
    if (current) {
      current.quantity = Number(row.querySelector("[data-branch-order-quantity]")?.value || "");
      current.note = row.querySelector("[data-branch-order-note]")?.value || "";
    }
  } else return;
  syncBranchOrderItemRepresentations(itemId);
  portalState.branchOrderDraftDirty = true;
  portalState.branchOrderReviewVisible = false;
  renderBranchOrderDraftState();
});
el.branchOrderGroups?.addEventListener("input", (event) => {
  if (!event.target.closest("[data-branch-order-quantity], [data-branch-order-note]")) return;
  const row = event.target.closest("[data-branch-order-item]");
  const itemId = String(row?.dataset.branchOrderItem || "");
  const current = branchOrderSelection().get(itemId);
  if (!current) return;
  current.quantity = row.querySelector("[data-branch-order-quantity]")?.value || "";
  current.note = row.querySelector("[data-branch-order-note]")?.value || "";
  syncBranchOrderItemRepresentations(itemId, { sourceRow: row });
  portalState.branchOrderDraftDirty = true;
  portalState.branchOrderReviewVisible = false;
  renderBranchOrderDraftState();
});
el.branchOrderSaveDraft?.addEventListener("click", saveBranchOrderDraft);
el.branchOrderContinueDraft?.addEventListener("click", applyPendingBranchOrderDraft);
el.branchOrderDiscardDraft?.addEventListener("click", discardBranchOrderDraft);
el.branchOrderBackToEdit?.addEventListener("click", () => setBranchOrderReviewVisible(false));
el.branchMobileBack?.addEventListener("click", branchMobileBack);
el.branchMobileReview?.addEventListener("click", () => setBranchOrderReviewVisible(true));
el.branchMobileSave?.addEventListener("click", () => saveBranchOrderDraft());
el.branchMobileSubmit?.addEventListener("click", () => submitBranchOrder());
el.refreshBranchOrderSettings?.addEventListener("click", loadBranchOrderSettings);
el.saveBranchOrderSettings?.addEventListener("click", saveBranchOrderSettings);
el.branchPortalDisplaySettingsForm?.addEventListener("submit", saveBranchPortalDisplaySettings);
el.refreshBranchOrderHistory?.addEventListener("click", loadBranchOrderHistory);
  el.branchOrderPortalHistoryRefresh?.addEventListener("click", loadBranchOrderPortalHistory);
function moveBranchOrderDraftEntry(entries, id, direction) {
  const index = entries.findIndex((entry) => (typeof entry === "string" ? entry : entry.id) === id);
  const target = index + Number(direction || 0);
  if (index < 0 || target < 0 || target >= entries.length) return;
  [entries[index], entries[target]] = [entries[target], entries[index]];
}
function updateBranchOrderSettingsDraft(event) {
  const field = event.target.closest("[data-branch-order-settings-field]");
  if (!field || !portalState.branchOrderSettingsDraft) return;
  const key = field.dataset.branchOrderSettingsField;
  const recipient = field.closest("[data-branch-order-recipient]");
  const group = field.closest("[data-branch-order-group-editor]");
  const item = field.closest("[data-branch-order-catalog-item]");
  const unit = field.closest("[data-branch-order-unit-editor]");
  if (recipient) {
    const target = branchOrderDraftRecipient(recipient.dataset.branchOrderRecipient);
    if (!target) return;
    if (key === "recipient-email") target.email = field.value;
    if (key === "recipient-cc-email") target.ccEmail = field.value;
    if (key === "recipient-primary-delivery-mode") target.primaryDeliveryMode = normalizedBranchOrderDeliveryMode(field.value);
    if (key === "recipient-cc-delivery-mode") target.ccDeliveryMode = normalizedBranchOrderDeliveryMode(field.value);
    if (key === "recipient-reply-to") target.replyToEmail = field.value;
    if (key === "recipient-subject") target.subjectTemplate = field.value;
    if (key === "recipient-body") target.bodyTemplate = field.value;
    return;
  }
  if (unit) {
    const target = branchOrderDraftUnit(unit.dataset.branchOrderUnitEditor);
    if (target && key === "unit-title") target.title = field.value;
    return;
  }
  if (item) {
    const target = branchOrderDraftItem(item.dataset.branchOrderCatalogItem);
    if (!target) return;
    if (key === "catalog-item-title") target.title = field.value;
    if (key === "catalog-item-unit") target.unitId = field.value;
    if (key === "catalog-item-recipient") target.recipientId = field.value;
    return;
  }
  if (group) {
    const target = branchOrderDraftGroup(group.dataset.branchOrderGroupEditor);
    if (!target) return;
    if (key === "group-title") target.title = field.value;
    if (key === "group-hint") target.hint = field.value;
  }
}
function captureBranchOrderSettingsDraft() {
  el.branchOrderSettingsWorkspace?.querySelectorAll("[data-branch-order-settings-field]")
    .forEach((field) => updateBranchOrderSettingsDraft({ target: field }));
  return portalState.branchOrderSettingsDraft;
}
el.branchOrderSettingsWorkspace?.addEventListener("input", updateBranchOrderSettingsDraft);
el.branchOrderSettingsWorkspace?.addEventListener("change", updateBranchOrderSettingsDraft);
el.branchOrderSettingsWorkspace?.addEventListener("click", (event) => {
  const draft = portalState.branchOrderSettingsDraft;
  if (!draft) return;
  if (event.target.closest("[data-branch-order-add-recipient]")) {
    const defaults = portalState.branchOrderSettings?.configuration?.templateDefaults || {};
    draft.recipients.push({
      id: branchOrderClientId("recipient"),
      email: "",
      ccEmail: "",
      primaryDeliveryMode: "message",
      ccDeliveryMode: "message",
      replyToEmail: "",
      subjectTemplate: defaults.subjectTemplate || "Filialbestellung {{locationName}} · KW {{calendarWeek}}",
      bodyTemplate: defaults.bodyTemplate || "{{items}}",
    });
    renderBranchOrderSettings();
    return;
  }
  const removeRecipient = event.target.closest("[data-branch-order-remove-recipient]");
  if (removeRecipient) {
    const id = removeRecipient.dataset.branchOrderRemoveRecipient;
    draft.recipients = draft.recipients.filter((recipient) => recipient.id !== id);
    draft.items.forEach((item) => { if (item.recipientId === id) item.recipientId = ""; });
    renderBranchOrderSettings();
    return;
  }
  const sortUnits = event.target.closest("[data-branch-order-sort-units]");
  if (sortUnits) {
    const key = sortUnits.dataset.branchOrderSortUnits;
    const current = normalizedBranchOrderSettingsUnitSort();
    portalState.branchOrderSettingsUnitSort = {
      key: branchOrderSettingsUnitColumns.some((column) => column.key === key) ? key : "position",
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    };
    renderBranchOrderSettings();
    return;
  }
  if (event.target.closest("[data-branch-order-add-unit]")) {
    const titleField = el.branchOrderSettingsWorkspace.querySelector("[data-branch-order-new-unit-title]");
    const title = String(titleField?.value || "").trim();
    if (!title) {
      message(el.branchOrderSettingsMessage, "Bitte eine Bezeichnung für die neue Maßeinheit eingeben.", true);
      titleField?.focus();
      return;
    }
    const id = branchOrderClientId("unit");
    draft.units.push({ id, title });
    portalState.branchOrderSettingsUnitEditingId = id;
    renderBranchOrderSettings();
    revealBranchOrderUnitEditor(id);
    return;
  }
  const editUnit = event.target.closest("[data-branch-order-edit-unit]");
  if (editUnit) {
    const id = editUnit.dataset.branchOrderEditUnit;
    if (!draft.units.some((unit) => unit.id === id)) return;
    portalState.branchOrderSettingsUnitEditingId = id;
    renderBranchOrderSettings();
    revealBranchOrderUnitEditor(id);
    return;
  }
  const removeUnit = event.target.closest("[data-branch-order-remove-unit]");
  if (removeUnit) {
    const id = removeUnit.dataset.branchOrderRemoveUnit;
    if (draft.items.some((item) => item.unitId === id)) {
      message(el.branchOrderSettingsMessage, "Diese Einheit wird noch von einer Position verwendet.", true);
      return;
    }
    draft.units = draft.units.filter((unit) => unit.id !== id);
    if (portalState.branchOrderSettingsUnitEditingId === id) {
      portalState.branchOrderSettingsUnitEditingId = "";
    }
    renderBranchOrderSettings();
    return;
  }
  const moveUnit = event.target.closest("[data-branch-order-move-unit]");
  if (moveUnit) {
    moveBranchOrderDraftEntry(draft.units, moveUnit.dataset.branchOrderMoveUnit, Number(moveUnit.dataset.direction));
    portalState.branchOrderSettingsUnitSort = { key: "position", direction: "asc" };
    renderBranchOrderSettings();
    return;
  }
  if (event.target.closest("[data-branch-order-add-catalog-item]")) {
    const defaultUnit = draft.units[0]?.id || "";
    if (!defaultUnit) {
      message(el.branchOrderSettingsMessage, "Bitte zuerst mindestens eine Einheit anlegen.", true);
      return;
    }
    draft.items.push({ id: branchOrderClientId("item"), title: "Neue Position", unitId: defaultUnit, recipientId: draft.recipients[0]?.id || "" });
    renderBranchOrderSettings();
    return;
  }
  const removeCatalogItem = event.target.closest("[data-branch-order-remove-catalog-item]");
  if (removeCatalogItem) {
    const id = removeCatalogItem.dataset.branchOrderRemoveCatalogItem;
    draft.items = draft.items.filter((item) => item.id !== id);
    draft.groups.forEach((group) => { group.itemIds = group.itemIds.filter((itemId) => itemId !== id); });
    renderBranchOrderSettings();
    return;
  }
  if (event.target.closest("[data-branch-order-add-group]")) {
    draft.groups.push({
      id: branchOrderClientId("group"),
      title: "Neue Anzeigegruppe",
      hint: "",
      itemIds: [],
    });
    renderBranchOrderSettings();
    return;
  }
  const removeGroup = event.target.closest("[data-branch-order-remove-group]");
  if (removeGroup) {
    draft.groups = draft.groups.filter((group) => group.id !== removeGroup.dataset.branchOrderRemoveGroup);
    renderBranchOrderSettings();
    return;
  }
  const moveGroup = event.target.closest("[data-branch-order-move-group]");
  if (moveGroup) {
    moveBranchOrderDraftEntry(draft.groups, moveGroup.dataset.branchOrderMoveGroup, Number(moveGroup.dataset.direction));
    renderBranchOrderSettings();
    return;
  }
  const sortGroupItems = event.target.closest("[data-branch-order-sort-group-items]");
  if (sortGroupItems) {
    const group = branchOrderDraftGroup(sortGroupItems.dataset.branchOrderSortGroupItems);
    if (group) sortBranchOrderGroupItemIdsAlphabetically(group, draft.items);
    renderBranchOrderSettings();
    return;
  }
  const addGroupItem = event.target.closest("[data-branch-order-add-group-item]");
  if (addGroupItem) {
    const groupId = addGroupItem.dataset.branchOrderAddGroupItem;
    const selected = el.branchOrderSettingsWorkspace.querySelector(`[data-branch-order-group-item-select="${CSS.escape(groupId)}"]`)?.value || "";
    const group = branchOrderDraftGroup(groupId);
    if (group && selected && !group.itemIds.includes(selected)) group.itemIds.push(selected);
    renderBranchOrderSettings();
    return;
  }
  const removeGroupItem = event.target.closest("[data-branch-order-remove-group-item]");
  if (removeGroupItem) {
    const group = branchOrderDraftGroup(removeGroupItem.dataset.branchOrderRemoveGroupItem);
    if (group) group.itemIds = group.itemIds.filter((id) => id !== removeGroupItem.dataset.itemId);
    renderBranchOrderSettings();
    return;
  }
  const moveGroupItem = event.target.closest("[data-branch-order-move-group-item]");
  if (moveGroupItem) {
    const group = branchOrderDraftGroup(moveGroupItem.dataset.branchOrderMoveGroupItem);
    if (group) moveBranchOrderDraftEntry(group.itemIds, moveGroupItem.dataset.itemId, Number(moveGroupItem.dataset.direction));
    renderBranchOrderSettings();
  }
});
el.branchOrderSettingsWorkspace?.addEventListener("keydown", (event) => {
  const field = event.target.closest("[data-branch-order-new-unit-title]");
  if (!field || event.key !== "Enter") return;
  event.preventDefault();
  el.branchOrderSettingsWorkspace.querySelector("[data-branch-order-add-unit]")?.click();
});
el.loanRefresh?.addEventListener("click", loadLoanModule);
el.loanOverviewSearch?.addEventListener("input", renderLoanOverview);
[["issue", el.loanIssuePhotos], ["issue", el.loanIssueCamera], ["return", el.loanReturnPhotos], ["return", el.loanReturnCamera]]
  .forEach(([phase, input]) => input?.addEventListener("change", () => {
    addLoanPhotoFiles(phase, input.files);
    input.value = "";
  }));
[el.loanIssuePhotoSummary, el.loanReturnPhotoSummary].forEach((summary) => summary?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-loan-photo-remove]");
  if (!button) return;
  const files = [...loanPhotoFiles(button.dataset.loanPhotoPhase)];
  files.splice(Number(button.dataset.loanPhotoRemove), 1);
  setLoanPhotoFiles(button.dataset.loanPhotoPhase, files);
}));
el.loanAddItem?.addEventListener("click", () => {
  if (portalState.loanDraftItems.length >= 5) return;
  portalState.loanDraftItems.push(newLoanDraftItem());
  renderLoanDraftItems();
});
el.loanItemEditor?.addEventListener("input", (event) => {
  const field = event.target.closest("[data-loan-field]");
  if (!field) return;
  const item = portalState.loanDraftItems[Number(field.dataset.loanIndex)];
  if (!item) return;
  item[field.dataset.loanField] = field.value;
  if (field.dataset.loanField === "identifier") {
    item.identifier = item.identifier.replace(/\D/g, "").slice(0, 14);
    field.value = item.identifier;
    item.resolved = null;
    item.error = "";
    item.needsManual = false;
  }
});
el.loanItemEditor?.addEventListener("change", (event) => {
  const field = event.target.closest("[data-loan-field]");
  if (!field) return;
  const item = portalState.loanDraftItems[Number(field.dataset.loanIndex)];
  if (item) item[field.dataset.loanField] = field.value;
});
el.loanItemEditor?.addEventListener("click", (event) => {
  const resolveButton = event.target.closest("[data-loan-resolve]");
  if (resolveButton) {
    resolveLoanDraftItem(Number(resolveButton.dataset.loanResolve));
    return;
  }
  const removeButton = event.target.closest("[data-loan-remove]");
  if (!removeButton) return;
  portalState.loanDraftItems.splice(Number(removeButton.dataset.loanRemove), 1);
  renderLoanDraftItems();
});
el.loanIssueForm?.addEventListener("submit", submitLoanIssue);
[el.loanScope, el.loanStatusFilter].forEach((field) => field?.addEventListener("change", loadLoans));
el.loanList?.addEventListener("click", (event) => {
  const returnButton = event.target.closest("[data-loan-return]");
  if (returnButton) {
    openLoanReturn(returnButton.dataset.loanReturn);
    return;
  }
  const manageButton = event.target.closest("[data-loan-manage]");
  if (manageButton) openLoanManagement(manageButton.dataset.loanManage);
});
el.loanReturnForm?.addEventListener("submit", submitLoanReturn);
el.loanReturnWitness?.addEventListener("change", () => {
  const canManage = portalState.loanStatus?.permissions?.locationManage === true;
  el.loanReturnSubmit.textContent = el.loanReturnWitness.value
    ? "Gegenprüfung anfordern"
    : (canManage ? "Rücknahme abschließen" : "Rücknahme speichern");
});
el.loanManageForm?.addEventListener("submit", submitLoanManagement);
el.loanManageClose?.addEventListener("click", () => runLoanManagementAction("close"));
el.loanManageReopen?.addEventListener("click", () => runLoanManagementAction("reopen"));
el.loanConfirmationForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  respondToLoanConfirmation("confirm");
});
el.loanConfirmationReject?.addEventListener("click", () => respondToLoanConfirmation("reject"));
el.loanConfirmationDialog?.addEventListener("cancel", (event) => event.preventDefault());
document.querySelectorAll("[data-close-loan-return]").forEach((button) => button.addEventListener("click", () => {
  el.loanReturnDialog.close();
  portalState.selectedLoan = null;
  setLoanPhotoFiles("return", []);
}));
document.querySelectorAll("[data-close-loan-manage]").forEach((button) => button.addEventListener("click", () => {
  el.loanManageDialog.close();
  portalState.selectedManagedLoan = null;
}));
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
el.birthdayPresentationClose?.addEventListener("click", closeBirthdayPresentation);
el.birthdayPresentationConfirm?.addEventListener("click", closeBirthdayPresentation);
el.birthdayPresentationDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeBirthdayPresentation();
});
el.birthdayPresentationGraphic?.addEventListener("error", () => neutralizeBirthdayPresentation());
el.notificationList.addEventListener("click", (event) => {
  const item = event.target.closest("[data-notification-id]");
  if (item) readNotification(item.dataset.notificationId);
});
el.markAllNotificationsRead.addEventListener("click", markAllNotificationsRead);
el.refreshProcessTasks?.addEventListener("click", loadProcessTasks);
el.processTaskList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-complete-process-task]");
  const card = button?.closest("[data-process-task-key]");
  if (!button || !card || button.disabled) return;
  const task = portalState.processTasks.find((entry) => entry.key === card.dataset.processTaskKey);
  if (task) completeProcessTask(task, card);
});
el.processTaskList?.addEventListener("input", (event) => {
  const note = event.target.closest("[data-process-task-note]");
  const card = note?.closest("[data-process-task-key]");
  if (note && card && !portalState.processTaskCompletionPayloads.has(card.dataset.processTaskKey)) {
    portalState.processTaskNotes.set(card.dataset.processTaskKey, note.value);
  }
});
el.sicknessCaseForm.addEventListener("submit", submitSicknessCase);
el.sicknessCaseList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-sickness-case-id]");
  if (!row) return;
  if (event.target.closest("[data-withdraw-sickness]")) withdrawSicknessCase(row.dataset.sicknessCaseId);
  else if (event.target.closest("[data-add-amu]")) openAmuForSicknessCase(row.dataset.sicknessCaseId);
  else if (event.target.closest("[data-recover-sickness]")) openSicknessRecovery(row.dataset.sicknessCaseId);
});
el.sicknessRecoveryForm?.addEventListener("submit", submitSicknessRecovery);
[el.sicknessRecoveryClose, el.sicknessRecoveryCancel].forEach((button) => button?.addEventListener("click", () => el.sicknessRecoveryDialog.close()));
el.amuReportForm.addEventListener("submit", submitAmuReport);
el.amuSicknessCaseId.addEventListener("change", selectSicknessCaseForAmu);
el.amuDocuments.addEventListener("change", handleAmuFileSelection);
el.amuCamera.addEventListener("change", handleAmuFileSelection);
el.sicknessAmuDocuments?.addEventListener("change", handleAmuFileSelection);
el.sicknessAmuCamera?.addEventListener("change", handleAmuFileSelection);
el.amuReportList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-withdraw-amu]");
  const report = button?.closest("[data-amu-report-id]");
  if (report) withdrawAmuReport(report.dataset.amuReportId);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && portalState.session) {
    refreshBirthdayPresentationTheme();
    Promise.allSettled([loadNotifications(), loadProcessTasks(), loadPendingCandidateEvaluations()]);
    if (portalState.activeTab === "timeTracking") Promise.allSettled([loadPortalHome(), loadTimeTracking()]);
    if (portalState.activeTab === "settings") {
      const settingsRefreshes = [loadWifiAutomation()];
      if (personalEmailSettingsAvailable()) settingsRefreshes.push(loadEmailSettings());
      Promise.allSettled(settingsRefreshes);
    }
    if (portalState.activeTab === "leadershipTeam") loadLeadershipOverview();
    if (portalState.activeTab === "leadershipApprovals") loadLeadershipApprovals();
    if (loanCapabilityEnabled()) loadPendingLoanConfirmations();
  }
});
setInterval(() => {
  if (!document.hidden && portalState.session && loanCapabilityEnabled()) {
    loadPendingLoanConfirmations();
    if (portalState.activeTab === "loan" && portalState.loanStatus?.available) loadLoans();
  }
}, 5000);
setInterval(() => {
  if (!document.hidden && portalState.session) {
    Promise.allSettled([loadNotifications(), loadProcessTasks(), loadPendingCandidateEvaluations()]);
  }
}, 45000);
setInterval(() => {
  if (!document.hidden && portalState.session && portalState.activeTab === "timeTracking") loadTimeTracking();
  if (!document.hidden && portalState.session && portalState.activeTab === "settings") loadWifiAutomation();
}, 30000);
setInterval(() => {
  if (!document.hidden && portalState.session && portalState.activeTab === "leadershipTeam") loadLeadershipOverview();
}, 30000);

initializeDateRangeCalendar();
initialize();
