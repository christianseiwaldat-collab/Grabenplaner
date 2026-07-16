const state = {
  weekStart: getMonday(new Date()),
  vacationYear: new Date().getFullYear(),
  vacationViewMode: "year",
  vacationQuarter: Math.floor(new Date().getMonth() / 3) + 1,
  vacationMonth: new Date().getMonth() + 1,
  locationId: "",
  departmentId: "",
  data: null,
  vacationData: null,
  locations: [],
  positions: [],
  brandingKits: [],
  portalStatus: null,
  portalSession: null,
  desiredOperationMode: null,
  portalUsers: [],
  portalRoles: [],
  portalPermissionCatalog: [],
  approvalDelegations: [],
  requestBlackouts: [],
  absenceRequests: [],
  amuReports: [],
  amuCanOpenFiles: false,
  requestCounts: { vacation: 0, timeOff: 0, amu: 0, total: 0 },
  requestKindTab: "vacation",
  currentView: "planning",
  timePresence: null,
  timeDayReview: null,
  timeSummary: null,
  timeCorrections: [],
  rightsManagement: null,
  brandingAssignments: [],
  brandingPreference: null,
  brandingFormDirty: false,
  mobileLeadershipSettings: null,
  selectedRightsEmployeeNumber: "",
  employeeAccessDraft: new Set(),
  amuPolicy: null,
  wifiAutomationSettings: null,
  greetingSettings: null,
  selectedRequest: null,
  allEmployees: [],
  updateStatus: null,
  selectedColor: "#0b84c6",
  integrations: {
    importCatalog: null,
    payrollCatalog: null,
    profiles: [],
    runs: [],
    inspection: null,
    preview: null,
    payrollPreflight: null,
  },
  employeeEditMode: "full",
  personnelTab: "employees",
  editingLocationId: null,
  editingDepartmentId: null,
  editingPositionId: null,
  editingVacationEntitlements: false,
  editingOptionId: null,
  editingOptionGroupId: null,
  editingGlobalBlockId: null,
  editingVacationGroupId: null,
  editingRequestBlackoutId: null,
  usbProvisioning: {
    metadata: null,
    step: "profile",
    selectedDriveToken: "",
    creatorEmployeeNumber: "",
    selectedEmployees: new Set(),
    employeeDrafts: [],
    employeeOverrides: new Map(),
  },
};

function applyDeviceMode() {
  const compact = window.matchMedia("(max-width: 760px)").matches;
  const touch = window.matchMedia("(pointer: coarse)").matches;
  const mobileHint = navigator.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  document.documentElement.dataset.uiMode = compact || (touch && mobileHint) ? "mobile" : "desktop";
  document.documentElement.dataset.inputMode = touch ? "touch" : "pointer";
  document.querySelector("#compactAdminNotice")?.classList.toggle("hidden", document.documentElement.dataset.uiMode !== "mobile");
}
applyDeviceMode();
window.addEventListener("resize", applyDeviceMode, { passive: true });

let scheduleNoteQuill = null;
let scheduleNoteSanitizing = false;

const optionLabels = {
  vacation: "Urlaub",
  sick: "Krank",
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
const planningDayKeys = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const dayKeyByNumber = { 1: "monday", 2: "tuesday", 3: "wednesday", 4: "thursday", 5: "friday", 6: "saturday" };
const preferredDayLabels = { monday: "Montag", tuesday: "Dienstag", wednesday: "Mittwoch", thursday: "Donnerstag", friday: "Freitag" };
const fixedDayLabels = { ...preferredDayLabels, saturday: "Samstag" };
const fixedDayShortLabels = { monday: "Mo", tuesday: "Di", wednesday: "Mi", thursday: "Do", friday: "Fr", saturday: "Sa" };

const elements = Object.fromEntries(
  [
    "planningView", "requestsView", "timeTrackingView", "vacationsView", "personnelView", "settingsView", "planningNavChildren", "vacationNavChildren", "requestsNavButton", "requestsNavCount", "timeTrackingNavButton", "timeTrackingLocation", "timeTrackingDepartment", "refreshTimePresenceButton", "timePresenceSummary", "timePresenceList", "timePresenceUpdated", "weekTitle", "calendarWeek", "scheduleTitle", "shiftCount",
    "totalHours", "inStoreHours", "optionCount", "employeeCount", "sidebarEmployeeCount", "sidebarVersion", "sidebarSessionInfo", "sidebarSessionRole", "sidebarSessionIdentity", "sidebarSessionPosition", "pdfButton", "timeline", "weekLockNotice",
    "remarks", "hoursOverview", "systemData", "versionLabel", "breakRuleHint", "saturdayRuleHint", "saveSettingsButton", "generalSettings", "brandingSettings", "pdfSettings", "personnelSettings", "integrationSettings", "wifiAutomationSettings", "backupSettings", "rightsSettings", "employeeSettings",
    "scheduleNoteButton", "scheduleNoteButtonHint", "scheduleNoteModal", "scheduleNoteForm", "scheduleNoteEditor", "scheduleNoteCounter", "deleteScheduleNoteButton",
    "vacationTitle", "vacationSubtitle", "vacationYear", "vacationViewMode", "vacationQuarter", "vacationMonth", "vacationQuarterField", "vacationMonthField",
    "vacationSummary", "vacationCalendar", "vacationCalendarTitle", "vacationPdfButton", "addVacationButton", "saveEntitlementsButton", "editEntitlementsButton", "managerVacationRequestList", "refreshRequestsButton", "requestWorkflowSummary", "requestStatusFilter", "vacationRequestCount", "timeOffRequestCount", "amuRequestCount",
    "requestBlackoutPanel", "requestBlackoutForm", "requestBlackoutId", "requestBlackoutLocation", "requestBlackoutDepartment", "requestBlackoutDateFrom", "requestBlackoutDateTo", "requestBlackoutReason", "requestBlackoutVacation", "requestBlackoutTimeOff", "requestBlackoutActive", "requestBlackoutSubmit", "cancelRequestBlackoutEdit", "addRequestBlackoutButton", "requestBlackoutList",
    "vacationModal", "vacationForm", "vacationModalTitle", "vacationSubmitButton", "vacationEmployee", "vacationDateFrom", "vacationDateTo", "vacationNote", "vacationCalculation",
    "employeeTableBody", "employeeModal", "employeeForm", "employeeModalTitle", "employeeEditScopeHint", "deleteEmployeeButton", "employeeHomeLocation", "employeePreferredDepartment", "employeePosition", "employeeTimeConfirmationLevelField", "employeeTimeConfirmationLevel",
    "employeeAccessProfile", "employeeAccessStatus", "employeeAppRole", "employeeAppRoleDescription", "employeeRolePermissions", "employeeAdditionalRightsDetails", "employeeAdditionalRights", "employeeAdditionalRightsCount", "employeeAccessHint",
    "employeeSettings", "locationSettings", "locationFormCard", "departmentFormCard", "locationEditorModal", "departmentEditorModal", "addLocationButton", "addDepartmentButton", "locationForm", "locationId", "locationName", "locationMinStaff", "locationActive", "locationTimeTrackingEnabled", "locationTimeTrackingAccessMode", "locationTimeTrackingAllowedNetworks", "locationTimeTrackingVarianceMinutes", "locationSubmitButton", "cancelLocationEditButton",
    "departmentForm", "departmentId", "departmentLocation", "departmentName", "departmentMinStaff", "departmentActive", "departmentSubmitButton", "cancelDepartmentEditButton", "locationList",
    "shiftModal", "shiftForm", "shiftModalTitle", "deleteShiftButton", "shiftCalculation", "shiftDepartment", "departmentPdfControl", "departmentPdfSelect", "departmentPdfButton",
    "optionsModal", "optionForm", "optionList", "optionsWeekLabel", "optionsWeekRange", "optionPreviousWeek", "optionNextWeek", "globalBlockDate", "globalBlockReason", "globalBlockHoliday", "globalBlockSubmitButton", "optionSubmitButton", "cancelOptionEditButton", "autoPlanModal",
    "autoPlanForm", "autoPlanWeek", "resetWeekModal", "resetWeekForm", "resetWeekText", "schedulePdfPreviewButton", "schedulePdfPreviewFrame", "vacationPdfPreviewButton", "vacationPdfPreviewFrame", "appBackupDirectoryText",
    "positionForm", "positionId", "positionName", "positionSubmitButton", "cancelPositionEditButton", "positionList", "updateCheckButton", "updateCheckIcon", "updateCheckText", "updateCheckHint", "systemExitButton",
    "localModeOption", "localModeBadge", "serverModeOption", "serverModeBadge", "publicServerModeOption", "publicServerModeBadge", "saveOperationModeButton", "portalFoundationHint", "adminAccessModeLabel", "accessSettings", "portalUserList", "accessSettingsHint", "adminSetupButton", "adminSetupModal", "adminSetupForm", "adminSetupEmployee", "adminSetupPassword", "adminSetupPasswordRepeat",
    "rightsManagementHint", "rightsEmployeeSearch", "rightsUserList", "rightsEditorModal", "rightsEditorForm", "rightsEditorTitle", "rightsEditorSummary", "rightsEditorPermissions", "rightsEditorHint", "saveRightsEditorButton", "mobileLeadershipModuleSettings", "mobileLeadershipSettingsHint", "saveMobileLeadershipSettingsButton", "positionSettingsCard", "personnelViewSettingsCard",
    "serverDiagnostics", "refreshServerDiagnosticsButton",
    "delegationSettingsCard", "delegationForm", "delegationLocation", "delegationEmployee", "delegationDateFrom", "delegationDateTo", "delegationNote", "delegationList",
    "workflowSettingsCard", "vacationHrApprovalRequired", "workflowSettingsHint", "currentWeekAutoLock", "currentWeekLockSettings", "currentWeekLockMode", "manualWeekLockFields", "currentWeekLockDay", "currentWeekLockTime", "currentWeekLockHint",
    "amuSettingsCard", "amuUploadMaxMb", "amuStoredMaxMb", "amuConvertImagesToPdf", "amuGrayscaleImages", "amuOcrEnabled", "amuManagerFileAccess", "sicknessLocalWarningDays", "sicknessHrWarningDays", "amuSettingsHint", "saveAmuSettingsButton",
    "greetingSettingsCard", "personalizedGreetingsEnabled", "greetingVacationMinimumDays", "greetingReturnWorkdays", "greetingRecoveryWorkdays", "greetingMorningTemplates", "greetingDaytimeTemplates", "greetingEveningTemplates", "greetingVacationTemplates", "greetingSicknessActiveTemplates", "greetingSicknessReturnTemplates", "greetingSettingsHint", "saveGreetingSettingsButton",
    "wifiMinimumPresenceMinutes", "wifiAbsenceGraceMinutes", "wifiAutomationStatus", "wifiAutomationSettingsHint", "saveWifiAutomationSettingsButton", "wifiConnectorDetails", "wifiLocationMappingList", "saveWifiLocationMappingsButton", "wifiConfirmationLevelSearch", "wifiConfirmationLevelList", "wifiConfirmationLevelHint", "saveWifiConfirmationLevelsButton",
    "requestActionModal", "requestActionForm", "requestActionTitle", "requestActionSummary", "requestActionHistory", "requestActionDocuments", "requestActionNote", "requestEditFields", "requestEditDateFromField", "requestEditDateToField", "requestEditTimeField", "requestEditDateFrom", "requestEditDateTo", "requestEditStartTime", "requestEditEndTime", "changeApprovedRequestButton", "cancelApprovedRequestButton",
    "loginGate", "loginBrandLogo", "adminLoginForm", "adminLoginPersonnelNumber", "adminLoginPassword", "adminLoginError", "portalLogoutButton", "employeePortalLink", "deploymentBanner", "personnelRecordModal", "personnelRecordTitle", "personnelRecordContent",
    "timeCorrectionModal", "timeCorrectionForm", "timeCorrectionTitle", "timeCorrectionEmployee", "timeCorrectionWorkDate", "timeCorrectionEmployeeLabel", "timeCorrectionDateLabel", "timeCorrectionClockOutTime", "timeCorrectionMessage",
    "timeCorrectionReviewModal", "timeCorrectionReviewForm", "timeCorrectionReviewId", "timeCorrectionReviewSummary", "timeCorrectionReviewEntries", "addTimeCorrectionReviewEntry", "timeCorrectionReviewNote", "timeCorrectionReviewMessage",
    "timeDayReviewPanel", "timeReviewDate", "timeReviewFilter", "loadTimeDayReviewButton", "timeDayReviewSummary", "timeDayReviewList", "timeDayReviewModal", "timeDayReviewForm", "timeDayReviewTitle", "timeDayReviewDetail", "timeDayReviewEmployee", "timeDayReviewWorkDate", "timeDayReviewMetrics", "timeDayReviewIssues", "timeDayReviewNote", "timeDayReviewMessage", "removeTimeDayReviewButton",
    "timeSummaryFrom", "timeSummaryTo", "loadTimeSummaryButton", "timeSummaryList", "timeCorrectionPanel", "timeCorrectionCount", "timeCorrectionRequestList",
    "brandLogo", "footerBrandLogo", "adminContactLink", "brandingCompanyName", "brandingAdminEmail", "brandingLogoUrl", "brandingIconUrl", "brandingLogoAlt", "brandingPreviewLogo", "brandingPreviewTitle", "brandingPreviewCompany", "brandingKitLibrary", "brandingAssignmentList", "exportBrandingButton", "brandingImportFile", "importBrandingButton", "toast",
    "usbProvisioningTab", "usbProvisioningSettings", "usbProvisioningAvailabilityCard", "usbProvisioningAvailability", "usbProvisioningAvailabilityBadge", "usbProvisioningAvailabilityTitle", "usbProvisioningAvailabilityText", "usbProvisioningWizard", "usbWizardDraftStatus", "usbInstallationProfile", "usbInstallationName", "usbModuleSelection", "usbPrimaryBranding", "usbPrimaryBrandingPreview", "usbAdditionalBrandings", "usbBrandingImportFile", "usbImportBrandingButton", "usbCreatorSummary", "usbCreatorEmployee", "usbCreatorPassword", "usbLocationSelection", "usbAddLocationButton", "usbEmployeeSearch", "usbAddEmployeeButton", "usbEmployeeSelection", "usbGuideTitle", "usbGuideIntroduction", "usbGuideNotes", "usbGuideContact", "usbGuideIncludeStartup", "usbGuideIncludeModules", "usbGuideIncludePdf", "usbGuideIncludeBackup", "usbGuidePreviewButton", "usbGuidePreviewFrame", "usbRefreshDrivesButton", "usbDriveList", "usbHideProgramFolder", "usbProtectProgramFiles", "usbProvisioningSummary", "usbFormatConfirmation", "usbFormatConfirmationHint", "usbProvisioningStartButton", "usbWizardActions", "usbWizardPreviousButton", "usbWizardStepHint", "usbWizardNextButton", "usbProvisioningProgressPanel", "usbProvisioningProgressTitle", "usbProvisioningProgressPercent", "usbProvisioningProgressTrack", "usbProvisioningProgressText", "usbProvisioningProgressSteps", "usbProvisioningResultPanel", "usbProvisioningResultText", "usbProvisioningResultDetails", "usbEmployeeDraftModal", "usbEmployeeDraftForm", "usbDraftPersonnelNumber", "usbDraftFullName", "usbDraftNickname", "usbDraftColor", "usbDraftContractedHours", "usbDraftPosition", "usbDraftLocation", "usbDraftDepartment", "usbDraftRole", "usbDraftPassword",
    "employeeImportCard", "importProfileCard", "payrollExportCard", "exportProfileCard", "integrationInformationCard", "integrationHistoryCard", "openPersonnelImportButton", "importProfileList", "exportProfileList", "integrationHistory",
    "payrollProfile", "payrollLocation", "payrollDepartment", "payrollDateFrom", "payrollDateTo", "payrollSourceMode", "payrollLayout", "payrollFormat", "payrollDelimiter", "payrollDecimalSeparator", "payrollColumnSelection", "payrollWageCodeDetails", "payrollWageCodeMap", "payrollAllowDraft", "payrollProfileName", "savePayrollProfileButton", "payrollPreflightButton", "payrollDownloadButton", "payrollPreflightResult",
    "personnelImportModal", "personnelImportForm", "personnelImportProgress", "personnelImportFileStep", "personnelImportMappingStep", "personnelImportPreviewStep", "personnelImportFile", "personnelImportProfile", "personnelImportDuplicateStrategy", "personnelImportDefaultLocation", "personnelImportDefaultPosition", "personnelImportDefaultHours", "inspectPersonnelImportButton", "personnelImportSheet", "personnelImportHeaderRow", "personnelImportMapping", "personnelImportProfileName", "savePersonnelImportProfileButton", "previewPersonnelImportButton", "personnelImportSummary", "personnelImportPreviewBody", "personnelImportPreviewHint", "personnelImportMessage", "resetPersonnelImportButton", "backPersonnelImportButton", "applyPersonnelImportButton",
  ].map((id) => [id, document.querySelector(`#${id}`)]),
);

function getMonday(date) {
  const copy = new Date(date);
  copy.setHours(12, 0, 0, 0);
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  return toIsoDate(copy);
}

function getIsoWeek(isoDate) {
  const date = new Date(`${isoDate}T12:00:00`);
  const target = new Date(date.valueOf());
  const dayNumber = (date.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNumber + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4, 12);
  const firstDayNumber = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNumber + 3);
  return 1 + Math.round((target - firstThursday) / 604800000);
}

function toIsoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(isoDate, amount) {
  const date = new Date(`${isoDate}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return toIsoDate(date);
}

function formatDate(isoDate, options = { day: "2-digit", month: "2-digit", year: "numeric" }) {
  return new Intl.DateTimeFormat("de-AT", options).format(new Date(`${isoDate}T12:00:00`));
}

function formatHours(minutes) {
  return `${new Intl.NumberFormat("de-AT", { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(minutes / 60)} h`;
}

function formatCount(value) {
  const rounded = Math.round(Number(value || 0) * 10) / 10;
  return new Intl.NumberFormat("de-AT", {
    minimumFractionDigits: Number.isInteger(rounded) ? 0 : 1,
    maximumFractionDigits: 1,
  }).format(rounded);
}

function formatDays(days) {
  return `${new Intl.NumberFormat("de-AT", { minimumFractionDigits: days % 1 ? 1 : 0, maximumFractionDigits: 1 }).format(days)} T`;
}

function formatDaysLong(days) {
  const value = Number(days || 0);
  const formatted = new Intl.NumberFormat("de-AT", {
    minimumFractionDigits: value % 1 ? 1 : 0,
    maximumFractionDigits: 1,
  }).format(value);
  return `${formatted} ${value === 1 ? "Tag" : "Tage"}`;
}

function timeToMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function operatingHours(date, settings = state.data.settings) {
  const day = new Date(`${date}T12:00:00`).getDay();
  const key = dayKeyByNumber[day];
  return key && settings[`${key}_open`] !== "0" ? { start: settings[`${key}_start_time`], end: settings[`${key}_end_time`], key } : null;
}

function dayConfig(date, settings = state.data.settings) {
  const hours = operatingHours(date, settings);
  if (!hours) return null;
  return {
    ...hours,
    lunchEnabled: settings[`${hours.key}_lunch_enabled`] === "1",
    lunchStart: settings[`${hours.key}_lunch_start`],
    lunchEnd: settings[`${hours.key}_lunch_end`],
  };
}

function isWeekLocked() {
  return Boolean(state.data?.isPastWeekLocked);
}

function globalBlockForDate(date) {
  return (state.data?.globalDayBlocks || []).find((block) => block.block_date === date);
}

function publicHolidayForDate(date) {
  return (state.data?.publicHolidays || []).find((holiday) => holiday.date === date)
    || (state.vacationData?.publicHolidays || []).find((holiday) => holiday.date === date);
}

function vacationHolidayForDate(date) {
  return (state.vacationData?.publicHolidays || []).some((holiday) => holiday.date === date);
}

function specialCaseFor(employeeNumber, date) {
  return state.data.weekOptions.find(
    (option) => option.employee_number === employeeNumber && date >= option.date_from && date <= option.date_to,
  );
}

function specialCasesFor(employeeNumber, date) {
  return state.data.weekOptions.filter(
    (option) => option.employee_number === employeeNumber && date >= option.date_from && date <= option.date_to,
  );
}

function optionIsAllDay(option) {
  return Number(option?.all_day ?? 1) === 1;
}

function fullDaySpecialCaseFor(employeeNumber, date) {
  return specialCasesFor(employeeNumber, date).find(optionIsAllDay);
}

function formatOptionTime(option) {
  return optionIsAllDay(option) ? "ganztägig" : `${option.start_time}–${option.end_time}`;
}

function fixedWorkdays(employee) {
  return String(employee?.fixed_workdays || "").split(",").filter(Boolean);
}

function employeeCanWorkOnDate(employee, date) {
  const fixedDays = fixedWorkdays(employee);
  const dayKey = dayKeyByNumber[new Date(`${date}T12:00:00`).getDay()];
  return fixedDays.length === 0 || fixedDays.includes(dayKey);
}

function formatFixedWorkdays(value) {
  const days = String(value || "").split(",").filter(Boolean);
  return days.length ? days.map((day) => fixedDayShortLabels[day] || day).join(", ") : "flexibel";
}

function monthName(month, format = "long") {
  return new Intl.DateTimeFormat("de-AT", { month: format }).format(new Date(2026, month - 1, 1));
}

function monthStart(year, month) {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function monthEnd(year, month) {
  return toIsoDate(new Date(year, month, 0, 12));
}

function monthCalendarRange(year, month) {
  const start = getMonday(new Date(`${monthStart(year, month)}T12:00:00`));
  const endMonday = getMonday(new Date(`${monthEnd(year, month)}T12:00:00`));
  return { start, end: addDays(endMonday, 6) };
}

function dateRangesOverlap(startA, endA, startB, endB) {
  return startA <= endB && startB <= endA;
}

function vacationDayCount(dateFrom, dateTo) {
  if (!dateFrom || !dateTo || dateTo < dateFrom) return 0;
  const countSaturday = state.data?.settings?.vacation_count_saturday === "1";
  let days = 0;
  for (let date = dateFrom; date <= dateTo; date = addDays(date, 1)) {
    const day = new Date(`${date}T12:00:00`).getDay();
    if (day === 0) continue;
    if (day === 6 && !countSaturday) continue;
    if (vacationHolidayForDate(date)) continue;
    days += 1;
  }
  return days;
}

function selectedVacationRange() {
  const year = Number(state.vacationYear);
  if (state.vacationViewMode === "quarter") {
    const startMonth = (Number(state.vacationQuarter) - 1) * 3 + 1;
    return {
      start: monthStart(year, startMonth),
      end: monthEnd(year, startMonth + 2),
      months: [startMonth, startMonth + 1, startMonth + 2],
      label: `${state.vacationQuarter}. Quartal ${year}`,
    };
  }
  if (state.vacationViewMode === "month") {
    const month = Number(state.vacationMonth);
    return {
      start: monthStart(year, month),
      end: monthEnd(year, month),
      months: [month],
      label: `${monthName(month)} ${year}`,
    };
  }
  if (state.vacationViewMode === "employees") {
    return {
      start: `${year}-01-01`,
      end: `${year}-12-31`,
      months: [],
      label: `Teamübersicht ${year}`,
    };
  }
  return {
    start: `${year}-01-01`,
    end: `${year}-12-31`,
    months: Array.from({ length: 12 }, (_item, index) => index + 1),
    label: `Jahresübersicht ${year}`,
  };
}

function vacationEntriesInRange(start, end) {
  return (state.vacationData?.vacations || []).filter((vacation) =>
    dateRangesOverlap(vacation.date_from, vacation.date_to, start, end),
  );
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = value ?? "";
  return node.innerHTML;
}

function activeLocations() {
  return (state.locations || []).filter((location) => location.active);
}

function departmentsForLocation(locationId, includeInactive = false) {
  const location = (state.locations || []).find((item) => item.id === locationId);
  const departments = location?.departments || [];
  return includeInactive ? departments : departments.filter((department) => department.active);
}

function currentLocation() {
  return (state.locations || []).find((location) => location.id === state.locationId) || activeLocations()[0] || state.locations[0];
}

function currentDepartment() {
  return departmentsForLocation(state.locationId, true).find((department) => String(department.id) === String(state.departmentId));
}

function contextSearchParams(includeDepartment = true) {
  const params = new URLSearchParams();
  if (state.locationId) params.set("location", state.locationId);
  if (includeDepartment && state.departmentId) params.set("department", state.departmentId);
  return params;
}

function contextQuery(includeDepartment = true) {
  const params = contextSearchParams(includeDepartment);
  const text = params.toString();
  return text ? `&${text}` : "";
}

function setDefaultContext(locations) {
  const active = (locations || []).filter((location) => location.active);
  const fallback = active[0] || locations?.[0];
  if (!fallback) return;
  if (!state.locationId || !locations.some((location) => location.id === state.locationId && location.active)) {
    state.locationId = fallback.id;
    state.departmentId = "";
  }
  const departments = departmentsForLocation(state.locationId);
  if (state.portalSession?.user?.role === "department_manager" && !state.departmentId && departments.length) state.departmentId = String(departments[0].id);
  if (state.departmentId && !departments.some((department) => String(department.id) === String(state.departmentId))) {
    state.departmentId = "";
  }
}

function contrastColor(hex) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 155 ? "#172331" : "#ffffff";
}

async function api(url, options = {}) {
  const csrfToken = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("grabenplaner_csrf="))?.split("=").slice(1).join("=");
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (csrfToken && !["GET", "HEAD"].includes(String(options.method || "GET").toUpperCase())) {
    headers["X-CSRF-Token"] = decodeURIComponent(csrfToken);
  }
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
    if (response.status === 401 && elements.loginGate) showLoginGate("Die Anmeldung ist abgelaufen. Bitte erneut anmelden.");
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

async function rawApi(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const method = String(options.method || "GET").toUpperCase();
  if (!["GET", "HEAD"].includes(method)) Object.assign(headers, csrfHeader());
  let response;
  try {
    response = await fetch(url, { ...options, method, headers });
  } catch (error) {
    throw window.GrabenplanerApiErrors.fromNetwork(error, { hostname: location.hostname });
  }
  if (!response.ok) {
    const detail = await window.GrabenplanerApiErrors.fromResponse(response, {
      hostname: location.hostname,
      fallback: "Die Aktion konnte nicht ausgef\u00fchrt werden.",
    });
    const error = new Error(detail.message);
    error.status = response.status;
    error.code = detail.code;
    if (response.status === 401 && elements.loginGate) showLoginGate("Die Anmeldung ist abgelaufen. Bitte erneut anmelden.");
    throw error;
  }
  return response;
}

function csrfHeader() {
  const value = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("grabenplaner_csrf="))?.split("=").slice(1).join("=");
  return value ? { "X-CSRF-Token": decodeURIComponent(value) } : {};
}

function showLoginGate(message = "") {
  document.body.classList.add("portal-locked");
  elements.loginGate?.classList.remove("hidden");
  if (elements.adminLoginError) {
    elements.adminLoginError.textContent = message;
    elements.adminLoginError.classList.toggle("hidden", !message);
  }
  setTimeout(() => elements.adminLoginPersonnelNumber?.focus(), 50);
}

function hideLoginGate() {
  document.body.classList.remove("portal-locked");
  elements.loginGate?.classList.add("hidden");
}

function renderSidebarSession() {
  const user = state.portalSession?.user;
  const visible = state.portalStatus?.portalEnabled === true && Boolean(user);
  elements.sidebarSessionInfo?.classList.toggle("hidden", !visible);
  if (!visible) return;
  elements.sidebarSessionRole.textContent = user.roleName || user.role || "Angemeldet";
  elements.sidebarSessionIdentity.textContent = `${user.employeeNumber} · ${user.fullName || user.nickname || ""}`;
  elements.sidebarSessionPosition.textContent = user.positionName ? `Position: ${user.positionName}` : "Position: nicht hinterlegt";
}

function applyRoleVisibility() {
  const permissions = state.portalSession?.user?.permissions || [];
  const features = state.portalStatus?.installationFeatures || {};
  const lanActive = state.portalStatus?.portalEnabled === true;
  const serverActive = state.portalStatus?.operationMode === "server";
  const role = state.portalSession?.user?.role || "admin";
  const globalAdministration = !lanActive || ["developer", "it_admin", "admin", "hr"].includes(role);
  const settingsAccess = !lanActive || permissions.includes("settings:write");
  const rightsAccess = globalAdministration && (!lanActive || permissions.includes("rights:read"));
  const brandingAccess = !lanActive || permissions.includes("branding:write");
  const employeeWriteAccess = !lanActive || permissions.includes("employees:write");
  const employeeDisplayWriteAccess = !lanActive || permissions.includes("employees:display:write");
  const locationBaseWriteAccess = !lanActive || permissions.includes("locations:write");
  const departmentWriteAccess = !lanActive || permissions.includes("departments:write");
  const locationWriteAccess = locationBaseWriteAccess || departmentWriteAccess;
  const positionWriteAccess = !lanActive || permissions.includes("positions:write");
  const operationModeAccess = !lanActive || permissions.includes("operation_mode:write");
  const scopeAccess = permissions.includes("scopes:write");
  const employeeReadAccess = employeeWriteAccess || employeeDisplayWriteAccess || permissions.includes("employees:read");
  const timeReadAccess = lanActive && permissions.includes("time:read") && state.portalStatus?.capabilities?.timeTracking;
  const wifiSettingsAccess = !lanActive || permissions.includes("wifi:settings");
  const greetingSettingsAccess = !lanActive || (globalAdministration && permissions.includes("hr:settings"));
  const backupImportAccess = !lanActive || ["developer", "it_admin"].includes(role);
  const usbProvisioningAccess = ["developer", "it_admin", "admin"].includes(role)
    && (!lanActive || permissions.includes("usb:provision"));
  const integrationsEnabled = features.integrations !== false;
  const integrationReadAccess = integrationsEnabled && (!lanActive || permissions.includes("integrations:read"));
  const personnelImportAccess = integrationsEnabled && (!lanActive || permissions.includes("employees:import"));
  const payrollExportAccess = integrationsEnabled && (!lanActive || permissions.includes("payroll:export"));
  const integrationProfileWriteAccess = integrationsEnabled && (!lanActive || permissions.includes("integrations:profiles:write"));
  const integrationAccess = integrationReadAccess || personnelImportAccess || payrollExportAccess || integrationProfileWriteAccess;
  document.querySelectorAll('[data-view="personnel"]').forEach((button) => button.classList.toggle("hidden", !employeeReadAccess));
  document.querySelectorAll('[data-view="vacations"]').forEach((button) => button.classList.toggle("hidden", features.vacation === false));
  elements.requestsNavButton?.classList.toggle("hidden", features.requests === false);
  elements.timeTrackingNavButton?.classList.toggle("hidden", !timeReadAccess || features.timeTracking === false);
  const anySettingsAccess = settingsAccess || scopeAccess || rightsAccess || brandingAccess || positionWriteAccess || operationModeAccess || wifiSettingsAccess || usbProvisioningAccess || integrationAccess;
  document.querySelectorAll('[data-view="settings"]').forEach((button) => button.classList.toggle("hidden", !anySettingsAccess));
  const settingsTabs = {
    general: settingsAccess || operationModeAccess,
    branding: brandingAccess,
    pdf: settingsAccess,
    personnel: settingsAccess || positionWriteAccess,
    integrations: integrationAccess,
    wifiAutomation: wifiSettingsAccess && features.wifiSuggestions !== false && features.timeTracking !== false,
    access: (scopeAccess || permissions.includes("users:write") || globalAdministration)
      && (features.employeePortal !== false || features.requests !== false || features.sicknessAmu !== false),
    rights: rightsAccess,
    backup: !lanActive || permissions.some((permission) => ["backup:write", "update:write", "system:write"].includes(permission)),
    usbProvisioning: usbProvisioningAccess,
  };
  document.querySelectorAll("[data-settings-tab]").forEach((button) => button.classList.toggle("hidden", !settingsTabs[button.dataset.settingsTab]));
  const wifiTabActive = document.querySelector('[data-settings-tab="wifiAutomation"]')?.classList.contains("active");
  const integrationTabActive = document.querySelector('[data-settings-tab="integrations"]')?.classList.contains("active");
  const usbTabActive = document.querySelector('[data-settings-tab="usbProvisioning"]')?.classList.contains("active");
  elements.saveSettingsButton?.classList.toggle("hidden", !settingsAccess || wifiTabActive || integrationTabActive || usbTabActive);
  elements.saveOperationModeButton?.classList.toggle("hidden", !operationModeAccess || settingsAccess);
  const privilegedServerRole = ["developer", "it_admin", "admin"].includes(role);
  const canExit = serverActive
    ? privilegedServerRole && permissions.includes("system:write")
    : !lanActive || permissions.includes("system:write");
  elements.systemExitButton?.classList.toggle("hidden", !canExit);
  if (elements.systemExitButton) elements.systemExitButton.querySelector("span").textContent = serverActive ? "Server beenden" : "Beenden";
  elements.updateCheckButton?.classList.toggle("hidden", lanActive && !permissions.includes("update:write"));
  document.querySelector('[data-personnel-tab="locations"]')?.classList.toggle("hidden", !locationWriteAccess);
  document.querySelector("#addEmployeeButton")?.classList.toggle("hidden", !employeeWriteAccess);
  elements.addLocationButton?.classList.toggle("hidden", !locationBaseWriteAccess);
  elements.addDepartmentButton?.classList.toggle("hidden", !departmentWriteAccess);
  elements.locationFormCard?.classList.toggle("hidden", !locationBaseWriteAccess);
  elements.departmentFormCard?.classList.toggle("hidden", !departmentWriteAccess);
  elements.positionSettingsCard?.classList.toggle("hidden", !positionWriteAccess);
  elements.personnelViewSettingsCard?.classList.toggle("hidden", !settingsAccess);
  elements.employeeImportCard?.classList.toggle("hidden", !personnelImportAccess);
  elements.importProfileCard?.classList.toggle("hidden", !(integrationReadAccess || personnelImportAccess));
  elements.payrollExportCard?.classList.toggle("hidden", !payrollExportAccess);
  elements.exportProfileCard?.classList.toggle("hidden", !(integrationReadAccess || payrollExportAccess));
  elements.integrationHistoryCard?.classList.toggle("hidden", !integrationReadAccess);
  elements.integrationInformationCard?.classList.toggle("hidden", !integrationAccess);
  if (elements.savePersonnelImportProfileButton) elements.savePersonnelImportProfileButton.disabled = !integrationProfileWriteAccess;
  if (elements.savePayrollProfileButton) elements.savePayrollProfileButton.disabled = !integrationProfileWriteAccess;
  elements.employeeTimeConfirmationLevelField?.classList.toggle("hidden", !wifiSettingsAccess);
  elements.workflowSettingsCard?.classList.toggle("hidden", lanActive && !permissions.includes("hr:settings"));
  elements.amuSettingsCard?.classList.toggle("hidden", lanActive && !permissions.includes("hr:settings"));
  if (features.sicknessAmu === false) elements.amuSettingsCard?.classList.add("hidden");
  elements.greetingSettingsCard?.classList.toggle("hidden", !greetingSettingsAccess || features.employeePortal === false);
  document.querySelector("#backupImportCard")?.classList.toggle("hidden", !backupImportAccess);
  elements.delegationSettingsCard?.classList.toggle("hidden", !settingsAccess);
  elements.generalSettings?.querySelectorAll(".settings-card:not(.operation-mode-card)").forEach((card) => card.classList.toggle("hidden", !settingsAccess));
  [elements.localModeOption, elements.serverModeOption, elements.publicServerModeOption].forEach((button) => { if (button) button.disabled = !operationModeAccess; });
  if (!locationWriteAccess && state.personnelTab === "locations") setPersonnelTab("employees");
  renderSidebarSession();
}

async function bootstrapApplication() {
  try {
    const status = await api("/api/portal/v1/status");
    state.portalStatus = status;
    applyBranding(status.branding || {});
    elements.deploymentBanner?.classList.toggle("hidden", status.deploymentKind !== "codespaces-test");
    const passwordMinimum = Number(status.passwordMinLength || 6);
    [elements.adminLoginPassword, elements.adminSetupPassword, elements.adminSetupPasswordRepeat].forEach((input) => { if (input) input.minLength = passwordMinimum; });
    if (elements.adminAccessModeLabel) elements.adminAccessModeLabel.textContent = status.operationMode === "server" ? "Geschützter HTTPS-Zugang" : "Geschützter LAN-Zugang";
    state.desiredOperationMode = ["lan", "server"].includes(status.operationMode) ? status.operationMode : "local";
    if (status.portalEnabled) {
      const session = await api("/api/portal/v1/session");
      state.portalSession = session;
      if (!session.authenticated) {
        showLoginGate();
        return;
      }
      if (session.user?.mustChangePassword) {
        window.location.replace("/portal.html");
        return;
      }
      if (session.user?.role === "employee") {
        window.location.replace("/portal.html");
        return;
      }
    }
    hideLoginGate();
    applyShellBranding();
    applyRoleVisibility();
    await Promise.all([loadAll(), loadSystemInfo(), loadManagementBrandingPreference()]);
    applyRequestedView();
    setTimeout(() => checkForUpdates(false), 1800);
  } catch (error) {
    showLoginGate(error.message);
  }
}

async function loginToAdministration(event) {
  event.preventDefault();
  try {
    const result = await api("/api/portal/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({
        employeeNumber: elements.adminLoginPersonnelNumber.value,
        password: elements.adminLoginPassword.value,
      }),
    });
    if (result.user?.role === "employee" || result.user?.mustChangePassword) {
      window.location.replace("/portal.html");
      return;
    }
    elements.adminLoginPassword.value = "";
    state.portalSession = result;
    applyShellBranding(result.status?.branding || result.branding || {});
    hideLoginGate();
    applyRoleVisibility();
    await Promise.all([loadAll(), loadSystemInfo(), loadManagementBrandingPreference()]);
    applyRequestedView();
  } catch (error) {
    showLoginGate(error.message);
  }
}

async function logoutPortal() {
  try { await api("/api/portal/v1/auth/logout", { method: "POST", body: "{}" }); } catch {}
  window.location.reload();
}

function openAdminSetup() {
  const employees = (state.allEmployees || []).filter((employee) => employee.active);
  elements.adminSetupEmployee.innerHTML = employees.map((employee) =>
    `<option value="${escapeHtml(employee.personnel_number)}">${escapeHtml(employee.personnel_number)} · ${escapeHtml(employee.nickname || employee.full_name)}</option>`,
  ).join("");
  elements.adminSetupPassword.value = "";
  elements.adminSetupPasswordRepeat.value = "";
  elements.adminSetupModal.showModal();
}

async function setupPortalAdmin(event) {
  event.preventDefault();
  if (elements.adminSetupPassword.value !== elements.adminSetupPasswordRepeat.value) {
    showToast("Die beiden Passwörter stimmen nicht überein.", true);
    return;
  }
  try {
    const result = await api("/api/portal/v1/setup/admin", {
      method: "POST",
      body: JSON.stringify({ employeeNumber: elements.adminSetupEmployee.value, password: elements.adminSetupPassword.value }),
    });
    state.portalStatus = result.status;
    elements.adminSetupModal.close();
    renderOperationMode();
    await loadPortalUsers();
    showToast("Admin-Zugang wurde eingerichtet.");
  } catch (error) { showToast(error.message, true); }
}

async function savePortalUser(row) {
  const employeeNumber = row.dataset.portalUser;
  try {
    const mayManageUsers = state.portalSession?.user?.permissions?.includes("users:write") || !state.portalStatus?.portalEnabled;
    if (mayManageUsers) {
      const result = await api(`/api/portal/v1/users/${encodeURIComponent(employeeNumber)}`, {
        method: "PUT",
        body: JSON.stringify({
          role: row.querySelector("[data-portal-role]").value,
          active: row.querySelector("[data-portal-active]").checked,
          password: row.querySelector("[data-portal-password]").value,
          mustChangePassword: true,
        }),
      });
      state.portalUsers = result.users || [];
    }
    const role = row.querySelector("[data-portal-role]").value;
    if (["manager", "department_manager"].includes(role)) {
      const locationId = row.querySelector("[data-scope-location]").value;
      const departmentId = role === "department_manager" ? row.querySelector("[data-scope-department]").value : "";
      const scoped = await api(`/api/portal/v1/users/${encodeURIComponent(employeeNumber)}/scopes`, {
        method: "PUT",
        body: JSON.stringify({ scopes: [{ locationId, departmentId }] }),
      });
      state.portalUsers = scoped.users || state.portalUsers;
    }
    showToast(`Zugang ${employeeNumber} wurde gespeichert.`);
    await loadPortalUsers();
  } catch (error) { showToast(error.message, true); }
}

function brandingFromSettings(settings = {}) {
  return {
    appName: "Grabenplaner",
    companyName: (settings.companyName || settings.branding_company_name || "").trim(),
    logoUrl: (settings.logoUrl || settings.branding_logo_url || "/assets/grabenplaner-logo.svg").trim() || "/assets/grabenplaner-logo.svg",
    iconUrl: (settings.iconUrl || settings.branding_icon_url || "/assets/webicon.svg").trim() || "/assets/webicon.svg",
    logoAlt: (settings.logoAlt || settings.branding_logo_alt || settings.companyName || settings.branding_company_name || "Grabenplaner").trim() || "Grabenplaner",
    adminEmail: (settings.adminEmail || settings.branding_admin_email || "").trim(),
  };
}

function applyBranding(settings = state.data?.settings || {}) {
  const branding = brandingFromSettings(settings);
  document.title = `${branding.appName} · Dienstplan`;
  for (const image of [elements.loginBrandLogo, elements.brandLogo, elements.footerBrandLogo, elements.brandingPreviewLogo]) {
    if (!image) continue;
    image.src = branding.logoUrl;
    image.alt = branding.logoAlt;
  }
  if (elements.brandingPreviewTitle) elements.brandingPreviewTitle.textContent = branding.appName;
  if (elements.brandingPreviewCompany) elements.brandingPreviewCompany.textContent = branding.companyName || "Neutrale GitHub-Version";
  document.querySelectorAll("[data-brand-icon]").forEach((link) => { link.href = branding.iconUrl; });
  if (elements.adminContactLink) {
    elements.adminContactLink.classList.toggle("hidden", !branding.adminEmail);
    elements.adminContactLink.href = branding.adminEmail ? `mailto:${branding.adminEmail}` : "#";
    elements.adminContactLink.textContent = branding.adminEmail ? `Admin: ${branding.adminEmail}` : "Admin";
  }
  return branding;
}

function hasManagementBrandingAccess() {
  if (state.portalStatus?.portalEnabled !== true) return true;
  return state.portalSession?.user?.permissions?.includes("branding:write");
}

function currentShellBranding(fallback = {}) {
  if (hasManagementBrandingAccess() && state.brandingPreference?.branding) return state.brandingPreference.branding;
  return state.portalSession?.status?.branding
    || state.portalSession?.branding
    || state.portalStatus?.branding
    || fallback;
}

function applyShellBranding(fallback = {}) {
  return applyBranding(currentShellBranding(fallback));
}

function updateManagementBrandingPreference(preference = {}) {
  state.brandingPreference = {
    kitId: String(preference.kitId || ""),
    branding: brandingFromSettings(preference.branding || {}),
  };
  if (Array.isArray(preference.kits)) state.brandingKits = preference.kits;
  if (state.portalStatus) state.portalStatus.branding = state.brandingPreference.branding;
  if (state.portalSession?.status) state.portalSession.status.branding = state.brandingPreference.branding;
  applyShellBranding(state.brandingPreference.branding);
}

async function loadManagementBrandingPreference() {
  if (!hasManagementBrandingAccess()) return null;
  try {
    const preference = await api("/api/branding/preference");
    updateManagementBrandingPreference(preference);
    return preference;
  } catch (error) {
    if (error.status !== 403) throw error;
    return null;
  }
}

let adminLoginBrandingTimer;
async function previewAdminLoginBranding() {
  const employeeNumber = elements.adminLoginPersonnelNumber?.value.trim() || "";
  try {
    const result = await api("/api/portal/v1/auth/branding", {
      method: "POST",
      body: JSON.stringify({ employeeNumber }),
    });
    if ((elements.adminLoginPersonnelNumber?.value.trim() || "") === employeeNumber) applyBranding(result.branding || {});
  } catch {
    if (!employeeNumber) applyBranding(state.portalStatus?.branding || {});
  }
}

function scheduleAdminLoginBrandingPreview() {
  clearTimeout(adminLoginBrandingTimer);
  adminLoginBrandingTimer = setTimeout(previewAdminLoginBranding, 300);
}

async function loadAll() {
  try {
    const [locations, positions, portalStatus, roleData] = await Promise.all([
      api("/api/locations"),
      api("/api/positions"),
      api("/api/portal/v1/status").catch(() => null),
      api("/api/portal/v1/roles").catch(() => ({ roles: [], catalog: [] })),
    ]);
    state.locations = locations;
    state.positions = positions;
    state.portalStatus = portalStatus;
    state.portalRoles = roleData.roles || [];
    state.portalPermissionCatalog = roleData.catalog || [];
    if (!state.desiredOperationMode) state.desiredOperationMode = ["lan", "server"].includes(portalStatus?.operationMode) ? portalStatus.operationMode : "local";
    setDefaultContext(state.locations);
    const scheduleContext = contextQuery(true);
    const vacationContext = contextQuery(state.portalSession?.user?.role === "department_manager");
    const vacationEnabled = portalStatus?.installationFeatures?.vacation !== false;
    const [schedule, employees, vacationData, brandingKits] = await Promise.all([
      api(`/api/schedule?week=${state.weekStart}${scheduleContext}`),
      api("/api/employees"),
      vacationEnabled
        ? api(`/api/vacations?year=${state.vacationYear}${vacationContext}`)
        : Promise.resolve({ year: state.vacationYear, vacations: [], entitlements: [], publicHolidays: [] }),
      api(`/api/branding/kits?locationId=${encodeURIComponent(state.locationId)}`).catch(() => state.brandingKits || []),
    ]);
    state.data = schedule;
    state.locations = schedule.locations || state.locations;
    state.vacationData = vacationData;
    state.allEmployees = employees;
    state.brandingKits = brandingKits;
    state.weekStart = schedule.weekStart;
    state.locationId = schedule.context?.locationId || state.locationId;
    state.departmentId = schedule.context?.departmentId ? String(schedule.context.departmentId) : "";
    state.vacationYear = vacationData.year;
    render();
    if (portalStatus?.installationFeatures?.requests !== false) {
      loadManagerVacationRequests();
      loadRequestBlackouts();
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

function render() {
  applyShellBranding(hasManagementBrandingAccess() ? {} : state.data?.settings || {});
  renderContextNavigation();
  renderHeader();
  renderSummary();
  renderTimeline();
  renderRemarks();
  renderHoursOverview();
  renderVacations();
  renderEmployees();
  renderLocations();
  renderPositions();
  renderSettings();
}

function renderContextNavigation() {
  const locations = activeLocations();
  const departmentOnly = state.portalSession?.user?.role === "department_manager";
  const planningContexts = locations.flatMap((location) => departmentOnly
    ? (location.departments || []).map((department) => ({ locationId: location.id, departmentId: String(department.id), label: `${location.name} · ${department.name}` }))
    : [{ locationId: location.id, departmentId: "", label: `${location.name} · Gesamtplan` }]);
  const showPlanningChildren = planningContexts.length > 1;
  const planningOpen = localStorage.getItem("grabenplaner-nav-planning") !== "closed";
  const planningToggle = document.querySelector('[data-nav-toggle="planning"]');
  elements.planningNavChildren.classList.toggle("hidden", !showPlanningChildren || !planningOpen);
  planningToggle?.classList.toggle("hidden", !showPlanningChildren);
  planningToggle?.classList.toggle("expanded", planningOpen);
  planningToggle?.setAttribute("aria-expanded", String(planningOpen));
  elements.planningNavChildren.innerHTML = showPlanningChildren ? planningContexts.map((item) => `
    <button type="button" class="nav-child ${item.locationId === state.locationId && String(item.departmentId || "") === String(state.departmentId || "") ? "active" : ""}" data-context-view="planning" data-location-id="${escapeHtml(item.locationId)}" data-department-id="${escapeHtml(item.departmentId)}">${escapeHtml(item.label)}</button>
  `).join("") : "";

  const showVacationChildren = locations.length > 1;
  const vacationOpen = localStorage.getItem("grabenplaner-nav-vacations") !== "closed";
  const vacationToggle = document.querySelector('[data-nav-toggle="vacations"]');
  elements.vacationNavChildren.classList.toggle("hidden", !showVacationChildren || !vacationOpen);
  vacationToggle?.classList.toggle("hidden", !showVacationChildren);
  vacationToggle?.classList.toggle("expanded", vacationOpen);
  vacationToggle?.setAttribute("aria-expanded", String(vacationOpen));
  elements.vacationNavChildren.innerHTML = showVacationChildren ? locations.map((location) => `
    <button type="button" class="nav-child ${location.id === state.locationId ? "active" : ""}" data-context-view="vacations" data-location-id="${escapeHtml(location.id)}" data-department-id="${departmentOnly ? escapeHtml(String(location.departments?.[0]?.id || "")) : ""}">${escapeHtml(location.name)}</button>
  `).join("") : "";
}

function renderHeader() {
  const end = addDays(state.weekStart, state.data.settings.show_sunday === "1" ? 6 : 5);
  const location = currentLocation();
  const department = currentDepartment();
  const contextLabel = [location?.name, department?.name].filter(Boolean).join(" · ");
  elements.weekTitle.textContent = `${formatDate(state.weekStart, { day: "numeric", month: "long" })} – ${formatDate(end, { day: "numeric", month: "long", year: "numeric" })}`;
  elements.calendarWeek.textContent = `Kalenderwoche ${state.data.calendarWeek}${contextLabel ? ` · ${contextLabel}` : ""}`;
  elements.scheduleTitle.textContent = `${state.data.settings.pdf_title} · KW ${state.data.calendarWeek}`;
  elements.pdfButton.href = `/api/schedule.pdf?week=${state.weekStart}${contextQuery(true)}`;
  document.querySelector("#weekJumpDate").value = state.weekStart;
  elements.weekLockNotice.classList.toggle("hidden", !isWeekLocked());
  const hasNote = Boolean(state.data.scheduleNote?.note_text);
  elements.scheduleNoteButton.classList.toggle("has-note", hasNote);
  elements.scheduleNoteButtonHint.textContent = hasNote ? "anzeigen/bearbeiten" : "hinzufügen";
  ["autoPlanButton", "optionsButton", "resetWeekButton", "scheduleNoteButton"].forEach((id) => {
    const button = document.querySelector(`#${id}`);
    if (button) {
      button.disabled = isWeekLocked();
      button.title = isWeekLocked() ? "Vergangene Kalenderwochen sind schreibgeschützt." : "";
    }
  });
}

function renderSummary() {
  const minutes = Object.values(state.data.totals).reduce((sum, value) => sum + Number(value), 0);
  const inStoreMinutes = Object.values(state.data.inStoreTotals || state.data.plannedTotals || {}).reduce((sum, value) => sum + Number(value), 0);
  elements.shiftCount.textContent = state.data.shifts.length;
  elements.totalHours.textContent = formatHours(minutes);
  elements.inStoreHours.textContent = formatHours(inStoreMinutes);
  elements.optionCount.textContent = state.data.weekOptions.length + (state.data.globalDayBlocks || []).length;
  elements.employeeCount.textContent = state.data.employees.length;
  elements.sidebarEmployeeCount.textContent = state.data.employees.length;
  const settings = state.data.settings;
  elements.breakRuleHint.textContent = settings.break_rule_enabled === "1"
    ? `Pause: ${Number(settings.break_after_minutes) / 60} h → ${settings.break_duration_minutes} min`
    : "Pausenregel aus";
  elements.saturdayRuleHint.textContent = settings.saturday_bonus_enabled === "1"
    ? `Sa ab ${settings.saturday_bonus_from}: ×${String(settings.saturday_bonus_factor).replace(".", ",")}`
    : "Sa-Faktor aus";
  const departments = departmentsForLocation(state.locationId);
  const showDepartmentPdf = !state.departmentId && departments.length > 0;
  elements.departmentPdfControl?.classList.toggle("hidden", !showDepartmentPdf);
  if (showDepartmentPdf) {
    elements.departmentPdfSelect.innerHTML = departments.map((department) =>
      `<option value="${department.id}">${escapeHtml(department.name)}</option>`,
    ).join("");
    const selectedDepartment = elements.departmentPdfSelect.value || String(departments[0].id);
    elements.departmentPdfButton.href = `/api/schedule.pdf?week=${state.weekStart}&location=${encodeURIComponent(state.locationId)}&departmentId=${encodeURIComponent(selectedDepartment)}`;
  }
}

function renderTimeline() {
  const employees = state.data.employees;
  const settings = state.data.settings;
  const timedOptionStarts = state.data.weekOptions.filter((option) => !optionIsAllDay(option) && option.start_time).map((option) => timeToMinutes(option.start_time));
  const timedOptionEnds = state.data.weekOptions.filter((option) => !optionIsAllDay(option) && option.end_time).map((option) => timeToMinutes(option.end_time));
  const start = Math.min(
    ...planningDayKeys.map((day) => timeToMinutes(settings[`${day}_start_time`])),
    ...state.data.shifts.map((shift) => timeToMinutes(shift.start_time)),
    ...timedOptionStarts,
  );
  const end = Math.max(
    ...planningDayKeys.map((day) => timeToMinutes(settings[`${day}_end_time`])),
    ...state.data.shifts.map((shift) => timeToMinutes(shift.end_time)),
    ...timedOptionEnds,
  );
  const range = end - start;
  const employeeCount = Math.max(1, employees.length);
  const dayCount = settings.show_sunday === "1" ? 7 : 6;

  const timeLabels = [];
  for (let minute = start; minute <= end; minute += 60) {
    const top = ((minute - start) / range) * 100;
    timeLabels.push(`<span class="time-label" style="top:${top}%">${String(Math.floor(minute / 60)).padStart(2, "0")}:00</span>`);
  }

  const dayColumns = weekdayNames.slice(0, dayCount).map((weekday, dayIndex) => {
    const date = addDays(state.weekStart, dayIndex);
    const locked = isWeekLocked();
    const globalBlock = globalBlockForDate(date);
    const holiday = publicHolidayForDate(date);
    const hours = dayConfig(date, settings);
    const openStart = hours ? ((timeToMinutes(hours.start) - start) / range) * 100 : 0;
    const openEnd = hours ? ((timeToMinutes(hours.end) - start) / range) * 100 : 0;
    const lunchBand = hours?.lunchEnabled
      ? `<span class="lunch-band" style="top:${((timeToMinutes(hours.lunchStart) - start) / range) * 100}%;height:${((timeToMinutes(hours.lunchEnd) - timeToMinutes(hours.lunchStart)) / range) * 100}%">Mittagspause</span>`
      : "";
    const headers = employees.length
      ? employees.map((employee) => `
          <div class="employee-strip" style="background:${employee.color};color:${contrastColor(employee.color)}" title="${escapeHtml(employee.full_name)} · ${employee.personnel_number}">
            <strong>${escapeHtml(employee.nickname)}</strong><small>${escapeHtml(employee.personnel_number)}</small>
          </div>`).join("")
      : '<div class="employee-strip" style="background:#d7ddda;color:#65716c"><strong>Kein Team</strong></div>';

    const lanes = employees.length
      ? employees.map((employee) => {
          const dayOptions = specialCasesFor(employee.personnel_number, date);
          const specialCase = dayOptions.find((option) => optionIsAllDay(option) && !option.soft_pending);
          const softPending = dayOptions.find((option) => optionIsAllDay(option) && option.soft_pending);
          const fixedUnavailable = !employeeCanWorkOnDate(employee, date);
          const unavailable = Boolean(locked || globalBlock || specialCase || fixedUnavailable);
          const unavailableText = locked
            ? "Vergangene Kalenderwoche ist schreibgeschützt"
            : globalBlock
              ? `${globalBlock.reason || globalBlock.holiday_name || "Tag gesperrt"}${globalBlock.is_public_holiday ? " · Feiertag" : ""}`
              : specialCase
                ? `${optionLabels[specialCase.option_type]} · ${formatOptionTime(specialCase)}${specialCase.note ? ` – ${specialCase.note}` : ""}`
                : fixedUnavailable
                  ? "Kein fixer Arbeitstag"
                  : "";
          const optionBlocks = dayOptions.filter((option) => !optionIsAllDay(option)).map((option) => {
            const optionStart = Math.max(start, timeToMinutes(option.start_time));
            const optionEnd = Math.min(end, timeToMinutes(option.end_time));
            if (optionEnd <= optionStart) return "";
            const top = ((optionStart - start) / range) * 100;
            const height = Math.max(2.5, ((optionEnd - optionStart) / range) * 100);
            const title = `${optionLabels[option.option_type]} · ${formatOptionTime(option)}${option.note ? ` – ${option.note}` : ""}`;
            return `<span class="option-block ${option.soft_pending ? "soft-pending-option" : ""}" data-option-title="${escapeHtml(title)}" style="top:${top}%;height:${height}%"><em>${escapeHtml(option.soft_pending ? "ZA beantragt" : optionLabels[option.option_type])}</em></span>`;
          }).join("");
          const softPendingBlock = softPending ? '<span class="option-block soft-pending-option soft-pending-all-day"><em>ZA beantragt</em></span>' : "";
          const shifts = state.data.shifts.filter((shift) => shift.shift_date === date && shift.employee_number === employee.personnel_number);
          const bars = shifts.map((shift) => {
            const barStart = Math.max(start, timeToMinutes(shift.start_time));
            const barEnd = Math.min(end, timeToMinutes(shift.end_time));
            const top = ((barStart - start) / range) * 100;
            const height = Math.max(2.5, ((barEnd - barStart) / range) * 100);
            const departmentLabel = shift.department_name || shift.area || "";
            return `<button class="shift-bar" type="button" data-shift-id="${shift.id}" style="top:${top}%;height:${height}%;--employee-color:${employee.color}" title="${shift.start_time}–${shift.end_time} · ${formatHours(shift.counted_minutes)}${departmentLabel ? ` · ${escapeHtml(departmentLabel)}` : ""}" aria-label="${escapeHtml(employee.nickname)} ${shift.start_time} bis ${shift.end_time}">${departmentLabel ? `<span>${escapeHtml(departmentLabel)}</span>` : ""}</button>`;
          }).join("");
          const unavailableLabel = locked
            ? "gesperrt"
            : globalBlock
              ? (globalBlock.is_public_holiday ? "Feiertag" : "gesperrt")
              : specialCase
                ? optionLabels[specialCase.option_type]
                : "frei";
          return `<div class="employee-lane ${specialCase ? "unavailable" : ""} ${fixedUnavailable ? "fixed-unavailable" : ""} ${globalBlock ? "global-unavailable" : ""} ${locked ? "locked-unavailable" : ""}" ${unavailable ? "" : `data-employee-number="${escapeHtml(employee.personnel_number)}" data-date="${date}"`} title="${escapeHtml(unavailableText)}">${bars}${optionBlocks}${softPendingBlock}${unavailable ? `<span class="unavailable-mark">${escapeHtml(unavailableLabel)}</span>` : ""}</div>`;
        }).join("")
      : '<div class="employee-lane"></div>';

    return `<section class="day-column ${dayIndex === 6 ? "sunday" : ""}" style="grid-column:${dayIndex + 2}">
      <div class="day-title">${weekday} ${formatDate(date, { day: "2-digit", month: "2-digit" })}${holiday ? ` · ${escapeHtml(holiday.name)}` : ""}</div>
      <div class="employee-strips">${headers}</div>
      <div class="day-body ${hours ? "" : "closed-day"}" style="--open-start:${openStart}%;--open-end:${openEnd}%">${lunchBand}<div class="lane-grid">${lanes}</div></div>
    </section>`;
  }).join("");

  elements.timeline.style.setProperty("--employee-count", employeeCount);
  elements.timeline.style.setProperty("--day-count", dayCount);
  elements.timeline.style.setProperty("--hour-step", `${100 / (range / 60)}%`);
  elements.timeline.innerHTML = `<div class="time-header">Zeit</div>${dayColumns}<div class="time-axis">${timeLabels.join("")}</div>`;
}

function renderRemarks() {
  const options = state.data.weekOptions;
  const globalRemarks = (state.data.globalDayBlocks || []).map((block) => `
          <div class="remark-item"><span class="remark-color" style="background:#9aa2a4"></span>
          <span><strong>Alle:</strong> ${escapeHtml(block.reason || block.holiday_name || "Tag gesperrt")} · ${formatDate(block.block_date, { day: "2-digit", month: "2-digit" })}${block.is_public_holiday ? " · Feiertag" : ""}</span></div>`);
  const optionRemarks = options.map((option) => `
          <div class="remark-item"><span class="remark-color" style="background:${option.color}"></span>
          <span><strong>${escapeHtml(option.nickname)}:</strong> ${optionLabels[option.option_type]} · ${formatOptionDates(option)} · ${formatOptionTime(option)}${option.note ? ` – ${escapeHtml(option.note)}` : ""}</span></div>`);
  const remarks = [...globalRemarks, ...optionRemarks];
  elements.remarks.innerHTML = `<h3>Bemerkungen / Sonderfälle</h3>${
    remarks.length
      ? `<div class="remarks-list">${remarks.join("")}</div>`
      : '<div class="empty-remarks">Keine Bemerkungen für diese Woche.</div>'
  }`;
}

function renderHoursOverview() {
  const showSaturdayStats = state.data.settings.show_saturday_service_stats !== "0";
  let hasEstimatedSaturdayStats = false;
  elements.hoursOverview.innerHTML = state.data.employees.map((employee) => {
    const planned = state.data.plannedTotals[employee.personnel_number] || 0;
    const optionCredit = state.data.optionCreditTotals[employee.personnel_number] || 0;
    const counted = state.data.totals[employee.personnel_number] || 0;
    const target = Number(employee.contracted_hours) * 60;
    const difference = counted - target;
    const percentage = target > 0 ? Math.min(100, (counted / target) * 100) : 0;
    const saturdayStats = state.data.saturdayStats?.byEmployee?.[employee.personnel_number] || null;
    if (saturdayStats?.fourWeeksEstimated || saturdayStats?.threeMonthsEstimated) hasEstimatedSaturdayStats = true;
    const saturdayStatsHtml = showSaturdayStats && saturdayStats ? `
      <div class="hours-saturday-stats">
        <span>Sa-Dienst ≥2 h</span>
        <strong class="${saturdayStats.fourWeeksEstimated ? "estimated" : ""}">4 Wo: ${formatCount(saturdayStats.fourWeeks)}${saturdayStats.fourWeeksEstimated ? "*" : ""}</strong>
        <strong class="${saturdayStats.threeMonthsEstimated ? "estimated" : ""}">3 Mon: ${formatCount(saturdayStats.threeMonths)}${saturdayStats.threeMonthsEstimated ? "*" : ""}</strong>
      </div>
    ` : "";
    return `<article class="hours-card">
      <div class="hours-person">
        <span class="hours-color" style="background:${employee.color}"></span>
        <div><strong>${escapeHtml(employee.nickname)}</strong><small>${escapeHtml(employee.personnel_number)} · ${escapeHtml(employee.full_name)}</small></div>
      </div>
      <div class="hours-values">
        <span><small>Eingeteilt</small><strong>${formatHours(planned)}</strong></span>
        <span><small>Sonderfälle</small><strong>${formatHours(optionCredit)}</strong></span>
        <span><small>Gewertet</small><strong>${formatHours(counted)}</strong></span>
        <span><small>Wochen-Soll</small><strong>${formatHours(target)}</strong></span>
        <span class="${difference > 0 ? "hours-over" : difference < 0 ? "hours-under" : "hours-exact"}"><small>Differenz</small><strong>${difference > 0 ? "+" : ""}${formatHours(difference)}</strong></span>
      </div>
      ${saturdayStatsHtml}
      <div class="hours-progress"><span style="width:${percentage}%;background:${employee.color}"></span></div>
    </article>`;
  }).join("");
  if (showSaturdayStats && hasEstimatedSaturdayStats) {
    elements.hoursOverview.insertAdjacentHTML(
      "beforeend",
      '<div class="hours-estimate-note">* Errechneter Wert, da noch nicht ausreichend vergangene Dienstplandaten zur Verfügung stehen.</div>',
    );
  }
}

function formatVacationDateRange(vacation, monthStartValue = null, monthEndValue = null) {
  const from = monthStartValue && vacation.date_from < monthStartValue ? monthStartValue : vacation.date_from;
  const to = monthEndValue && vacation.date_to > monthEndValue ? monthEndValue : vacation.date_to;
  return from === to
    ? formatDate(from, { day: "2-digit", month: "2-digit" })
    : `${formatDate(from, { day: "2-digit", month: "2-digit" })}–${formatDate(to, { day: "2-digit", month: "2-digit" })}`;
}

function updateVacationControls(range) {
  elements.vacationYear.value = state.vacationYear;
  elements.vacationViewMode.value = state.vacationViewMode;
  elements.vacationQuarter.value = state.vacationQuarter;
  elements.vacationMonth.value = state.vacationMonth;
  elements.vacationQuarterField.classList.toggle("hidden", state.vacationViewMode !== "quarter");
  elements.vacationMonthField.classList.toggle("hidden", state.vacationViewMode !== "month");
  const parameters = new URLSearchParams({
    year: String(state.vacationYear),
    view: state.vacationViewMode,
    quarter: String(state.vacationQuarter),
    month: String(state.vacationMonth),
  });
  const locationParams = contextSearchParams(state.portalSession?.user?.role === "department_manager");
  locationParams.forEach((value, key) => parameters.set(key, value));
  elements.vacationPdfButton.href = `/api/vacations.pdf?${parameters.toString()}`;
  elements.vacationTitle.textContent = range.label;
  elements.vacationSubtitle.textContent = `${formatDate(range.start)} bis ${formatDate(range.end)} · ${state.vacationData?.vacations?.length || 0} Urlaubseinträge im Jahr`;
  elements.vacationCalendarTitle.textContent = `Urlaubskalender · ${range.label}`;
}

function vacationsOnDate(date) {
  return (state.vacationData?.vacations || []).filter((vacation) =>
    date >= vacation.date_from && date <= vacation.date_to,
  );
}

function renderVacationMonthCard(month) {
  const start = monthStart(state.vacationYear, month);
  const end = monthEnd(state.vacationYear, month);
  const calendarRange = monthCalendarRange(state.vacationYear, month);
  const monthVacations = vacationEntriesInRange(start, end)
    .slice()
    .sort((a, b) => a.date_from.localeCompare(b.date_from) || a.nickname.localeCompare(b.nickname));
  const dates = [];
  for (let date = calendarRange.start; date <= calendarRange.end; date = addDays(date, 1)) dates.push(date);
  const compact = state.vacationViewMode === "year";
  const header = `<div class="vacation-weekday">KW</div>${weekdayNames.map((day) => `<div class="vacation-weekday">${day}</div>`).join("")}`;
  const weeks = [];
  for (let index = 0; index < dates.length; index += 7) {
    const weekDates = dates.slice(index, index + 7);
    weeks.push(`<div class="vacation-week-number">${getIsoWeek(weekDates[0])}</div>${weekDates.map((date) => {
      const inMonth = date >= start && date <= end;
      const dayVacations = inMonth ? vacationsOnDate(date) : [];
      const holiday = inMonth ? vacationHolidayForDate(date) : false;
      const visibleVacations = dayVacations.slice(0, compact ? 5 : 3);
      const overflow = dayVacations.length - visibleVacations.length;
      const markers = compact
        ? `<div class="vacation-dot-row">${visibleVacations.map((vacation) => `<span class="vacation-dot" style="background:${vacation.color}" title="${escapeHtml(vacation.nickname)}"></span>`).join("")}${overflow > 0 ? `<span class="vacation-more">+${overflow}</span>` : ""}</div>`
        : `<div class="vacation-day-tags">${visibleVacations.map((vacation) => `<span class="vacation-tag" style="background:${vacation.color};color:${contrastColor(vacation.color)}" title="${escapeHtml(vacation.nickname)}">${escapeHtml(vacation.nickname)}</span>`).join("")}${overflow > 0 ? `<span class="vacation-more">+${overflow}</span>` : ""}</div>`;
      return `<div class="vacation-day ${inMonth ? "" : "outside-month"}">
        <span class="vacation-day-number">${Number(date.slice(-2))}</span>
        ${holiday ? '<span class="vacation-holiday">Feiertag</span>' : ""}
        ${dayVacations.length ? markers : ""}
      </div>`;
    }).join("")}`);
  }
  return `<article class="vacation-month-card">
    <h3>${monthName(month)}</h3>
    <div class="vacation-calendar-grid">${header}${weeks.join("")}</div>
    <div class="vacation-month-list compact">${
      monthVacations.length
        ? monthVacations.map((vacation) => {
            const clippedFrom = vacation.date_from < start ? start : vacation.date_from;
            const clippedTo = vacation.date_to > end ? end : vacation.date_to;
            const days = vacationDayCount(clippedFrom, clippedTo);
            return `<div class="vacation-item">
              <span class="vacation-item-color" style="background:${vacation.color}"></span>
              <div><strong>${escapeHtml(vacation.nickname)}</strong><small>${formatVacationDateRange(vacation, start, end)} · ${formatDays(days)}${vacation.note ? ` · ${escapeHtml(vacation.note)}` : ""}</small></div>
              <div class="vacation-actions-inline">
                <button type="button" class="edit-vacation" data-edit-vacation="${escapeHtml(vacation.group_id)}">Bearbeiten</button>
                <button type="button" class="delete-vacation" data-delete-vacation="${escapeHtml(vacation.group_id)}">Löschen</button>
              </div>
            </div>`;
          }).join("")
        : '<div class="empty-vacation-month">Keine Urlaube eingetragen.</div>'
    }</div>
  </article>`;
}

function renderVacationEmployeeOverview(range) {
  const employees = state.vacationData.employees || [];
  return employees.map((employee) => {
    const employeeVacations = vacationEntriesInRange(range.start, range.end)
      .filter((vacation) => vacation.employee_number === employee.personnel_number)
      .sort((a, b) => a.date_from.localeCompare(b.date_from));
    const totals = state.vacationData.totals[employee.personnel_number] || { entitlement: 0, planned: 0, used: 0, consumed: 0, remaining: 0 };
    return `<article class="vacation-employee-card">
      <div class="vacation-employee-head" style="background:${employee.color};color:${contrastColor(employee.color)}">
        <strong>${escapeHtml(employee.personnel_number)} ${escapeHtml(employee.nickname)}</strong>
        <small><strong>Resturlaub: ${formatDaysLong(totals.remaining)}</strong> · geplant ${formatDaysLong(totals.planned ?? totals.used)} · konsumiert ${formatDaysLong(totals.consumed || 0)}</small>
      </div>
      <div class="vacation-employee-body">${
        employeeVacations.length
          ? employeeVacations.map((vacation) => {
              const days = vacationDayCount(vacation.date_from, vacation.date_to);
              return `<div class="vacation-item">
                <span class="vacation-item-color" style="background:${employee.color}"></span>
                <div><strong>${formatVacationDateRange(vacation)}</strong><small>${formatDays(days)}${vacation.note ? ` · ${escapeHtml(vacation.note)}` : ""}</small></div>
                <div class="vacation-actions-inline">
                  <button type="button" class="edit-vacation" data-edit-vacation="${escapeHtml(vacation.group_id)}">Bearbeiten</button>
                  <button type="button" class="delete-vacation" data-delete-vacation="${escapeHtml(vacation.group_id)}">Löschen</button>
                </div>
              </div>`;
            }).join("")
          : '<div class="empty-vacation-month">Keine Urlaube eingetragen.</div>'
      }</div>
    </article>`;
  }).join("");
}

function renderVacations() {
  if (!state.vacationData) return;
  const range = selectedVacationRange();
  updateVacationControls(range);
  const employees = state.vacationData.employees || [];
  const savedMap = state.vacationData.entitlementsSaved || {};
  const missingEntitlements = employees.some((employee) => !savedMap[employee.personnel_number]);
  const showEntitlementInputs = state.editingVacationEntitlements || missingEntitlements;
  elements.saveEntitlementsButton.classList.toggle("hidden", !showEntitlementInputs);
  elements.editEntitlementsButton.classList.toggle("hidden", showEntitlementInputs || !employees.length);
  elements.vacationSummary.innerHTML = employees.length ? employees.map((employee) => {
    const totals = state.vacationData.totals[employee.personnel_number] || { entitlement: 0, used: 0, remaining: 0 };
    return `<article class="vacation-summary-card">
      <div class="vacation-summary-head">
        <span class="vacation-color" style="background:${employee.color}"></span>
        <div><strong>${escapeHtml(employee.nickname)}</strong><small>${escapeHtml(employee.full_name)} · ${escapeHtml(employee.personnel_number)}</small></div>
      </div>
      <div class="vacation-stats">
        <div><span>Jahresurlaub</span><strong>${formatDays(totals.entitlement)}</strong></div>
        <div><span>Verplant</span><strong>${formatDays(totals.planned ?? totals.used)}</strong></div>
        <div><span>Rest</span><strong>${formatDays(totals.remaining)}</strong></div>
      </div>
      ${showEntitlementInputs ? `<label class="vacation-entitlement"><span>Jahresurlaub per 1.1.</span><input data-vacation-entitlement="${escapeHtml(employee.personnel_number)}" type="number" min="0" max="365" step="0.5" value="${Number(totals.entitlement || 0)}" /></label>` : ""}
    </article>`;
  }).join("") : '<div class="empty-options">Noch keine aktiven Teammitglieder angelegt.</div>';

  elements.vacationCalendar.classList.toggle("single-month", state.vacationViewMode === "month");
  elements.vacationCalendar.classList.toggle("quarter-view", state.vacationViewMode === "quarter");
  elements.vacationCalendar.classList.toggle("employee-view", state.vacationViewMode === "employees");
  elements.vacationCalendar.innerHTML = state.vacationViewMode === "employees"
    ? renderVacationEmployeeOverview(range)
    : range.months.map(renderVacationMonthCard).join("");
}

function openVacationModal(vacation = null) {
  if (!state.vacationData?.employees?.length) {
    showToast("Bitte zuerst ein aktives Teammitglied anlegen.", true);
    return;
  }
  const range = selectedVacationRange();
  state.editingVacationGroupId = vacation?.group_id || null;
  elements.vacationForm.reset();
  elements.vacationEmployee.innerHTML = state.vacationData.employees.map((employee) =>
    `<option value="${escapeHtml(employee.personnel_number)}">${escapeHtml(employee.nickname)} · ${escapeHtml(employee.personnel_number)}</option>`,
  ).join("");
  elements.vacationEmployee.value = vacation?.employee_number || state.vacationData.employees[0].personnel_number;
  elements.vacationDateFrom.value = vacation?.date_from || range.start;
  elements.vacationDateTo.value = vacation?.date_to || range.start;
  elements.vacationNote.value = vacation?.note || "";
  elements.vacationModalTitle.textContent = vacation ? "Urlaub bearbeiten" : "Urlaub eintragen";
  elements.vacationSubmitButton.textContent = vacation ? "Änderung speichern" : "Urlaub speichern";
  updateVacationCalculation();
  elements.vacationModal.showModal();
}

function updateVacationCalculation() {
  if (!state.vacationData) return;
  const employeeNumber = elements.vacationEmployee.value;
  const dateFrom = elements.vacationDateFrom.value;
  const dateTo = elements.vacationDateTo.value;
  const employee = state.vacationData.employees.find((item) => item.personnel_number === employeeNumber);
  if (!employee || !dateFrom || !dateTo || dateTo < dateFrom) {
    elements.vacationCalculation.textContent = "Bitte Teammitglied und gültigen Zeitraum auswählen.";
    return;
  }
  const days = vacationDayCount(dateFrom, dateTo);
  const totals = state.vacationData.totals[employeeNumber] || { remaining: 0 };
  const saturdayHint = state.data.settings.vacation_count_saturday === "1"
    ? "Samstag wird als Urlaubstag gezählt."
    : "Samstag wird nicht vom Resturlaub abgezogen, der Zeitraum ist aber trotzdem gesperrt.";
  const holidays = [];
  for (let date = dateFrom; date <= dateTo; date = addDays(date, 1)) {
    const holiday = (state.vacationData?.publicHolidays || []).find((item) => item.date === date);
    if (holiday) holidays.push(holiday.name);
  }
  const holidayHint = holidays.length ? ` Feiertage zählen nicht als Urlaubstag: ${[...new Set(holidays)].join(", ")}.` : "";
  elements.vacationCalculation.textContent = `${employee.nickname}: aktueller Rest ${formatDays(totals.remaining)} · dieser Eintrag ${formatDays(days)} · danach ${formatDays(totals.remaining - days)}. ${saturdayHint}${holidayHint}`;
}

async function saveVacation(event) {
  event.preventDefault();
  const dateFrom = elements.vacationDateFrom.value;
  const isEdit = Boolean(state.editingVacationGroupId);
  try {
    await api(isEdit ? `/api/vacations/${encodeURIComponent(state.editingVacationGroupId)}` : "/api/vacations", {
      method: isEdit ? "PUT" : "POST",
      body: JSON.stringify({
        employeeNumber: elements.vacationEmployee.value,
        dateFrom,
        dateTo: elements.vacationDateTo.value,
        note: elements.vacationNote.value,
        locationId: state.locationId,
      }),
    });
    elements.vacationModal.close();
    state.editingVacationGroupId = null;
    state.vacationYear = Number(dateFrom.slice(0, 4)) || state.vacationYear;
    showToast(isEdit ? "Urlaub wurde aktualisiert." : "Urlaub wurde eingetragen.");
    await loadAll();
  } catch (error) { showToast(error.message, true); }
}

async function saveVacationEntitlements() {
  try {
    const entries = Array.from(document.querySelectorAll("[data-vacation-entitlement]")).map((input) => ({
      employeeNumber: input.dataset.vacationEntitlement,
      days: Number(input.value || 0),
    }));
    state.vacationData = await api("/api/vacation-entitlements", {
      method: "PUT",
      body: JSON.stringify({ year: state.vacationYear, locationId: state.locationId, entries }),
    });
    state.editingVacationEntitlements = false;
    showToast("Jahresurlaub wurde gespeichert.");
    renderVacations();
  } catch (error) { showToast(error.message, true); }
}

async function deleteVacation(groupId) {
  if (!groupId || !confirm("Diesen Urlaubseintrag wirklich löschen?")) return;
  try {
    await api(`/api/vacations/${encodeURIComponent(groupId)}`, { method: "DELETE" });
    showToast("Urlaubseintrag wurde gelöscht.");
    await loadAll();
  } catch (error) { showToast(error.message, true); }
}

function operationModeLabel(mode) {
  return mode === "server" ? "HTTPS-Server" : mode === "lan" ? "LAN-Host" : "Lokal";
}

function renderServerDiagnostics(info) {
  if (!elements.serverDiagnostics || !info) return;
  const statusClass = info.ready ? "ok" : "warning";
  const productionChecks = Array.isArray(info.productionChecks) ? info.productionChecks : [];
  const warnings = info.warnings?.length
    ? `<div class="diagnostic-warnings">${info.warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join("")}</div>`
    : '<p class="diagnostic-all-clear">Keine Warnungen in der aktuellen Konfiguration.</p>';
  elements.serverDiagnostics.innerHTML = `
    <div class="diagnostic-summary ${statusClass}"><strong>${info.ready ? "Betriebsbereit" : "Konfiguration prüfen"}</strong><span>${escapeHtml(operationModeLabel(info.mode))}${info.publicUrl ? ` · ${escapeHtml(info.publicUrl)}` : ""}</span></div>
    <div class="diagnostic-grid">
      <span><small>HTTPS-Pflicht</small><strong>${info.httpsRequired ? "aktiv" : "nur Servermodus"}</strong></span>
      <span><small>Passwortminimum</small><strong>${Number(info.passwordMinLength || 6)} Zeichen</strong></span>
      <span><small>SQLite</small><strong>${escapeHtml(info.database?.journalMode || "–")} · ${Number(info.database?.busyTimeoutMs || 0)} ms</strong></span>
      <span><small>Integrität</small><strong>${escapeHtml(info.database?.integrity || "unbekannt")}</strong></span>
      <span><small>Migration</small><strong>${escapeHtml(info.database?.migration?.id || "–")}</strong></span>
      <span><small>Instanzschutz</small><strong>${info.instanceLock?.held ? "aktiv" : info.instanceLock?.enabled ? "beim Serverstart" : "nicht nötig"}</strong></span>
      <span><small>Aktive Sitzungen</small><strong>${Number(info.security?.activeSessions || 0)}</strong></span>
      <span><small>Letztes Backup geprüft</small><strong>${info.backups?.lastVerified ? "ja" : "noch ausständig"}</strong></span>
      <span><small>AUM-Speicher</small><strong>${info.storage?.amu?.ok ? "verschlüsselt bereit" : "nicht bereit"}</strong></span>
      <span><small>Backupziel</small><strong>${info.backups?.externalWritable ? "beschreibbar" : "prüfen"}</strong></span>
    </div>
    <div class="pilot-checklist"><strong>Server-Betriebsprüfung</strong>${productionChecks.map((check) => `<span class="${check.ok ? "ok" : "warning"}"><i>${check.ok ? "✓" : "!"}</i><b>${escapeHtml(check.label)}</b><small>${escapeHtml(check.detail || "")}</small></span>`).join("")}</div>${warnings}`;
}

async function refreshServerDiagnostics() {
  try {
    renderServerDiagnostics(await api("/api/server-diagnostics"));
  } catch (error) {
    if (elements.serverDiagnostics) elements.serverDiagnostics.innerHTML = `<p class="settings-note">${escapeHtml(error.message)}</p>`;
  }
}

async function loadSystemInfo() {
  try {
    const info = await api("/api/system-info");
    const uptimeHours = Math.floor(info.uptimeSeconds / 3600);
    const uptimeMinutes = Math.floor((info.uptimeSeconds % 3600) / 60);
    const brandingFallback = hasManagementBrandingAccess() ? info.branding || {} : state.data?.settings || {};
    const branding = applyShellBranding(brandingFallback);
    const appName = branding.appName || info.appName || "Grabenplaner";
    elements.versionLabel.innerHTML = `<strong>${escapeHtml(appName)}</strong> ${escapeHtml(info.appVersionLabel)}`;
    elements.sidebarVersion.textContent = info.appVersionLabel;
    if (elements.appBackupDirectoryText) elements.appBackupDirectoryText.textContent = info.appBackupDirectory || "app\\backups";
    const backupCreatedAt = info.lastBackup?.createdAt || info.lastBackup?.externalBackup?.createdAt || info.lastBackup?.appBackup?.createdAt;
    elements.systemData.innerHTML = `
      <span><strong>Serverzeit</strong> ${escapeHtml(info.serverTime)} Uhr</span>
      <span><strong>App</strong> ${escapeHtml(appName)} ${escapeHtml(info.appVersionLabel)}</span>
      <span><strong>Betriebsmodus</strong> ${escapeHtml(operationModeLabel(info.portal?.operationMode))}</span>
      <span><strong>Node.js</strong> ${escapeHtml(info.nodeVersion)}</span>
      <span><strong>SQLite</strong> ${escapeHtml(info.sqliteVersion)}</span>
      <span><strong>System</strong> ${escapeHtml(info.platform)}</span>
      <span><strong>Datenbank</strong> ${escapeHtml(info.database)}</span>
      <span><strong>App-Backup</strong> ${escapeHtml(info.appBackupDirectory || "app\\backups")}</span>
      <span><strong>PC-Backup</strong> ${info.externalBackupEnabled ? escapeHtml(info.backupDirectory) : "deaktiviert"}</span>
      <span><strong>Letztes Backup</strong> ${backupCreatedAt ? escapeHtml(new Intl.DateTimeFormat("de-AT", { dateStyle: "short", timeStyle: "short" }).format(new Date(backupCreatedAt))) : "noch ausständig"}</span>
      <span><strong>Laufzeit</strong> ${uptimeHours} h ${uptimeMinutes} min</span>`;
    renderServerDiagnostics(info.serverDiagnostics);
  } catch {
    elements.systemData.textContent = "Technische Daten konnten nicht geladen werden.";
  }
}

function formatOptionDates(option) {
  return option.date_from === option.date_to
    ? formatDate(option.date_from, { day: "2-digit", month: "2-digit" })
    : `${formatDate(option.date_from, { day: "2-digit", month: "2-digit" })}–${formatDate(option.date_to, { day: "2-digit", month: "2-digit" })}`;
}

function renderEmployees() {
  const showInactive = state.data?.settings?.show_inactive_personnel !== "0";
  const employees = showInactive ? state.allEmployees : state.allEmployees.filter((employee) => employee.active);
  const canEditFull = !state.portalStatus?.portalEnabled || state.portalSession?.user?.permissions?.includes("employees:write");
  const canEditDisplay = canEditFull || state.portalSession?.user?.permissions?.includes("employees:display:write");
  const canReadPersonnelRecord = state.portalStatus?.installationFeatures?.sicknessAmu !== false
    && (!state.portalStatus?.portalEnabled || state.portalSession?.user?.permissions?.includes("amu:metadata:read"));
  elements.employeeTableBody.innerHTML = employees.map((employee) => `
    <tr>
      <td><span class="employee-color" style="background:${employee.color}"></span></td>
      <td><strong>${escapeHtml(employee.personnel_number)}</strong></td>
      <td>${escapeHtml(employee.full_name)}</td>
      <td>${escapeHtml(employee.nickname)}</td>
      <td>${escapeHtml(employee.position_name || "Verkaufsmitarbeiter")}</td>
      <td>${escapeHtml(employee.home_location_name || employee.home_location_id || "–")}</td>
      <td>${escapeHtml(employee.preferred_department_name || "–")}</td>
      <td>${String(employee.contracted_hours).replace(".", ",")} h</td>
      <td>${preferredDayLabels[employee.preferred_day_off] || "–"}</td>
      <td>${escapeHtml(formatFixedWorkdays(employee.fixed_workdays))}</td>
      <td><span class="status-badge ${employee.active ? "" : "inactive"}">${employee.active ? "Aktiv" : "Inaktiv"}</span></td>
      <td><span class="table-actions">${canReadPersonnelRecord ? `<button type="button" class="edit-button" data-personnel-record="${escapeHtml(employee.personnel_number)}">Personalakt</button>` : ""}${canEditDisplay ? `<button type="button" class="edit-button" data-edit-employee="${escapeHtml(employee.personnel_number)}">${canEditFull ? "Bearbeiten" : "Farbe ändern"}</button>` : ""}</span></td>
    </tr>`).join("");
}

function renderLocations() {
  if (!elements.locationList) return;
  const locations = state.locations || [];
  const permissions = state.portalSession?.user?.permissions || [];
  const localAccess = !state.portalStatus?.portalEnabled;
  const canEditLocations = localAccess || permissions.includes("locations:write");
  const canEditDepartments = localAccess || permissions.includes("departments:write");
  elements.departmentLocation.innerHTML = locations.map((location) =>
    `<option value="${escapeHtml(location.id)}">${escapeHtml(location.id)} · ${escapeHtml(location.name)}</option>`,
  ).join("");
  if (!elements.departmentLocation.value && state.locationId) elements.departmentLocation.value = state.locationId;
  if (!state.editingLocationId) setLocationDayFields(currentLocation()?.day_settings || locations[0]?.day_settings || {});
  elements.locationList.innerHTML = locations.length ? locations.map((location) => {
    const departments = location.departments || [];
    const openingSummary = planningDayKeys.filter((day) => location.day_settings?.[day]?.open !== false).map((day) => `${preferredDayLabels[day]?.slice(0, 2) || (day === "saturday" ? "Sa" : day.slice(0, 2))} ${location.day_settings?.[day]?.start || "–"}–${location.day_settings?.[day]?.end || "–"}`).join(" · ");
    return `<article class="location-card">
      <div class="location-card-head">
        <div><strong>${escapeHtml(location.id)} · ${escapeHtml(location.name)}</strong><small>${location.active ? "Aktiv" : "Inaktiv"} · ${departments.length} Abteilung(en) · Mindestbesetzung Filiale: ${Number(location.min_staff || 0)} · Zeiterfassung ${location.time_tracking_enabled ? "aktiv" : "aus"}</small><small>${escapeHtml(openingSummary)}</small></div>
        ${canEditLocations ? `<button type="button" class="edit-button" data-edit-location="${escapeHtml(location.id)}">Filiale bearbeiten</button>` : ""}
      </div>
      <div class="department-list">${
        departments.length ? departments.map((department) => `
          <div class="department-item">
            <span>${escapeHtml(department.name)}${department.active ? "" : " · inaktiv"} · Mindestbesetzung: ${Number(department.min_staff || 0)}</span>
            ${canEditDepartments ? `<button type="button" class="edit-button" data-edit-department="${department.id}">Bearbeiten</button>` : ""}
          </div>
        `).join("") : '<div class="empty-options">Keine Abteilungen angelegt.</div>'
      }</div>
    </article>`;
  }).join("") : '<div class="empty-options">Noch keine Filiale angelegt.</div>';
}

function renderPositions() {
  if (!elements.positionList) return;
  const positions = state.positions || [];
  const canEdit = !state.portalStatus?.portalEnabled || state.portalSession?.user?.permissions?.includes("positions:write");
  elements.positionList.innerHTML = positions.length ? positions.map((position) => `
    <div class="position-item">
      <div><strong>${escapeHtml(position.name)}</strong><small>${position.builtin ? "Standardposition · fix" : "Eigene Position"}</small></div>
      <div class="position-actions">${
        position.builtin
          ? '<span class="status-badge">Fix</span>'
          : canEdit
            ? `<button type="button" class="edit-button" data-edit-position="${escapeHtml(position.id)}">Bearbeiten</button><button type="button" class="delete-option" data-delete-position="${escapeHtml(position.id)}">Löschen</button>`
            : ""
      }</div>
    </div>
  `).join("") : '<div class="empty-options">Keine Positionen angelegt.</div>';
}

function renderSettings() {
  const settings = state.data.settings;
  const vacationSettings = state.vacationData?.settings || settings;
  const branding = applyShellBranding(hasManagementBrandingAccess() ? {} : settings);
  elements.brandingCompanyName.value = branding.companyName;
  elements.brandingAdminEmail.value = branding.adminEmail;
  elements.brandingLogoUrl.value = branding.logoUrl;
  elements.brandingIconUrl.value = branding.iconUrl;
  elements.brandingLogoAlt.value = branding.logoAlt;
  state.brandingFormDirty = false;
  renderBrandingKits();
  document.querySelector("#pdfTitleSetting").value = settings.pdf_title;
  document.querySelector("#pdfFilenamePrefix").value = settings.pdf_filename_prefix || settings.pdf_title || "Dienstplan";
  document.querySelector("#pdfFilenameIncludeKw").checked = settings.pdf_filename_include_kw !== "0";
  document.querySelector("#pdfFilenameIncludeTimestamp").checked = settings.pdf_filename_include_timestamp === "1";
  document.querySelector("#vacationPdfTitleSetting").value = vacationSettings.vacation_pdf_title || "Urlaubsplanung";
  document.querySelector("#vacationPdfFilenamePrefix").value = vacationSettings.vacation_pdf_filename_prefix || vacationSettings.vacation_pdf_title || "Urlaubsplanung";
  document.querySelector("#vacationPdfFilenameIncludePeriod").checked = vacationSettings.vacation_pdf_filename_include_period !== "0";
  document.querySelector("#vacationPdfFilenameIncludeTimestamp").checked = vacationSettings.vacation_pdf_filename_include_timestamp === "1";
  document.querySelector("#vacationPdfShowBalance").checked = vacationSettings.vacation_pdf_show_balance !== "0";
  document.querySelector("#vacationPdfBalanceShowEntitlement").checked = vacationSettings.vacation_pdf_balance_show_entitlement !== "0";
  document.querySelector("#vacationPdfBalanceShowPlanned").checked = vacationSettings.vacation_pdf_balance_show_planned !== "0";
  document.querySelector("#vacationPdfBalanceShowConsumed").checked = vacationSettings.vacation_pdf_balance_show_consumed === "1";
  document.querySelector("#vacationPdfCalendarStyle").value = vacationSettings.vacation_pdf_calendar_style || "bars";
  document.querySelector("#toastDuration").value = settings.toast_duration || "medium";
  document.querySelector("#showInactivePersonnel").checked = settings.show_inactive_personnel !== "0";
  document.querySelector("#showSaturdayServiceStats").checked = settings.show_saturday_service_stats !== "0";
  document.querySelector("#externalBackupEnabled").checked = settings.external_backup_enabled !== "0";
  document.querySelector("#backupDirectory").value = settings.backup_directory || "";
  document.querySelector("#backupIntervalHours").value = settings.backup_interval_hours || "2";
  document.querySelector("#vacationCountSaturday").checked = settings.vacation_count_saturday === "1";
  document.querySelector("#allowPastWeekEditing").checked = settings.allow_past_week_editing === "1";
  elements.currentWeekAutoLock.checked = settings.current_week_auto_lock !== "0";
  elements.currentWeekLockMode.value = settings.current_week_lock_mode || "closing";
  elements.currentWeekLockDay.value = settings.current_week_lock_day || "saturday";
  elements.currentWeekLockTime.value = settings.current_week_lock_time || "17:00";
  updateWeekLockSettings();
  if (elements.vacationHrApprovalRequired) {
    elements.vacationHrApprovalRequired.checked = Boolean(state.workflowSettings?.vacationHrApprovalRequired ?? state.portalStatus?.workflow?.vacationHrApprovalRequired);
    elements.workflowSettingsHint.textContent = "Die Einstellung kann von Personalleitung oder Admin geändert werden.";
  }
  document.querySelector("#breakRuleEnabled").checked = settings.break_rule_enabled === "1";
  document.querySelector("#breakAfterHours").value = Number(settings.break_after_minutes) / 60;
  document.querySelector("#breakDuration").value = settings.break_duration_minutes;
  document.querySelector("#saturdayBonusEnabled").checked = settings.saturday_bonus_enabled === "1";
  document.querySelector("#saturdayBonusFrom").value = settings.saturday_bonus_from;
  document.querySelector("#saturdayBonusFactor").value = settings.saturday_bonus_factor;
  document.querySelector("#showSunday").checked = settings.show_sunday === "1";
  renderOperationMode();
  updatePdfPreview();
}

function updateWeekLockSettings() {
  const active = elements.currentWeekAutoLock.checked;
  const manual = elements.currentWeekLockMode.value === "manual";
  elements.currentWeekLockSettings.classList.toggle("disabled-setting", !active);
  elements.currentWeekLockMode.disabled = !active;
  elements.manualWeekLockFields.classList.toggle("hidden", !active || !manual);
  elements.currentWeekLockTime.min = elements.currentWeekLockDay.value === "friday" ? "18:00" : "00:00";
  const settings = state.data?.settings || {};
  const openDays = planningDayKeys.filter((day) => settings[`${day}_open`] !== "0");
  const lastDay = openDays.at(-1) || "friday";
  const label = fixedDayLabels[lastDay] || lastDay;
  const time = settings[`${lastDay}_end_time`] || "18:00";
  elements.currentWeekLockHint.textContent = manual ? "Manuell möglich von Freitag 18:00 Uhr bis Sonntag 23:00 Uhr." : `Automatisch nach der letzten Schließzeit: ${label}, ${time} Uhr.`;
}

function renderOperationMode() {
  const status = state.portalStatus || {};
  const actualLanActive = status.operationMode === "lan" && status.portalEnabled === true;
  const actualServerActive = status.operationMode === "server" && status.portalEnabled === true;
  const selectedLan = state.desiredOperationMode === "lan";
  const selectedServer = state.desiredOperationMode === "server";
  const selectedLocal = !selectedLan && !selectedServer;
  elements.localModeOption?.classList.toggle("active", selectedLocal);
  elements.localModeOption?.setAttribute("aria-current", String(selectedLocal));
  elements.serverModeOption?.classList.toggle("active", selectedLan);
  elements.serverModeOption?.setAttribute("aria-current", String(selectedLan));
  elements.publicServerModeOption?.classList.toggle("active", selectedServer);
  elements.publicServerModeOption?.setAttribute("aria-current", String(selectedServer));
  if (elements.localModeBadge) {
    elements.localModeBadge.textContent = selectedLocal ? "Aktiv" : "Verfügbar";
    elements.localModeBadge.classList.toggle("inactive", !selectedLocal);
  }
  if (elements.serverModeBadge) {
    elements.serverModeBadge.textContent = actualLanActive ? "Aktiv" : (selectedLan ? "Ausgewählt" : "Verfügbar");
    elements.serverModeBadge.classList.toggle("inactive", !actualLanActive);
  }
  if (elements.publicServerModeBadge) {
    elements.publicServerModeBadge.textContent = actualServerActive ? "Aktiv" : "IT-Konfiguration erforderlich";
    elements.publicServerModeBadge.classList.toggle("inactive", !actualServerActive);
  }
  if (elements.portalFoundationHint) {
    const networkText = (status.networkUrls || []).length ? ` Erreichbar unter ${status.networkUrls.join(" oder ")}.` : "";
    elements.portalFoundationHint.textContent = actualServerActive
      ? `HTTPS-Serverbetrieb ist aktiv${status.publicUrl ? ` unter ${status.publicUrl}` : ""}. Login, sichere Cookies und Server-Passwortregeln werden erzwungen.`
      : actualLanActive
      ? `LAN-Host ist aktiv. Anmeldung und Rollen werden erzwungen.${networkText}`
      : status.adminSetupState === "configured"
        ? "Admin-Zugang ist eingerichtet. Der LAN-Host kann aktiviert und anschließend sicher neu gestartet werden."
        : "Bitte zuerst den Admin-Zugang unter „Zugänge“ einrichten.";
  }
  if (elements.adminAccessModeLabel) elements.adminAccessModeLabel.textContent = actualServerActive ? "Geschützter HTTPS-Zugang" : "Geschützter LAN-Zugang";
  elements.employeePortalLink?.classList.toggle("hidden", !(actualLanActive || actualServerActive));
  elements.portalLogoutButton?.classList.toggle("hidden", status.portalEnabled !== true);
}

function portalRoleAssignableInUi(actorRole, roleId) {
  if (roleId === "developer") return false;
  if (!actorRole || actorRole === "developer") return true;
  if (actorRole === "admin") return roleId !== "it_admin";
  if (actorRole === "it_admin") return ["employee", "manager", "department_manager", "hr"].includes(roleId);
  if (actorRole === "hr") return ["employee", "manager", "department_manager"].includes(roleId);
  return actorRole === "manager" && roleId === "department_manager";
}

function portalUserManageableInUi(actorRole, user) {
  if (user.roleLocked || user.role === "developer") return false;
  if (!actorRole || actorRole === "developer") return true;
  if (actorRole === "admin") return user.role !== "it_admin";
  if (actorRole === "it_admin") return ["employee", "manager", "department_manager", "hr"].includes(user.role);
  if (actorRole === "hr") return ["employee", "manager", "department_manager"].includes(user.role);
  return actorRole === "manager" && user.role === "department_manager";
}

async function loadPortalUsers() {
  if (!elements.portalUserList) return;
  try {
    const result = await api("/api/portal/v1/users");
    state.portalUsers = result.users || [];
    const actorRole = state.portalSession?.user?.role;
    const permissions = state.portalSession?.user?.permissions || [];
    const localAccess = !state.portalStatus?.portalEnabled;
    const mayManageUsers = localAccess || permissions.includes("users:write");
    const mayManageScopes = localAccess || permissions.includes("scopes:write");
    const roles = (result.roles || []).filter((role) => role.assignable !== false && portalRoleAssignableInUi(actorRole, role.id));
    elements.accessSettingsHint.textContent = state.portalStatus?.adminSetupState === "configured"
      ? "Startpasswörter werden nie angezeigt. Ein neu gesetztes Passwort muss beim ersten Login geändert werden."
      : "Zuerst einen Admin einrichten; danach können weitere Zugänge vorbereitet werden.";
    elements.adminSetupButton.classList.toggle("hidden", state.portalStatus?.adminSetupState === "configured");
    elements.portalUserList.innerHTML = state.portalUsers.map((user) => {
      const scope = user.scopes?.[0] || { locationId: user.homeLocationId || state.locations[0]?.id || "", departmentId: user.preferredDepartmentId || "" };
      const locations = state.locations.map((location) => `<option value="${escapeHtml(location.id)}" ${location.id === scope.locationId ? "selected" : ""}>${escapeHtml(location.id)} · ${escapeHtml(location.name)}</option>`).join("");
      const departments = (state.locations.find((location) => location.id === scope.locationId)?.departments || []).map((department) => `<option value="${department.id}" ${Number(department.id) === Number(scope.departmentId) ? "selected" : ""}>${escapeHtml(department.name)}</option>`).join("");
      const roleEditable = mayManageUsers && portalUserManageableInUi(actorRole, user);
      const scopeEditable = mayManageScopes && portalUserManageableInUi(actorRole, user) && ["manager", "department_manager"].includes(user.role);
      const protectedRole = user.roleLocked || user.role === "developer";
      const roleControl = roleEditable
        ? `<select data-portal-role aria-label="Rolle">${roles.map((role) => `<option value="${escapeHtml(role.id)}" ${role.id === user.role ? "selected" : ""}>${escapeHtml(role.name)}</option>`).join("")}</select>`
        : `<input data-portal-role type="hidden" value="${escapeHtml(user.role)}" /><span class="protected-role-badge ${protectedRole ? "developer" : ""}">${escapeHtml(user.roleName || user.role)}${protectedRole ? " · geschützt" : ""}</span>`;
      return `
      <article class="portal-user-row" data-portal-user="${escapeHtml(user.employeeNumber)}">
        <div><strong>${escapeHtml(user.employeeNumber)} · ${escapeHtml(user.nickname || user.fullName)}</strong><small>${user.passwordConfigured ? "Zugang eingerichtet" : "Noch kein Passwort"}${user.lastLoginAt ? ` · zuletzt ${escapeHtml(new Date(user.lastLoginAt).toLocaleString("de-AT"))}` : ""}${user.locked ? ` · gesperrt bis ${escapeHtml(new Date(user.lockedUntil).toLocaleString("de-AT"))}` : user.failedLoginAttempts ? ` · ${Number(user.failedLoginAttempts)} Fehlversuch(e)` : ""}</small></div>
        ${roleControl}
        <select data-scope-location aria-label="Zugewiesene Filiale" class="${["manager", "department_manager"].includes(user.role) ? "" : "hidden"}" ${scopeEditable ? "" : "disabled"}>${locations}</select>
        <select data-scope-department aria-label="Zugewiesene Abteilung" class="${user.role === "department_manager" ? "" : "hidden"}" ${scopeEditable ? "" : "disabled"}>${departments}</select>
        <label class="portal-active"><input data-portal-active type="checkbox" ${user.active ? "checked" : ""} ${roleEditable ? "" : "disabled"} /> aktiv</label>
        <span class="password-field portal-user-password ${roleEditable ? "" : "hidden"}"><input data-portal-password id="portalPassword-${escapeHtml(user.employeeNumber)}" type="password" minlength="${Number(state.portalStatus?.passwordMinLength || 6)}" placeholder="Neues Startpasswort" autocomplete="new-password" /><button class="password-toggle" type="button" data-password-toggle="portalPassword-${escapeHtml(user.employeeNumber)}" aria-label="Passwort anzeigen">Anzeigen</button></span>
        <span class="portal-user-actions">${roleEditable || scopeEditable ? '<button class="secondary-button" data-save-portal-user type="button">Speichern</button>' : ""}${(user.locked || user.failedLoginAttempts) && roleEditable ? '<button class="secondary-button" data-unlock-portal-user type="button">Entsperren</button>' : ""}</span>
      </article>`;
    }).join("");
    await loadApprovalDelegations();
  } catch (error) {
    elements.accessSettingsHint.textContent = error.status === 403 ? "Nur Admins dürfen Portal-Zugänge verwalten." : error.message;
    elements.portalUserList.innerHTML = "";
  }
}

function renderRightsManagement() {
  if (!elements.rightsUserList) return;
  const result = state.rightsManagement || {};
  const users = result.users || [];
  const query = String(elements.rightsEmployeeSearch?.value || "").trim().toLocaleLowerCase("de-AT");
  const filtered = users.filter((user) => !query || [user.employeeNumber, user.fullName, user.nickname, user.roleName]
    .some((value) => String(value || "").toLocaleLowerCase("de-AT").includes(query)));
  elements.rightsManagementHint.textContent = users.length
    ? `${filtered.length} von ${users.length} Teammitgliedern angezeigt. Zusatzrechte ergänzen die Grundrechte der jeweiligen Rolle.`
    : "Es sind noch keine aktiven Teammitglieder vorhanden.";
  elements.rightsUserList.innerHTML = filtered.length ? filtered.map((user) => {
    const additionalCount = (user.grantedPermissions || []).length;
    const location = state.locations.find((item) => item.id === user.homeLocationId);
    const status = !user.configured ? "Portal-Zugang noch nicht eingerichtet" : !user.active ? "Portal-Zugang inaktiv" : user.manageable ? "Zusatzrechte können bearbeitet werden" : "Rechte nur zur Ansicht";
    return `<article class="rights-user-card" data-rights-user="${escapeHtml(user.employeeNumber)}">
      <div class="rights-user-heading"><div><strong>${escapeHtml(user.employeeNumber)} · ${escapeHtml(user.nickname || user.fullName)}</strong><small>${escapeHtml(user.roleName || user.role)} · ${escapeHtml(location?.name || user.homeLocationId || "Kein Standort")} · ${additionalCount} Zusatzrecht${additionalCount === 1 ? "" : "e"}</small><small>${escapeHtml(status)}</small></div><button class="secondary-button" type="button" data-edit-user-rights>${user.manageable ? "Rechte bearbeiten" : "Rechte ansehen"}</button></div>
    </article>`;
  }).join("") : '<p class="settings-note rights-empty-search">Kein Teammitglied entspricht dieser Suche.</p>';
}

function openRightsEditor(employeeNumber) {
  const result = state.rightsManagement || {};
  const user = (result.users || []).find((entry) => entry.employeeNumber === employeeNumber);
  if (!user || !elements.rightsEditorModal) return;
  state.selectedRightsEmployeeNumber = employeeNumber;
  const rolePermissions = new Set(user.rolePermissions || []);
  const grantedPermissions = new Set(user.grantedPermissions || []);
  const location = state.locations.find((item) => item.id === user.homeLocationId);
  elements.rightsEditorTitle.textContent = `${user.employeeNumber} · ${user.nickname || user.fullName}`;
  elements.rightsEditorSummary.textContent = `${user.roleName || user.role} · ${location?.name || user.homeLocationId || "Kein Standort"}`;
  const groups = new Map();
  for (const permission of result.catalog || []) {
    const group = permission.group || "Weitere Rechte";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(permission);
  }
  elements.rightsEditorPermissions.innerHTML = [...groups.entries()].map(([group, permissions]) => `
    <section class="rights-permission-group"><h3>${escapeHtml(group)}</h3><div class="rights-permission-grid">${permissions.map((permission) => {
      const baseRight = rolePermissions.has(permission.id);
      const additionalRight = grantedPermissions.has(permission.id);
      const editable = Boolean(user.manageable && permission.editable && !baseRight);
      const lockedRight = !user.manageable || !permission.editable;
      const warningLevel = permission.warningLevel || "normal";
      const statusText = baseRight
        ? "Grundrecht der Rolle"
        : additionalRight
          ? lockedRight ? "Individuell vergeben · nur zur Ansicht" : "Individuell vergeben"
          : !user.manageable
            ? "Für die aktuelle Rolle nur zur Ansicht"
            : !permission.editable
              ? "Nur durch IT-Admin oder höhere Ebene änderbar"
              : permission.description || "Optionales Zusatzrecht";
      return `<label class="rights-permission ${warningLevel === "critical" ? "critical" : warningLevel === "high" ? "sensitive" : ""} ${baseRight ? "base-right" : ""} ${additionalRight && !baseRight ? "additional-right" : ""} ${lockedRight ? "locked-right" : ""}"><input type="checkbox" data-additional-permission value="${escapeHtml(permission.id)}" ${baseRight || additionalRight ? "checked" : ""} ${editable ? "" : "disabled"} /><span><strong>${escapeHtml(permission.label || permission.id)}</strong><small>${escapeHtml(statusText)}</small></span></label>`;
    }).join("")}</div></section>`).join("");
  elements.saveRightsEditorButton.disabled = !user.manageable;
  elements.rightsEditorHint.textContent = !user.configured
    ? "Bitte zuerst unter Zugänge einen Portal-Zugang einrichten."
    : !user.manageable
      ? "Dieser Zugang ist für die aktuelle Rolle geschützt oder liegt außerhalb ihrer Verwaltungsebene."
      : "Zusatzrechte gelten sofort, ergänzen die Grundrolle und bleiben an den zugewiesenen Standort beziehungsweise die Abteilung gebunden.";
  elements.rightsEditorModal.showModal();
}

function renderMobileLeadershipSettings() {
  if (!elements.mobileLeadershipModuleSettings) return;
  const result = state.mobileLeadershipSettings || {};
  const modules = result.availableModules || [];
  const layouts = result.layouts || {};
  const roleLabels = { department_manager: "Abteilungsleitung", manager: "Filialleitung", hr: "Personalleitung", admin: "Admin", it_admin: "IT-Admin", developer: "Developer" };
  elements.mobileLeadershipModuleSettings.innerHTML = Object.entries(roleLabels).map(([role, label]) => {
    const enabled = new Set(layouts[role] || []);
    return `<article class="mobile-role-card" data-mobile-layout-role="${role}"><strong>${label}</strong><div class="mobile-module-grid">${modules.map((module) => {
      const required = module.id === "timeTracking";
      return `<label><input type="checkbox" value="${escapeHtml(module.id)}" ${enabled.has(module.id) || required ? "checked" : ""} ${required ? "disabled" : ""} /><span>${escapeHtml(module.label || module.id)}</span></label>`;
    }).join("")}</div></article>`;
  }).join("");
  elements.saveMobileLeadershipSettingsButton.disabled = result.canChange === false;
  elements.mobileLeadershipSettingsHint.textContent = result.canChange === false ? "Nur Developer, IT-Admin, Admin oder Personalleitung kann diese Auswahl ändern." : "Zeiterfassung bleibt immer der erste Punkt; insgesamt maximal sechs Elemente je Rolle.";
}

async function loadRightsManagement() {
  if (!elements.rightsSettings) return;
  try {
    const [rights, mobile] = await Promise.all([
      api("/api/portal/v1/rights"),
      api("/api/portal/v1/mobile-layout"),
    ]);
    state.rightsManagement = rights;
    state.mobileLeadershipSettings = mobile;
    renderRightsManagement();
    renderMobileLeadershipSettings();
  } catch (error) {
    elements.rightsManagementHint.textContent = error.status === 403 ? "Rechtemanagement ist nur für Developer, IT-Admin, Admin und Personalleitung verfügbar." : error.message;
    elements.rightsUserList.innerHTML = "";
    elements.mobileLeadershipModuleSettings.innerHTML = "";
  }
}

async function saveUserRights(event) {
  event.preventDefault();
  const employeeNumber = state.selectedRightsEmployeeNumber;
  if (!employeeNumber) return;
  const permissions = [...elements.rightsEditorPermissions.querySelectorAll('input[data-additional-permission]:checked:not(:disabled)')].map((input) => input.value);
  try {
    state.rightsManagement = await api(`/api/portal/v1/rights/${encodeURIComponent(employeeNumber)}`, {
      method: "PUT",
      body: JSON.stringify({ permissions }),
    });
    elements.rightsEditorModal.close();
    renderRightsManagement();
    showToast(`Zusatzrechte für ${employeeNumber} wurden gespeichert.`);
  } catch (error) { showToast(error.message, true); }
}

async function saveMobileLeadershipSettings() {
  const layouts = {};
  elements.mobileLeadershipModuleSettings.querySelectorAll("[data-mobile-layout-role]").forEach((card) => {
    layouts[card.dataset.mobileLayoutRole] = [...card.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value).slice(0, 6);
  });
  try {
    state.mobileLeadershipSettings = await api("/api/portal/v1/mobile-layout", {
      method: "PUT",
      body: JSON.stringify({ layouts }),
    });
    renderMobileLeadershipSettings();
    showToast("Die mobile Leitungsansicht wurde gespeichert.");
  } catch (error) { showToast(error.message, true); }
}

async function loadAmuSettings() {
  if (!elements.amuSettingsCard) return;
  try {
    const result = await api("/api/portal/v1/amu-settings");
    const policy = result.policy || {};
    state.amuPolicy = policy;
    elements.amuUploadMaxMb.value = Number(policy.uploadMaxMb || 10);
    elements.amuStoredMaxMb.value = Number(policy.storedMaxMb || 2);
    elements.amuConvertImagesToPdf.checked = policy.convertImagesToPdf !== false;
    elements.amuGrayscaleImages.checked = policy.grayscaleImages !== false;
    elements.amuOcrEnabled.checked = policy.ocrEnabled !== false;
    elements.amuManagerFileAccess.checked = policy.managerFileAccess === true;
    elements.sicknessLocalWarningDays.value = Number(policy.localWarningDays ?? 2);
    elements.sicknessHrWarningDays.value = Number(policy.hrWarningDays ?? 3);
    [elements.amuUploadMaxMb, elements.amuStoredMaxMb, elements.amuConvertImagesToPdf, elements.amuGrayscaleImages, elements.amuOcrEnabled, elements.amuManagerFileAccess, elements.sicknessLocalWarningDays, elements.sicknessHrWarningDays, elements.saveAmuSettingsButton]
      .forEach((control) => { if (control) control.disabled = !result.canChange; });
    elements.amuSettingsHint.textContent = result.canChange ? "Änderbar durch Admin oder Personalleitung." : "Nur Admin oder Personalleitung kann diese Werte ändern.";
  } catch (error) {
    elements.amuSettingsCard.classList.toggle("hidden", error.status === 403);
    elements.amuSettingsHint.textContent = error.message;
  }
}

async function saveAmuSettings() {
  try {
    const result = await api("/api/portal/v1/amu-settings", {
      method: "PUT",
      body: JSON.stringify({
        uploadMaxMb: Number(elements.amuUploadMaxMb.value),
        storedMaxMb: Number(elements.amuStoredMaxMb.value),
        convertImagesToPdf: elements.amuConvertImagesToPdf.checked,
        grayscaleImages: elements.amuGrayscaleImages.checked,
        ocrEnabled: elements.amuOcrEnabled.checked,
        managerFileAccess: elements.amuManagerFileAccess.checked,
        localWarningDays: Number(elements.sicknessLocalWarningDays.value),
        hrWarningDays: Number(elements.sicknessHrWarningDays.value),
      }),
    });
    state.amuPolicy = result.policy;
    showToast("AUM-Einstellungen wurden gespeichert.");
    await loadAmuSettings();
  } catch (error) { showToast(error.message, true); }
}

function greetingTemplateLines(element) {
  return String(element?.value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function renderGreetingSettings(result) {
  const settings = result?.settings || {};
  state.greetingSettings = result;
  elements.personalizedGreetingsEnabled.checked = settings.enabled !== false;
  elements.greetingVacationMinimumDays.value = Number(settings.vacationMinimumCalendarDays || 14);
  elements.greetingReturnWorkdays.value = Number(settings.vacationReturnWorkdays || 3);
  elements.greetingRecoveryWorkdays.value = Number(settings.sicknessReturnWorkdays || 2);
  elements.greetingMorningTemplates.value = (settings.templates?.morning || []).join("\n");
  elements.greetingDaytimeTemplates.value = (settings.templates?.daytime || []).join("\n");
  elements.greetingEveningTemplates.value = (settings.templates?.evening || []).join("\n");
  elements.greetingVacationTemplates.value = (settings.templates?.vacationReturn || []).join("\n");
  elements.greetingSicknessActiveTemplates.value = (settings.templates?.sicknessActive || []).join("\n");
  elements.greetingSicknessReturnTemplates.value = (settings.templates?.sicknessReturn || []).join("\n");
  const controls = [
    elements.personalizedGreetingsEnabled, elements.greetingVacationMinimumDays, elements.greetingReturnWorkdays,
    elements.greetingRecoveryWorkdays, elements.greetingMorningTemplates, elements.greetingDaytimeTemplates,
    elements.greetingEveningTemplates, elements.greetingVacationTemplates, elements.greetingSicknessActiveTemplates,
    elements.greetingSicknessReturnTemplates, elements.saveGreetingSettingsButton,
  ];
  controls.forEach((control) => { if (control) control.disabled = result?.canChange === false; });
  elements.greetingSettingsHint.textContent = result?.canChange === false
    ? "Nur Personalleitung, Admin, IT-Admin oder Developer kann diese Texte verwalten."
    : "Die Auswahl erfolgt serverseitig; an das Portal wird ausschließlich der fertige, aktuell erlaubte Text übertragen.";
}

async function loadGreetingSettings() {
  if (!elements.greetingSettingsCard || elements.greetingSettingsCard.classList.contains("hidden")) return;
  try {
    renderGreetingSettings(await api("/api/portal/v1/greeting-settings"));
  } catch (error) {
    elements.greetingSettingsCard.classList.toggle("hidden", error.status === 403);
    elements.greetingSettingsHint.textContent = error.message;
  }
}

async function saveGreetingSettings() {
  try {
    const result = await api("/api/portal/v1/greeting-settings", {
      method: "PUT",
      body: JSON.stringify({
        enabled: elements.personalizedGreetingsEnabled.checked,
        vacationMinimumCalendarDays: Number(elements.greetingVacationMinimumDays.value),
        vacationReturnWorkdays: Number(elements.greetingReturnWorkdays.value),
        sicknessReturnWorkdays: Number(elements.greetingRecoveryWorkdays.value),
        templates: {
          morning: greetingTemplateLines(elements.greetingMorningTemplates),
          daytime: greetingTemplateLines(elements.greetingDaytimeTemplates),
          evening: greetingTemplateLines(elements.greetingEveningTemplates),
          vacationReturn: greetingTemplateLines(elements.greetingVacationTemplates),
          sicknessActive: greetingTemplateLines(elements.greetingSicknessActiveTemplates),
          sicknessReturn: greetingTemplateLines(elements.greetingSicknessReturnTemplates),
        },
      }),
    });
    renderGreetingSettings(result);
    showToast("Persönliche Begrüßungen wurden gespeichert.");
  } catch (error) { showToast(error.message, true); }
}

function renderWifiConfirmationLevels() {
  if (!elements.wifiConfirmationLevelList) return;
  const query = String(elements.wifiConfirmationLevelSearch?.value || "").trim().toLocaleLowerCase("de");
  const employees = (state.wifiAutomationSettings?.employees || []).filter((employee) => {
    if (!query) return true;
    return [employee.employeeNumber, employee.fullName, employee.nickname]
      .some((value) => String(value || "").toLocaleLowerCase("de").includes(query));
  });
  elements.wifiConfirmationLevelList.innerHTML = employees.length ? employees.map((employee) => `
    <article class="wifi-confirmation-level-row ${employee.active ? "" : "inactive"}">
      <div><strong>${escapeHtml(employee.employeeNumber)} · ${escapeHtml(employee.nickname || employee.fullName)}</strong><small>${escapeHtml(employee.fullName)}${employee.active ? "" : " · inaktiv"}</small></div>
      <label><span>Stufe</span><select data-wifi-confirmation-level="${escapeHtml(employee.employeeNumber)}"><option value="A" ${employee.level === "A" ? "selected" : ""}>A</option><option value="B" ${employee.level === "B" ? "selected" : ""}>B</option><option value="C" ${employee.level === "C" ? "selected" : ""}>C</option></select></label>
    </article>`).join("") : '<p class="settings-note">Keine passenden Teammitglieder gefunden.</p>';
}

function canManageWifiAutomationSettings() {
  if (!state.portalStatus?.portalEnabled) return true;
  const user = state.portalSession?.user;
  return Boolean(user
    && ["developer", "it_admin", "admin", "hr"].includes(user.role)
    && user.permissions?.includes("wifi:settings"));
}

function updateWifiAutomationRuleHint() {
  if (!elements.wifiAutomationSettingsHint) return;
  const minimum = Number(elements.wifiMinimumPresenceMinutes?.value || 5);
  const grace = Number(elements.wifiAbsenceGraceMinutes?.value || 30);
  elements.wifiAutomationSettingsHint.textContent = `Unter ${minimum} Minuten entsteht kein Vorschlag. Rückkehr innerhalb von ${grace} Minuten zählt als durchgehende Anwesenheit.`;
}

function renderWifiConnector() {
  const data = state.wifiAutomationSettings || {};
  const connector = data.connector || {};
  if (elements.wifiConnectorDetails) {
    elements.wifiConnectorDetails.innerHTML = `
      <div><strong>${connector.configured ? "Schnittstelle geschützt bereit" : "Schnittstelle noch nicht konfiguriert"}</strong><span>${escapeHtml(connector.configurationHint || "")}</span></div>
      <div><strong>Provider</strong><span>${escapeHtml(connector.providerId || "generic-radius")} · ${escapeHtml(connector.eventEndpoint || "/api/integrations/wifi/events")}</span></div>`;
  }
  if (!elements.wifiLocationMappingList) return;
  const mappings = data.locationMappings || [];
  elements.wifiLocationMappingList.innerHTML = mappings.length ? mappings.map((mapping) => `
    <article class="wifi-location-mapping-row" data-wifi-location-mapping="${escapeHtml(mapping.locationId)}">
      <div><strong>${escapeHtml(mapping.locationName)}</strong><small>${escapeHtml(mapping.locationId)} · ${mapping.mapped ? "zugeordnet" : "nicht zugeordnet"}${mapping.active ? "" : " · inaktiv"}</small></div>
      <label class="field"><span>Controller-Kennung</span><input data-wifi-location-reference maxlength="200" placeholder="${mapping.mapped ? "Neue Kennung zum Ersetzen" : "z. B. Filiale-18"}" /></label>
      <label class="wifi-location-clear"><input type="checkbox" data-wifi-location-clear ${mapping.mapped ? "" : "disabled"} /> Zuordnung löschen</label>
    </article>`).join("") : '<p class="settings-note">Noch keine Filialen vorhanden.</p>';
}

async function saveWifiLocationMappings() {
  const mappings = Array.from(elements.wifiLocationMappingList?.querySelectorAll("[data-wifi-location-mapping]") || []).map((row) => ({
    locationId: row.dataset.wifiLocationMapping,
    externalReference: row.querySelector("[data-wifi-location-reference]")?.value.trim() || "",
    clear: row.querySelector("[data-wifi-location-clear]")?.checked === true,
  })).filter((item) => item.clear || item.externalReference);
  if (!mappings.length) {
    showToast("Bitte mindestens eine neue Controller-Kennung eingeben oder eine Zuordnung zum Löschen markieren.", true);
    return;
  }
  try {
    const result = await api("/api/portal/v1/wifi-automation/location-mappings", {
      method: "PUT",
      body: JSON.stringify({ mappings }),
    });
    state.wifiAutomationSettings.locationMappings = result.locationMappings || [];
    renderWifiConnector();
    showToast("Die WLAN-Filialzuordnungen wurden gespeichert.");
  } catch (error) { showToast(error.message, true); }
}

async function loadWifiAutomationSettings() {
  if (!elements.wifiAutomationSettings) return;
  try {
    const result = await api("/api/portal/v1/wifi-automation/settings");
    state.wifiAutomationSettings = result;
    elements.wifiMinimumPresenceMinutes.value = Number(result.minimumPresenceMinutes || 5);
    elements.wifiAbsenceGraceMinutes.value = Number(result.absenceGraceMinutes || 30);
    elements.saveWifiAutomationSettingsButton.disabled = result.canChange === false;
    elements.saveWifiLocationMappingsButton.disabled = result.canChange === false;
    elements.saveWifiConfirmationLevelsButton.disabled = result.canChange === false;
    if (elements.wifiAutomationStatus) {
      const status = elements.wifiAutomationStatus.querySelector("strong");
      const detail = elements.wifiAutomationStatus.querySelector("small");
      if (status) status.textContent = result.connectorStatus === "configured" ? "WLAN-Schnittstelle verbunden" : "Noch keine WLAN-Schnittstelle verbunden";
      if (detail) detail.textContent = result.automationActive
        ? "Zeitvorschläge werden aus bestätigten Controller-Ereignissen vorbereitet."
        : "Teil 1 speichert Regeln und Vertrauensstufen. Es entstehen noch keine automatischen Zeitbuchungen.";
    }
    updateWifiAutomationRuleHint();
    renderWifiConnector();
    renderWifiConfirmationLevels();
  } catch (error) {
    elements.wifiAutomationSettingsHint.textContent = error.status === 403
      ? "WLAN-Regeln sind nur für Personalleitung, Admin, IT-Admin und Developer verfügbar."
      : error.message;
    elements.wifiConfirmationLevelList.innerHTML = "";
  }
}

async function saveWifiAutomationSettings() {
  try {
    const result = await api("/api/portal/v1/wifi-automation/settings", {
      method: "PUT",
      body: JSON.stringify({
        minimumPresenceMinutes: Number(elements.wifiMinimumPresenceMinutes.value),
        absenceGraceMinutes: Number(elements.wifiAbsenceGraceMinutes.value),
      }),
    });
    state.wifiAutomationSettings = { ...state.wifiAutomationSettings, ...result };
    updateWifiAutomationRuleHint();
    renderWifiConnector();
    showToast("Die WLAN-Anwesenheitsregeln wurden gespeichert.");
  } catch (error) { showToast(error.message, true); }
}

async function saveWifiConfirmationLevels() {
  const levels = (state.wifiAutomationSettings?.employees || [])
    .map((employee) => ({ employeeNumber: employee.employeeNumber, level: employee.level }));
  try {
    const result = await api("/api/portal/v1/wifi-automation/confirmation-levels", {
      method: "PUT",
      body: JSON.stringify({ levels }),
    });
    state.wifiAutomationSettings = { ...state.wifiAutomationSettings, employees: result.employees || [] };
    renderWifiConfirmationLevels();
    elements.wifiConfirmationLevelHint.textContent = result.changed
      ? `${result.changed} Vertrauensstufe(n) wurden aktualisiert.`
      : "Alle Vertrauensstufen waren bereits aktuell.";
    showToast("Die Vertrauensstufen wurden gespeichert.");
    await loadAll();
  } catch (error) { showToast(error.message, true); }
}

async function unlockPortalUser(row) {
  try {
    const result = await api(`/api/portal/v1/users/${encodeURIComponent(row.dataset.portalUser)}/unlock`, { method: "POST", body: "{}" });
    state.portalUsers = result.users || [];
    await loadPortalUsers();
    showToast("Der Zugang wurde entsperrt.");
  } catch (error) { showToast(error.message, true); }
}

function refreshDelegationEmployees() {
  const locationId = elements.delegationLocation?.value;
  const eligible = state.portalUsers.filter((user) => user.role === "department_manager" && user.active)
    .filter((user) => state.allEmployees.find((employee) => employee.personnel_number === user.employeeNumber)?.home_location_id === locationId);
  elements.delegationEmployee.innerHTML = eligible.map((user) => `<option value="${escapeHtml(user.employeeNumber)}">${escapeHtml(user.employeeNumber)} · ${escapeHtml(user.nickname || user.fullName)}</option>`).join("");
}

async function loadApprovalDelegations() {
  if (!elements.delegationList) return;
  try {
    const result = await api("/api/portal/v1/approval-delegations");
    state.approvalDelegations = result.delegations || [];
    elements.delegationLocation.innerHTML = state.locations.map((location) => `<option value="${escapeHtml(location.id)}">${escapeHtml(location.name)}</option>`).join("");
    refreshDelegationEmployees();
    elements.delegationList.innerHTML = state.approvalDelegations.length ? state.approvalDelegations.map((item) => `<div class="delegation-row" data-delegation-id="${item.id}"><div><strong>${escapeHtml(item.location_name)} · ${escapeHtml(item.delegate_employee_number)} · ${escapeHtml(item.nickname || item.full_name)}</strong><small>${formatDate(item.date_from)}–${formatDate(item.date_to)}${item.note ? ` · ${escapeHtml(item.note)}` : ""}</small></div><button class="danger-button" data-delete-delegation type="button">Löschen</button></div>`).join("") : '<p class="settings-note">Keine zeitlich begrenzte Vertretung hinterlegt.</p>';
  } catch (error) {
    elements.delegationSettingsCard.classList.toggle("hidden", error.status === 403);
  }
}

async function saveApprovalDelegation(event) {
  event.preventDefault();
  try {
    const result = await api("/api/portal/v1/approval-delegations", { method: "POST", body: JSON.stringify({ locationId: elements.delegationLocation.value, employeeNumber: elements.delegationEmployee.value, dateFrom: elements.delegationDateFrom.value, dateTo: elements.delegationDateTo.value, note: elements.delegationNote.value }) });
    state.approvalDelegations = result.delegations || [];
    elements.delegationForm.reset();
    await loadApprovalDelegations();
    showToast("Vertretung wurde gespeichert.");
  } catch (error) { showToast(error.message, true); }
}

async function loadManagerVacationRequests() {
  if (!elements.managerVacationRequestList) return;
  try {
    const sicknessEnabled = state.portalStatus?.installationFeatures?.sicknessAmu !== false;
    const [result, workflow, amu] = await Promise.all([
      api("/api/portal/v1/absence-requests"),
      api("/api/portal/v1/workflow-settings"),
      sicknessEnabled ? api("/api/portal/v1/amu-reports") : Promise.resolve({ reports: [], pendingCount: 0, canOpenFiles: false }),
    ]);
    state.absenceRequests = result.requests || [];
    state.amuReports = amu.reports || [];
    state.amuCanOpenFiles = amu.canOpenFiles === true;
    const absenceCounts = result.counts || { vacation: 0, timeOff: 0, total: 0 };
    const amuCount = Number(amu.pendingCount || state.amuReports.filter((item) => item.status === "submitted").length);
    state.requestCounts = { ...absenceCounts, amu: amuCount, total: Number(absenceCounts.total || 0) + amuCount };
    state.workflowSettings = workflow;
    if (elements.vacationHrApprovalRequired) elements.vacationHrApprovalRequired.checked = workflow.vacationHrApprovalRequired;
    renderRequestNavigation();
    renderManagerRequests();
  } catch (error) {
    elements.requestsNavButton?.classList.toggle("hidden", error.status === 403);
    if (error.status !== 403) elements.managerVacationRequestList.innerHTML = `<p class="settings-note">${escapeHtml(error.message)}</p>`;
  }
}

let timePresenceRefreshTimer = null;

function refreshTimePresenceDepartments() {
  const locationId = elements.timeTrackingLocation?.value || state.locationId;
  const user = state.portalSession?.user;
  const departmentManager = user?.role === "department_manager";
  const scopedDepartmentIds = new Set((user?.scopes || [])
    .filter((scope) => scope.locationId === locationId && scope.departmentId)
    .map((scope) => String(scope.departmentId)));
  const allDepartments = state.locations.find((location) => location.id === locationId)?.departments || [];
  const departments = departmentManager
    ? allDepartments.filter((department) => scopedDepartmentIds.has(String(department.id)))
    : allDepartments;
  const selected = elements.timeTrackingDepartment?.value || "";
  if (elements.timeTrackingDepartment) {
    elements.timeTrackingDepartment.innerHTML = `${departmentManager ? "" : '<option value="">Gesamte Filiale</option>'}${departments.map((department) => `<option value="${department.id}">${escapeHtml(department.name)}</option>`).join("")}`;
    elements.timeTrackingDepartment.value = departments.some((department) => String(department.id) === selected)
      ? selected
      : (departmentManager ? String(departments[0]?.id || "") : "");
  }
}

function prepareTimePresenceControls() {
  if (!elements.timeTrackingLocation) return;
  const user = state.portalSession?.user;
  const scopedLocationIds = new Set((user?.scopes || []).map((scope) => scope.locationId));
  const scopedRole = ["manager", "department_manager"].includes(user?.role);
  const availableLocations = state.locations.filter((location) => location.active && (!scopedRole || scopedLocationIds.has(location.id)));
  const selected = elements.timeTrackingLocation.value || state.locationId || state.locations[0]?.id || "";
  elements.timeTrackingLocation.innerHTML = availableLocations.map((location) => `<option value="${escapeHtml(location.id)}">${escapeHtml(location.id)} · ${escapeHtml(location.name)}</option>`).join("");
  elements.timeTrackingLocation.value = availableLocations.some((location) => location.id === selected) ? selected : elements.timeTrackingLocation.options[0]?.value || "";
  refreshTimePresenceDepartments();
}

function formatClockTimestamp(timestamp) {
  if (!timestamp) return "–";
  try { return new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Vienna" }).format(new Date(timestamp)); } catch { return "–"; }
}

function formatTimeDifference(minutes) {
  const value = Number(minutes || 0);
  return `${value >= 0 ? "+" : "−"}${formatHours(Math.abs(value))}`;
}

function renderTimePresence() {
  if (!elements.timePresenceList) return;
  const presence = state.timePresence;
  if (!presence) return;
  const employees = presence.employees || [];
  const counts = { working: 0, paused: 0, off: 0, attention: 0 };
  employees.forEach((employee) => { counts[employee.state] = Number(counts[employee.state] || 0) + 1; });
  elements.timePresenceSummary.innerHTML = `
    <article><span>Anwesend</span><strong>${counts.working}</strong></article>
    <article><span>Pause</span><strong>${counts.paused}</strong></article>
    <article><span>Abwesend</span><strong>${counts.off}</strong></article>
    <article class="${counts.attention ? "warning" : ""}"><span>Zu prüfen</span><strong>${counts.attention}</strong></article>`;
  elements.timePresenceUpdated.textContent = `${presence.locationName}${presence.departmentName ? ` · ${presence.departmentName}` : ""} · Stand ${formatClockTimestamp(presence.serverTime)} Uhr`;
  if (!presence.trackingEnabled) {
    elements.timePresenceList.innerHTML = '<p class="settings-note">Die Zeiterfassung ist für diesen Standort noch nicht aktiviert. Die Aktivierung erfolgt unter Teams & Standorte.</p>';
    return;
  }
  const labels = { working: "Anwesend", paused: "Pause", off: "Abwesend", attention: "Bitte prüfen" };
  const canReadPersonnelRecord = state.portalStatus?.installationFeatures?.sicknessAmu !== false
    && (!state.portalStatus?.portalEnabled || state.portalSession?.user?.permissions?.includes("amu:metadata:read"));
  const canReviewTime = !state.portalStatus?.portalEnabled
    || state.portalSession?.user?.permissions?.includes("time:review");
  elements.timePresenceList.innerHTML = employees.length ? employees.map((employee) => {
    const entries = (employee.entries || []).map((entry) => `${escapeHtml(entry.label)} ${formatClockTimestamp(entry.timestamp)}`).join(" · ");
    const issues = timeEvaluationIssues(employee).map((issue) => issue.label || issue.code).join(" · ");
    return `<article class="time-presence-row ${escapeHtml(employee.state)}">
      <span class="employee-color" style="background:${escapeHtml(employee.color || "#748087")}"></span>
      <div class="time-presence-person"><strong>${escapeHtml(employee.employeeNumber)} · ${escapeHtml(employee.nickname || employee.fullName)}</strong><small>${entries || "Heute noch keine Buchung"}${issues ? ` · ${escapeHtml(issues)}` : ""}</small></div>
      <span class="time-state-badge ${escapeHtml(employee.state)}">${labels[employee.state] || employee.state}</span>
      <div class="time-presence-hours"><span>Plan <strong>${formatHours(employee.plannedMinutes)}</strong></span><span>Ist <strong>${formatHours(employee.actualMinutes)}</strong></span><span>Gewertet <strong>${formatHours(employee.actualValuedMinutes)}</strong></span><span>Pause <strong>${formatHours(employee.breakMinutes)}</strong></span><span>Diff. <strong class="${Number(employee.differenceMinutes) < 0 ? "negative" : "positive"}">${formatTimeDifference(employee.differenceMinutes)}</strong></span></div>
      ${(employee.staleEntry && canReviewTime) || canReadPersonnelRecord ? `<div class="time-presence-actions">
        ${employee.staleEntry && canReviewTime ? `<button type="button" class="secondary-button compact-button" data-resolve-stale="${escapeHtml(employee.employeeNumber)}">Altbuchung abschließen</button>` : ""}
        ${canReadPersonnelRecord ? `<button type="button" class="secondary-button compact-button" data-personnel-record="${escapeHtml(employee.employeeNumber)}">Personalakt</button>` : ""}
      </div>` : ""}
    </article>`;
  }).join("") : '<p class="settings-note">Für diesen Bereich wurden keine aktiven Teammitglieder gefunden.</p>';
}

async function loadTimePresence() {
  if (!state.portalStatus?.capabilities?.timeTracking || !elements.timePresenceList) return;
  prepareTimePresenceControls();
  try {
    const parameters = new URLSearchParams({ locationId: elements.timeTrackingLocation.value });
    if (elements.timeTrackingDepartment.value) parameters.set("departmentId", elements.timeTrackingDepartment.value);
    const result = await api(`/api/portal/v1/time-presence?${parameters.toString()}`);
    state.timePresence = result.presence;
    renderTimePresence();
  } catch (error) {
    elements.timePresenceList.innerHTML = `<p class="settings-note">${escapeHtml(error.message)}</p>`;
  }
}

function selectedTimeContextParameters() {
  const parameters = new URLSearchParams({ locationId: elements.timeTrackingLocation?.value || state.locationId });
  if (elements.timeTrackingDepartment?.value) parameters.set("departmentId", elements.timeTrackingDepartment.value);
  return parameters;
}

function initializeTimeReviewDate() {
  if (!elements.timeReviewDate) return;
  const today = toIsoDate(new Date());
  elements.timeReviewDate.max = today;
  if (!elements.timeReviewDate.value) elements.timeReviewDate.value = today;
}

function timeEvaluationIssues(entry) {
  return Array.isArray(entry?.issues) ? entry.issues : [];
}

function renderTimeDayReview() {
  if (!elements.timeDayReviewList || !elements.timeDayReviewSummary) return;
  const payload = state.timeDayReview;
  if (!payload) return;
  const evaluations = payload.evaluations || [];
  const counts = payload.counts || {};
  elements.timeDayReviewSummary.innerHTML = `
    <article><span>Team</span><strong>${Number(counts.total || evaluations.length)}</strong></article>
    <article class="${Number(counts.attention || 0) ? "warning" : ""}"><span>Auffällig</span><strong>${Number(counts.attention || 0)}</strong></article>
    <article><span>Geprüft</span><strong>${Number(counts.reviewed || 0)}</strong></article>
    <article><span>Noch offen</span><strong>${Number(counts.unreviewed || 0)}</strong></article>`;
  const filter = elements.timeReviewFilter?.value || "all";
  const visible = evaluations.filter((entry) => {
    if (filter === "attention") return timeEvaluationIssues(entry).length > 0;
    if (filter === "reviewed") return Boolean(entry.review && !entry.review.stale);
    if (filter === "unreviewed") return !entry.review || entry.review.stale;
    return true;
  });
  const canReview = !state.portalStatus?.portalEnabled
    || state.portalSession?.user?.permissions?.includes("time:review");
  elements.timeDayReviewList.innerHTML = visible.length ? visible.map((entry) => {
    const issues = timeEvaluationIssues(entry);
    const status = entry.review?.stale
      ? '<span class="status-badge warning">Prüfung veraltet</span>'
      : entry.review
      ? `<span class="status-badge approved">Geprüft · ${escapeHtml(entry.review.reviewedBy || "")}</span>`
      : issues.length
        ? `<span class="status-badge warning">${issues.length} Hinweis${issues.length === 1 ? "" : "e"}</span>`
        : '<span class="status-badge inactive">Ungeprüft</span>';
    const issueText = issues.length
      ? issues.map((issue) => issue.label || issue.code).join(" · ")
      : entry.excused?.excused ? entry.excused.label : "Keine Auffälligkeit";
    return `<article class="time-day-review-row ${issues.some((issue) => issue.severity === "error") ? "has-error" : issues.length ? "has-warning" : ""}" data-time-day-employee="${escapeHtml(entry.employeeNumber)}">
      <span class="employee-color" style="background:${escapeHtml(entry.color || "#748087")}"></span>
      <div class="time-day-review-person"><strong>${escapeHtml(entry.employeeNumber)} · ${escapeHtml(entry.nickname || entry.fullName || "Teammitglied")}</strong><small>${escapeHtml(issueText)}</small></div>
      ${status}
      <div class="time-day-review-values">
        <span>Plan<strong>${formatHours(entry.plannedMinutes)}</strong></span>
        <span>Ist<strong>${formatHours(entry.actualMinutes)}</strong></span>
        <span>Gewertet<strong>${formatHours(entry.actualValuedMinutes)}</strong></span>
        <span>Pause<strong>${formatHours(entry.breakMinutes)}</strong></span>
        <span>Abw.<strong class="${Number(entry.differenceMinutes) < 0 ? "negative" : "positive"}">${formatTimeDifference(entry.differenceMinutes)}</strong></span>
      </div>
      ${canReview ? '<button type="button" class="secondary-button compact-button" data-open-time-day-review>Prüfen</button>' : ""}
    </article>`;
  }).join("") : '<p class="settings-note">Für diesen Filter gibt es keine Arbeitstageinträge.</p>';
}

async function loadTimeDayReview() {
  if (!elements.timeDayReviewList) return;
  initializeTimeReviewDate();
  const parameters = selectedTimeContextParameters();
  parameters.set("date", elements.timeReviewDate.value);
  elements.timeDayReviewList.innerHTML = '<p class="settings-note">Arbeitstag wird ausgewertet.</p>';
  try {
    const result = await api(`/api/portal/v1/time-day-evaluations?${parameters.toString()}`);
    state.timeDayReview = result.dayReview || result;
    renderTimeDayReview();
  } catch (error) {
    if (error.status === 403) elements.timeDayReviewPanel?.classList.add("hidden");
    else elements.timeDayReviewList.innerHTML = `<p class="settings-note">${escapeHtml(error.message)}</p>`;
  }
}

function openTimeDayReview(employeeNumber) {
  const entry = state.timeDayReview?.evaluations?.find((item) => item.employeeNumber === employeeNumber);
  if (!entry || !elements.timeDayReviewModal) return;
  elements.timeDayReviewEmployee.value = entry.employeeNumber;
  elements.timeDayReviewWorkDate.value = entry.workDate || state.timeDayReview.date;
  elements.timeDayReviewTitle.textContent = `${entry.employeeNumber} · ${entry.nickname || entry.fullName || "Teammitglied"}`;
  elements.timeDayReviewDetail.textContent = `${formatDate(entry.workDate || state.timeDayReview.date)} · Bewertungsregel ${entry.evaluationVersion || "v1"}`;
  elements.timeDayReviewMetrics.innerHTML = `
    <article><span>Plan</span><strong>${formatHours(entry.plannedMinutes)}</strong></article>
    <article><span>Ist</span><strong>${formatHours(entry.actualMinutes)}</strong></article>
    <article><span>Gewertet</span><strong>${formatHours(entry.actualValuedMinutes)}</strong></article>
    <article><span>Pause</span><strong>${formatHours(entry.breakMinutes)}${entry.requiredBreakMinutes ? ` / ${formatHours(entry.requiredBreakMinutes)}` : ""}</strong></article>
    <article><span>Abweichung</span><strong class="${Number(entry.differenceMinutes) < 0 ? "negative" : "positive"}">${formatTimeDifference(entry.differenceMinutes)}</strong></article>`;
  const issues = timeEvaluationIssues(entry);
  elements.timeDayReviewIssues.innerHTML = issues.length
    ? issues.map((issue) => `<article class="${escapeHtml(issue.severity || "warning")}"><strong>${escapeHtml(issue.label || issue.code)}</strong><p>${escapeHtml(issue.message || "")}</p></article>`).join("")
    : '<p class="settings-note">Für diesen Arbeitstag gibt es keine Auffälligkeit.</p>';
  elements.timeDayReviewNote.value = entry.review?.note || "";
  elements.removeTimeDayReviewButton.classList.toggle("hidden", !entry.review);
  elements.timeDayReviewMessage.textContent = "";
  elements.timeDayReviewMessage.classList.add("hidden");
  elements.timeDayReviewModal.showModal();
}

async function saveTimeDayReview(reviewed) {
  const employeeNumber = elements.timeDayReviewEmployee.value;
  const date = elements.timeDayReviewWorkDate.value;
  const body = {
    reviewed,
    note: elements.timeDayReviewNote.value,
    locationId: elements.timeTrackingLocation.value,
    departmentId: elements.timeTrackingDepartment.value || null,
  };
  try {
    await api(`/api/portal/v1/time-day-reviews/${encodeURIComponent(employeeNumber)}/${encodeURIComponent(date)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    elements.timeDayReviewModal.close();
    showToast(reviewed ? "Der Arbeitstag wurde als geprüft gespeichert." : "Die Tagesprüfung wurde aufgehoben.");
    await Promise.all([loadTimeDayReview(), loadTimePresence(), loadTimeSummary()]);
  } catch (error) {
    elements.timeDayReviewMessage.textContent = error.message;
    elements.timeDayReviewMessage.classList.remove("hidden");
  }
}

function initializeTimeSummaryDates() {
  if (!elements.timeSummaryFrom || elements.timeSummaryFrom.value) return;
  const today = toIsoDate(new Date());
  elements.timeSummaryFrom.value = getMonday(new Date());
  elements.timeSummaryTo.value = today;
}

function renderTimeSummary() {
  if (!elements.timeSummaryList) return;
  const summary = state.timeSummary;
  const employees = summary?.employees || [];
  elements.timeSummaryList.innerHTML = employees.length ? employees.map((employee) => `<article class="time-summary-row">
    <div><strong>${escapeHtml(employee.employeeNumber)} · ${escapeHtml(employee.nickname || employee.fullName)}</strong><small>${formatDate(summary.from)}–${formatDate(summary.to)}${employee.issueDays ? ` · ${Number(employee.issueDays)} auffällige Tag(e)` : ""}${employee.reviewedDays ? ` · ${Number(employee.reviewedDays)} geprüft` : ""}</small></div>
    <div class="time-summary-metric"><span>Plan</span><strong>${formatHours(employee.plannedMinutes)}</strong></div>
    <div class="time-summary-metric"><span>Ist</span><strong>${formatHours(employee.actualMinutes)}</strong></div>
    <div class="time-summary-metric"><span>Gewertet</span><strong>${formatHours(employee.actualValuedMinutes)}</strong></div>
    <div class="time-summary-metric"><span>Pause</span><strong>${formatHours(employee.breakMinutes)}</strong></div>
    <div class="time-summary-metric"><span>Differenz</span><strong class="${Number(employee.differenceMinutes) < 0 ? "negative" : "positive"}">${formatTimeDifference(employee.differenceMinutes)}</strong></div>
  </article>`).join("") : '<p class="settings-note">Für diesen Zeitraum wurden keine auswertbaren Teammitglieder gefunden.</p>';
}

async function loadTimeSummary() {
  if (!elements.timeSummaryList) return;
  initializeTimeSummaryDates();
  const parameters = selectedTimeContextParameters();
  parameters.set("from", elements.timeSummaryFrom.value);
  parameters.set("to", elements.timeSummaryTo.value);
  elements.timeSummaryList.innerHTML = '<p class="settings-note">Arbeitszeiten werden ausgewertet.</p>';
  try {
    const result = await api(`/api/portal/v1/time-summary?${parameters.toString()}`);
    state.timeSummary = result.summary || result;
    renderTimeSummary();
  } catch (error) {
    elements.timeSummaryList.innerHTML = `<p class="settings-note">${escapeHtml(error.message)}</p>`;
  }
}

function correctionChange(correction) {
  const value = correction.requestedChange ?? correction.requested_change ?? {};
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function renderTimeCorrections() {
  if (!elements.timeCorrectionRequestList) return;
  const corrections = state.timeCorrections || [];
  elements.timeCorrectionCount.textContent = `${corrections.length} offen`;
  elements.timeCorrectionCount.classList.toggle("inactive", !corrections.length);
  elements.timeCorrectionRequestList.innerHTML = corrections.length ? corrections.map((correction) => {
    const change = correctionChange(correction);
    const entries = (change.entries || correction.entries || []).map((entry) => `${entry.label || entry.type}: ${entry.time || String(entry.timestamp || "").slice(11, 16)}`).join(" · ");
    return `<article class="time-correction-row" data-time-correction-request="${Number(correction.id)}"><div><strong>${escapeHtml(correction.employeeNumber || correction.employee_number)} · ${escapeHtml(correction.nickname || correction.fullName || correction.full_name || "Teammitglied")}</strong><small>${formatDate(correction.correctionDate || correction.correction_date)}${entries ? ` · ${escapeHtml(entries)}` : ""}${correction.requestNote || correction.request_note ? ` · ${escapeHtml(correction.requestNote || correction.request_note)}` : ""}</small></div><span class="status-badge">Offen</span><button class="secondary-button" type="button" data-review-time-correction>Prüfen</button></article>`;
  }).join("") : '<p class="settings-note">Keine offenen Zeitkorrekturen.</p>';
}

async function loadTimeCorrections() {
  if (!elements.timeCorrectionRequestList) return;
  try {
    const parameters = selectedTimeContextParameters();
    parameters.set("status", "pending");
    const result = await api(`/api/portal/v1/time-corrections?${parameters.toString()}`);
    state.timeCorrections = result.corrections || [];
    renderTimeCorrections();
  } catch (error) {
    if (error.status === 403) {
      elements.timeCorrectionPanel?.classList.add("hidden");
      return;
    }
    elements.timeCorrectionRequestList.innerHTML = `<p class="settings-note">${escapeHtml(error.message)}</p>`;
  }
}

function openTimeCorrectionReview(id) {
  const correction = state.timeCorrections.find((item) => Number(item.id) === Number(id));
  if (!correction) return;
  const change = correctionChange(correction);
  const entries = change.entries || correction.entries || [];
  elements.timeCorrectionReviewId.value = correction.id;
  elements.timeCorrectionReviewSummary.textContent = `${correction.employeeNumber || correction.employee_number} · ${formatDate(correction.correctionDate || correction.correction_date)}${correction.requestNote || correction.request_note ? ` · ${correction.requestNote || correction.request_note}` : ""}`;
  renderTimeCorrectionReviewEntries(entries);
  elements.timeCorrectionReviewNote.value = "";
  elements.timeCorrectionReviewMessage.textContent = "";
  elements.timeCorrectionReviewMessage.classList.add("hidden");
  elements.timeCorrectionReviewModal.showModal();
}

const timeCorrectionEntryLabels = {
  clock_in: "Kommen",
  break_start: "Pause",
  break_end: "Weiter",
  clock_out: "Gehen",
};

function renderTimeCorrectionReviewEntries(entries = []) {
  if (!elements.timeCorrectionReviewEntries) return;
  const normalized = entries.length ? entries : [{ type: "clock_in", time: "09:00" }, { type: "clock_out", time: "18:00" }];
  elements.timeCorrectionReviewEntries.innerHTML = normalized.map((entry, index) => `<div class="time-correction-entry-row">
    <label class="field"><span>Buchung ${index + 1}</span><select data-time-correction-entry-type>${Object.entries(timeCorrectionEntryLabels).map(([value, label]) => `<option value="${value}" ${entry.type === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <label class="field"><span>Uhrzeit</span><input data-time-correction-entry-time type="time" step="60" value="${escapeHtml(entry.time || String(entry.timestamp || "").slice(11, 16) || "")}" required /></label>
    <button type="button" class="icon-button" data-remove-time-correction-entry aria-label="Buchung entfernen">×</button>
  </div>`).join("");
}

function addTimeCorrectionReviewEntry() {
  const entries = collectTimeCorrectionReviewEntries();
  const lastType = entries.at(-1)?.type || "clock_out";
  const nextType = lastType === "clock_in" || lastType === "break_end" ? "clock_out"
    : lastType === "break_start" ? "break_end" : "clock_in";
  entries.push({ type: nextType, time: "" });
  renderTimeCorrectionReviewEntries(entries);
  [...elements.timeCorrectionReviewEntries.querySelectorAll("[data-time-correction-entry-time]")].at(-1)?.focus();
}

function collectTimeCorrectionReviewEntries() {
  return [...(elements.timeCorrectionReviewEntries?.querySelectorAll(".time-correction-entry-row") || [])].map((row) => ({
    type: row.querySelector("[data-time-correction-entry-type]").value,
    time: row.querySelector("[data-time-correction-entry-time]").value,
  })).filter((entry) => entry.time);
}

async function decideTimeCorrection(action) {
  const id = elements.timeCorrectionReviewId.value;
  const entries = collectTimeCorrectionReviewEntries();
  try {
    await api(`/api/portal/v1/time-corrections/${encodeURIComponent(id)}/decision`, {
      method: "PUT",
      body: JSON.stringify({ action, entries, decisionNote: elements.timeCorrectionReviewNote.value }),
    });
    elements.timeCorrectionReviewModal.close();
    showToast(action === "approve" ? "Zeitkorrektur wurde genehmigt." : "Zeitkorrektur wurde abgelehnt.");
    await Promise.all([loadTimeCorrections(), loadTimePresence(), loadTimeSummary()]);
  } catch (error) {
    elements.timeCorrectionReviewMessage.textContent = error.message;
    elements.timeCorrectionReviewMessage.classList.remove("hidden");
  }
}

function openStaleTimeCorrection(employeeNumber) {
  const employee = state.timePresence?.employees?.find((item) => item.employeeNumber === employeeNumber);
  if (!employee?.staleEntry || !elements.timeCorrectionModal) return;
  elements.timeCorrectionEmployee.value = employeeNumber;
  elements.timeCorrectionWorkDate.value = employee.staleEntry.date || "";
  elements.timeCorrectionEmployeeLabel.textContent = `${employeeNumber} · ${employee.nickname || employee.fullName || "Teammitglied"}`;
  elements.timeCorrectionDateLabel.textContent = formatDate(employee.staleEntry.date);
  elements.timeCorrectionClockOutTime.value = employee.staleEntry.suggestedClockOutTime || "18:00";
  elements.timeCorrectionMessage.textContent = "";
  elements.timeCorrectionMessage.classList.add("hidden");
  elements.timeCorrectionModal.showModal();
  setTimeout(() => elements.timeCorrectionClockOutTime.focus(), 30);
}

async function submitStaleTimeCorrection(event) {
  event.preventDefault();
  const submitButton = elements.timeCorrectionForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    await api("/api/portal/v1/time-corrections/resolve-stale", {
      method: "POST",
      body: JSON.stringify({
        employeeNumber: elements.timeCorrectionEmployee.value,
        workDate: elements.timeCorrectionWorkDate.value,
        clockOutTime: elements.timeCorrectionClockOutTime.value,
      }),
    });
    elements.timeCorrectionModal.close();
    showToast("Die offene Altbuchung wurde nachvollziehbar abgeschlossen.");
    await loadTimePresence();
  } catch (error) {
    elements.timeCorrectionMessage.textContent = error.message;
    elements.timeCorrectionMessage.classList.remove("hidden");
  } finally {
    submitButton.disabled = false;
  }
}

async function openPersonnelRecord(employeeNumber) {
  if (!elements.personnelRecordModal) return;
  elements.personnelRecordTitle.textContent = `Personalakt · ${employeeNumber}`;
  elements.personnelRecordContent.innerHTML = '<p class="settings-note">Einträge werden geladen.</p>';
  elements.personnelRecordModal.showModal();
  try {
    const result = await api(`/api/portal/v1/personnel-records/${encodeURIComponent(employeeNumber)}`);
    const employee = result.employee || {};
    elements.personnelRecordTitle.textContent = `${employee.personnel_number || employeeNumber} · ${employee.nickname || employee.full_name || "Personalakt"}`;
    elements.personnelRecordContent.innerHTML = result.reports?.length ? result.reports.map((report) => {
      const documents = (report.documents || []).map((document) => result.canOpenFiles
        ? `<a class="secondary-button compact-button" href="/api/portal/v1/amu-reports/${report.id}/documents/${encodeURIComponent(document.id)}/content" target="_blank" rel="noopener">${escapeHtml(document.original_name || "Dokument")} öffnen</a>`
        : `<span class="status-badge inactive">${escapeHtml(document.original_name || "Dokument")} · kein Dateizugriff</span>`).join("");
      return `<article class="personnel-record-entry"><div><strong>${formatDate(report.incapacity_from)}–${formatDate(report.incapacity_to)}</strong><small>${escapeHtml(report.location_name || "")}${report.department_name ? ` · ${escapeHtml(report.department_name)}` : ""} · ${escapeHtml(requestStatusLabels[report.status] || report.status)}</small>${report.employee_note ? `<p>${escapeHtml(report.employee_note)}</p>` : ""}</div><div class="amu-document-links">${documents || "Kein aktives Dokument"}</div></article>`;
    }).join("") : '<p class="settings-note">Noch keine Arbeitsunfähigkeitsmeldungen im Personalakt.</p>';
  } catch (error) {
    elements.personnelRecordContent.innerHTML = `<p class="settings-note">${escapeHtml(error.message)}</p>`;
  }
}

const requestStatusLabels = {
  pending_local: "Offen",
  preliminary_local: "Vorläufig genehmigt",
  pending_hr: "Wartet auf Personalleitung",
  approved: "Genehmigt",
  rejected: "Abgelehnt",
  cancelled: "Storniert",
  withdrawn: "Zurückgezogen",
  submitted: "Eingereicht",
  reviewed: "Geprüft",
  returned: "Ergänzung erforderlich",
};

function renderRequestNavigation() {
  const counts = state.requestCounts;
  const sicknessEnabled = state.portalStatus?.installationFeatures?.sicknessAmu !== false;
  document.querySelectorAll('[data-request-kind-tab="amu"]').forEach((button) => button.classList.toggle("hidden", !sicknessEnabled));
  if (!sicknessEnabled && state.requestKindTab === "amu") state.requestKindTab = "vacation";
  document.querySelectorAll("[data-request-kind-tab]").forEach((button) => button.classList.toggle("active", button.dataset.requestKindTab === state.requestKindTab));
  elements.requestsNavCount.textContent = counts.total;
  elements.requestsNavCount.classList.toggle("hidden", !counts.total);
  elements.requestsNavButton.classList.toggle("attention", counts.total > 0);
  elements.vacationRequestCount.textContent = counts.vacation;
  elements.timeOffRequestCount.textContent = counts.timeOff;
  elements.amuRequestCount.textContent = sicknessEnabled ? counts.amu || 0 : 0;
  elements.requestWorkflowSummary.innerHTML = `
    <article><span>Urlaub offen</span><strong>${counts.vacation}</strong></article>
    <article><span>ZA offen</span><strong>${counts.timeOff}</strong></article>
    ${sicknessEnabled ? `<article><span>AUM neu</span><strong>${counts.amu || 0}</strong></article>` : ""}
    <article><span>Urlaubs-Zweitfreigabe</span><strong>${state.workflowSettings?.vacationHrApprovalRequired ? "Aktiv" : "Nicht aktiv"}</strong>${state.workflowSettings?.canChange ? `<button type="button" class="text-action" data-toggle-hr-workflow>${state.workflowSettings.vacationHrApprovalRequired ? "Deaktivieren" : "Aktivieren"}</button>` : ""}</article>`;
}

async function toggleHrWorkflow(required) {
  try {
    state.workflowSettings = await api("/api/portal/v1/workflow-settings", { method: "PUT", body: JSON.stringify({ vacationHrApprovalRequired: required }) });
    if (elements.vacationHrApprovalRequired) elements.vacationHrApprovalRequired.checked = required;
    renderRequestNavigation();
    showToast(required ? "Die Zweitfreigabe durch die Personalleitung ist aktiv." : "Die Zweitfreigabe durch die Personalleitung ist deaktiviert.");
  } catch (error) { showToast(error.message, true); }
}

function requestIsActionable(request) {
  if (!["pending_local", "preliminary_local", "pending_hr"].includes(request.status)) return false;
  const role = state.portalSession?.user?.role;
  if (request.approval_stage === "hr") return role === "hr" || role === "admin" || !state.portalStatus?.portalEnabled;
  return role !== "hr" || role === "admin" || !state.portalStatus?.portalEnabled;
}

function renderManagerRequests() {
  const statusFilter = elements.requestStatusFilter.value || "actionable";
  if (state.requestKindTab === "amu") {
    const reports = state.amuReports.filter((report) => statusFilter === "all" ? true : statusFilter === "actionable" ? ["submitted", "returned"].includes(report.status) : report.status === statusFilter);
    const canOpenFiles = !state.portalStatus?.portalEnabled || state.amuCanOpenFiles === true;
    const canReview = !state.portalStatus?.portalEnabled || state.portalSession?.user?.permissions?.includes("amu:review");
    elements.managerVacationRequestList.innerHTML = reports.length ? reports.map((report) => {
      const files = (report.documents || []).map((document) => canOpenFiles
        ? `<a href="/api/portal/v1/amu-reports/${report.id}/documents/${encodeURIComponent(document.id)}/content" target="_blank" rel="noopener">${escapeHtml(document.original_name || "Dokument")} · ${Math.max(1, Math.round(Number(document.size || 0) / 1024))} KB</a>`
        : `<span>${escapeHtml(document.original_name || "Dokument")} · ${Math.max(1, Math.round(Number(document.size || 0) / 1024))} KB</span>`).join("");
      return `<article class="manager-request-row amu-request-row" data-amu-report="${report.id}">
        <span class="employee-dot" style="--employee-color:${escapeHtml(report.color || "#507267")}"></span>
        <div><strong><span class="request-kind-badge amu">AUM</span> ${escapeHtml(report.employee_number)} · ${escapeHtml(report.nickname || report.full_name)}</strong><small>${formatDate(report.incapacity_from)}–${formatDate(report.incapacity_to)} · ${escapeHtml(report.location_name || "")}${report.employee_note ? ` · ${escapeHtml(report.employee_note)}` : ""}</small><small><span class="request-status ${escapeHtml(report.status)}">${escapeHtml(requestStatusLabels[report.status] || report.status)}</span>${report.reviewed_by ? ` · geprüft von ${escapeHtml(report.reviewed_by)}` : ""}${report.review_note ? ` · ${escapeHtml(report.review_note)}` : ""}</small><div class="amu-document-links">${files}</div></div>
        ${canReview && ["submitted", "returned"].includes(report.status) ? '<button class="secondary-button" data-open-amu-action type="button">AUM bearbeiten</button>' : ""}
      </article>`;
    }).join("") : '<p class="settings-note">Für diesen Filter gibt es keine Arbeitsunfähigkeitsmeldungen.</p>';
    return;
  }
  const isTimeOff = state.requestKindTab === "time_off";
  const requests = state.absenceRequests.filter((request) => {
    const kindMatches = isTimeOff ? request.kind.startsWith("time_off") : !request.kind.startsWith("time_off");
    const statusMatches = statusFilter === "all" ? true : statusFilter === "actionable" ? requestIsActionable(request) : request.status === statusFilter;
    return kindMatches && statusMatches;
  });
  elements.managerVacationRequestList.innerHTML = requests.length ? requests.map((request) => {
      const details = managerRequestDetails(request);
      const approvals = [request.local_approved_by ? `Filiale: ${escapeHtml(request.local_approved_by)}` : "", request.hr_approved_by ? `PL: ${escapeHtml(request.hr_approved_by)}` : ""].filter(Boolean).join(" · ");
      return `
      <article class="manager-request-row" data-manager-request="${request.id}" data-request-kind="${escapeHtml(request.kind)}">
        <span class="employee-dot" style="--employee-color:${escapeHtml(request.color || "#507267")}"></span>
        <div><strong><span class="request-kind-badge ${escapeHtml(request.kind)}">${escapeHtml(details.label)}</span> ${escapeHtml(request.employee_number)} · ${escapeHtml(request.nickname || request.full_name)}</strong><small>${details.text}${request.note ? ` · ${escapeHtml(request.note)}` : ""}</small><small><span class="request-status ${escapeHtml(request.status)}">${escapeHtml(requestStatusLabels[request.status] || request.status)}</span>${approvals ? ` · ${approvals}` : ""}${request.decision_note ? ` · ${escapeHtml(request.decision_note)}` : ""}</small></div>
        <button class="secondary-button" data-open-request-action type="button">Antrag bearbeiten</button>
      </article>
    `; }).join("") : '<p class="settings-note">Für diesen Filter gibt es keine Anträge.</p>';
}

function managerRequestDetails(request) {
  if (request.kind === "time_off_change") return {
    label: "ZA ändern",
    text: `${formatDate(request.original_date_from)}${request.original_date_to !== request.original_date_from ? `–${formatDate(request.original_date_to)}` : ""} → ${formatDate(request.requested_date_from)}${request.requested_date_to !== request.requested_date_from ? `–${formatDate(request.requested_date_to)}` : ""}${request.requested_all_day ? " · ganztägig" : ` · ${escapeHtml(request.requested_start_time)}–${escapeHtml(request.requested_end_time)}`}`,
  };
  if (request.kind === "time_off_cancel") return {
    label: "ZA stornieren",
    text: `${formatDate(request.original_date_from)}${request.original_date_to !== request.original_date_from ? `–${formatDate(request.original_date_to)}` : ""}${request.original_all_day ? " · ganztägig" : ` · ${escapeHtml(request.original_start_time)}–${escapeHtml(request.original_end_time)}`}`,
  };
  if (request.kind === "time_off") return {
    label: request.approval_type === "hr" ? "PL-ZA" : "ZA",
    text: `${formatDate(request.date_from || request.request_date)}${(request.date_to || request.request_date) !== (request.date_from || request.request_date) ? `–${formatDate(request.date_to)}` : ""}${request.all_day ? " · ganztägig" : ` · ${escapeHtml(request.start_time)}–${escapeHtml(request.end_time)}`}`,
  };
  if (request.kind === "vacation_change") return {
    label: "Urlaub ändern",
    text: `${formatDate(request.original_date_from)}–${formatDate(request.original_date_to)} → ${formatDate(request.requested_date_from)}–${formatDate(request.requested_date_to)}`,
  };
  if (request.kind === "vacation_cancel") return {
    label: "Urlaub stornieren",
    text: `${formatDate(request.original_date_from)}–${formatDate(request.original_date_to)}`,
  };
  return { label: "Urlaub", text: `${formatDate(request.date_from)}–${formatDate(request.date_to)}` };
}

function openAmuAction(id) {
  const report = state.amuReports.find((item) => Number(item.id) === Number(id));
  if (!report) return;
  state.selectedRequest = null;
  state.selectedAmuReport = report;
  elements.requestActionTitle.textContent = "AUM bearbeiten";
  elements.requestActionSummary.textContent = `${report.employee_number} · ${report.nickname || report.full_name} · ${formatDate(report.incapacity_from)}–${formatDate(report.incapacity_to)}`;
  elements.requestActionNote.value = "";
  elements.requestEditFields.classList.add("hidden");
  elements.requestActionHistory.innerHTML = report.reviewed_by
    ? `<div><strong>${escapeHtml(report.reviewed_by)} · ${escapeHtml(requestStatusLabels[report.status] || report.status)}</strong><span>${report.reviewed_at ? escapeHtml(new Date(report.reviewed_at).toLocaleString("de-AT")) : ""}${report.review_note ? ` · ${escapeHtml(report.review_note)}` : ""}</span></div>`
    : '<p>Noch keine Prüfung protokolliert.</p>';
  const canOpenFiles = !state.portalStatus?.portalEnabled || state.amuCanOpenFiles === true;
  elements.requestActionDocuments.classList.remove("hidden");
  elements.requestActionDocuments.innerHTML = (report.documents || []).map((document) => canOpenFiles
    ? `<a class="secondary-button" href="/api/portal/v1/amu-reports/${report.id}/documents/${encodeURIComponent(document.id)}/content" target="_blank" rel="noopener">${escapeHtml(document.original_name || "Dokument")} öffnen</a>`
    : `<span>${escapeHtml(document.original_name || "Dokument")}</span>`).join("");
  document.querySelectorAll("[data-request-action]").forEach((button) => button.classList.add("hidden"));
  document.querySelectorAll("[data-amu-action]").forEach((button) => button.classList.toggle("hidden", !["submitted", "returned"].includes(report.status)));
  elements.requestActionModal.showModal();
}

async function reviewAmu(action) {
  const report = state.selectedAmuReport;
  if (!report) return;
  try {
    await api(`/api/portal/v1/amu-reports/${report.id}/review`, { method: "PUT", body: JSON.stringify({ action, note: elements.requestActionNote.value }) });
    elements.requestActionModal.close();
    state.selectedAmuReport = null;
    showToast("Die AUM wurde als geprüft markiert.");
    await loadAll();
  } catch (error) { showToast(error.message, true); }
}

function openRequestAction(id, kind) {
  const request = state.absenceRequests.find((item) => Number(item.id) === Number(id) && item.kind === kind);
  if (!request) return;
  state.selectedRequest = request;
  state.selectedAmuReport = null;
  const details = managerRequestDetails(request);
  elements.requestActionTitle.textContent = `${details.label} bearbeiten`;
  elements.requestActionSummary.textContent = `${request.employee_number} · ${request.nickname || request.full_name} · ${details.text}`;
  elements.requestActionNote.value = "";
  const approved = request.status === "approved";
  elements.requestEditFields.classList.toggle("hidden", !approved);
  const timeOff = request.kind === "time_off";
  elements.requestEditDateFromField.querySelector("span").textContent = timeOff ? "Neues Datum" : "Neu von";
  elements.requestEditDateToField.classList.toggle("hidden", timeOff && !request.all_day);
  elements.requestEditTimeField.classList.toggle("hidden", !timeOff || request.all_day);
  elements.requestEditDateFrom.value = timeOff ? (request.date_from || request.request_date) : request.date_from;
  elements.requestEditDateTo.value = timeOff ? (request.date_to || request.request_date) : request.date_to;
  elements.requestEditStartTime.value = timeOff ? request.start_time : "";
  elements.requestEditEndTime.value = timeOff ? request.end_time : "";
  elements.requestActionHistory.innerHTML = request.decisions?.length ? request.decisions.map((decision) => `<div><strong>${escapeHtml(decision.actor_employee_number)} · ${escapeHtml(decision.action)}</strong><span>${escapeHtml(new Date(decision.created_at).toLocaleString("de-AT"))}${decision.note ? ` · ${escapeHtml(decision.note)}` : ""}</span></div>`).join("") : '<p>Noch keine Entscheidung protokolliert.</p>';
  elements.requestActionDocuments.classList.add("hidden");
  elements.requestActionDocuments.innerHTML = "";
  document.querySelectorAll("[data-amu-action]").forEach((button) => button.classList.add("hidden"));
  document.querySelectorAll("[data-request-action]").forEach((button) => {
    const action = button.dataset.requestAction;
    const hidden = request.status === "approved" ? !["change", "cancel"].includes(action) : ["change", "cancel"].includes(action) || (request.approval_stage === "hr" && action === "preliminary");
    button.classList.toggle("hidden", hidden);
  });
  elements.requestActionModal.showModal();
}

async function decideVacationRequest(action) {
  const request = state.selectedRequest;
  if (!request) return;
  const apiKind = ["vacation_change", "vacation_cancel"].includes(request.kind) ? "vacation_change"
    : ["time_off_change", "time_off_cancel"].includes(request.kind) ? "time_off_change" : request.kind;
  try {
    await api(`/api/portal/v1/absence-requests/${apiKind}/${request.id}/action`, {
      method: "PUT",
      body: JSON.stringify({ action, note: elements.requestActionNote.value, dateFrom: elements.requestEditDateFrom.value, dateTo: elements.requestEditDateTo.value, date: elements.requestEditDateFrom.value, startTime: elements.requestEditStartTime.value, endTime: elements.requestEditEndTime.value }),
    });
    elements.requestActionModal.close();
    showToast(action === "approve" ? "Der Antrag wurde genehmigt beziehungsweise weitergeleitet." : action === "preliminary" ? "Der Antrag wurde vorläufig genehmigt." : action === "cancel" ? "Der Antrag wurde storniert." : "Der Antrag wurde abgelehnt.");
    await loadAll();
  } catch (error) { showToast(error.message, true); }
}

function refreshRequestBlackoutDepartments(selectedDepartmentId = "") {
  if (!elements.requestBlackoutDepartment) return;
  const departments = departmentsForLocation(elements.requestBlackoutLocation.value, true);
  elements.requestBlackoutDepartment.innerHTML = `<option value="">Gesamte Filiale</option>${departments.map((department) =>
    `<option value="${department.id}">${escapeHtml(department.name)}${department.active ? "" : " (inaktiv)"}</option>`,
  ).join("")}`;
  elements.requestBlackoutDepartment.value = departments.some((department) => String(department.id) === String(selectedDepartmentId)) ? String(selectedDepartmentId) : "";
}

function resetRequestBlackoutForm() {
  state.editingRequestBlackoutId = null;
  elements.requestBlackoutForm?.reset();
  if (elements.requestBlackoutVacation) elements.requestBlackoutVacation.checked = true;
  if (elements.requestBlackoutActive) elements.requestBlackoutActive.checked = true;
  if (elements.requestBlackoutLocation) elements.requestBlackoutLocation.value = state.locationId || state.locations.find((location) => location.active)?.id || "";
  refreshRequestBlackoutDepartments();
  elements.cancelRequestBlackoutEdit?.classList.add("hidden");
  if (elements.requestBlackoutSubmit) elements.requestBlackoutSubmit.textContent = "Sperre speichern";
  elements.requestBlackoutForm?.classList.add("hidden");
}

function renderRequestBlackouts() {
  if (!elements.requestBlackoutList) return;
  elements.requestBlackoutLocation.innerHTML = state.locations.map((location) => `<option value="${escapeHtml(location.id)}">${escapeHtml(location.name)}${location.active ? "" : " (inaktiv)"}</option>`).join("");
  if (!state.editingRequestBlackoutId) resetRequestBlackoutForm();
  elements.requestBlackoutList.innerHTML = state.requestBlackouts.length ? state.requestBlackouts.map((item) => `
    <article class="request-blackout-row ${item.active ? "" : "inactive"}" data-request-blackout="${item.id}">
      <div><strong>${escapeHtml(item.locationName)}${item.departmentName ? ` · ${escapeHtml(item.departmentName)}` : ""}</strong><small>${formatDate(item.dateFrom)}–${formatDate(item.dateTo)} · ${item.blockVacation ? "Urlaub" : ""}${item.blockVacation && item.blockTimeOff ? " + " : ""}${item.blockTimeOff ? "ZA" : ""}${item.reason ? ` · ${escapeHtml(item.reason)}` : ""}${item.active ? "" : " · inaktiv"}</small></div>
      <button class="secondary-button" data-edit-request-blackout type="button">Bearbeiten</button>
      <button class="secondary-button danger-button" data-delete-request-blackout type="button">Löschen</button>
    </article>
  `).join("") : '<p class="settings-note">Noch keine Antragssperren hinterlegt.</p>';
}

async function loadRequestBlackouts() {
  if (!elements.requestBlackoutList) return;
  try {
    const result = await api("/api/portal/v1/request-blackouts");
    state.requestBlackouts = result.blackouts || [];
    elements.requestBlackoutPanel.classList.remove("hidden");
    renderRequestBlackouts();
  } catch (error) {
    elements.requestBlackoutPanel.classList.toggle("hidden", error.status === 403);
    if (error.status !== 403) elements.requestBlackoutList.innerHTML = `<p class="settings-note">${escapeHtml(error.message)}</p>`;
  }
}

function editRequestBlackout(id) {
  const item = state.requestBlackouts.find((entry) => Number(entry.id) === Number(id));
  if (!item) return;
  state.editingRequestBlackoutId = item.id;
  elements.requestBlackoutForm.classList.remove("hidden");
  elements.requestBlackoutLocation.value = item.locationId;
  refreshRequestBlackoutDepartments(item.departmentId || "");
  elements.requestBlackoutDateFrom.value = item.dateFrom;
  elements.requestBlackoutDateTo.value = item.dateTo;
  elements.requestBlackoutReason.value = item.reason;
  elements.requestBlackoutVacation.checked = item.blockVacation;
  elements.requestBlackoutTimeOff.checked = item.blockTimeOff;
  elements.requestBlackoutActive.checked = item.active;
  elements.cancelRequestBlackoutEdit.classList.remove("hidden");
  elements.requestBlackoutSubmit.textContent = "Änderung speichern";
  elements.requestBlackoutForm.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function saveRequestBlackout(event) {
  event.preventDefault();
  const id = state.editingRequestBlackoutId;
  try {
    const result = await api(id ? `/api/portal/v1/request-blackouts/${id}` : "/api/portal/v1/request-blackouts", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify({
        locationId: elements.requestBlackoutLocation.value,
        departmentId: elements.requestBlackoutDepartment.value || null,
        dateFrom: elements.requestBlackoutDateFrom.value,
        dateTo: elements.requestBlackoutDateTo.value,
        reason: elements.requestBlackoutReason.value,
        blockVacation: elements.requestBlackoutVacation.checked,
        blockTimeOff: elements.requestBlackoutTimeOff.checked,
        active: elements.requestBlackoutActive.checked,
      }),
    });
    state.requestBlackouts = result.blackouts || [];
    resetRequestBlackoutForm();
    renderRequestBlackouts();
    showToast(id ? "Antragssperre wurde aktualisiert." : "Antragssperre wurde gespeichert.");
  } catch (error) { showToast(error.message, true); }
}

async function deleteRequestBlackout(id) {
  if (!confirm("Diese Antragssperre wirklich löschen?")) return;
  try {
    await api(`/api/portal/v1/request-blackouts/${id}`, { method: "DELETE" });
    await loadRequestBlackouts();
    showToast("Antragssperre wurde gelöscht.");
  } catch (error) { showToast(error.message, true); }
}

function renderBrandingKits() {
  if (!elements.brandingKitLibrary) return;
  const kits = state.brandingKits || [];
  const activeKitId = String(state.brandingPreference?.kitId || "");
  elements.brandingKitLibrary.innerHTML = kits.length ? `
    <div class="branding-kit-library-heading">
      <div><strong>Installierte Branding-Kits</strong><small>Lokal gespeichert, z. B. am USB-Stick unter <code>data/branding-kits</code>.</small></div>
    </div>
    <div class="branding-kit-grid">
      ${kits.map((kit) => {
        const branding = brandingFromSettings(kit.branding || {});
        const active = String(kit.id) === activeKitId;
        return `<article class="branding-kit-card ${active ? "active" : ""}">
          <div class="branding-kit-preview">
            <img src="${escapeHtml(branding.logoUrl)}" alt="" />
            <span><img src="${escapeHtml(branding.iconUrl)}" alt="" /></span>
          </div>
          <div class="branding-kit-meta">
            <strong>${escapeHtml(kit.name || branding.companyName || "Branding-Kit")}</strong>
            <small>${escapeHtml(branding.companyName || "Neutral")}${branding.adminEmail ? ` · ${escapeHtml(branding.adminEmail)}` : ""}</small>
          </div>
          <div class="branding-kit-card-actions">
            <button type="button" class="${active ? "secondary-button" : "primary-button"}" data-apply-branding-kit="${escapeHtml(kit.id)}" ${active ? "disabled" : ""}>${active ? "Aktiv" : "Anwenden"}</button>
            ${kit.builtin ? "" : `<button type="button" class="delete-option" data-delete-branding-kit="${escapeHtml(kit.id)}" data-branding-kit-name="${escapeHtml(kit.name || branding.companyName || "Branding-Kit")}">Löschen</button>`}
          </div>
        </article>`;
      }).join("")}
    </div>
  ` : '<div class="empty-options">Noch keine Branding-Kits installiert.</div>';
}

function renderBrandingAssignments() {
  if (!elements.brandingAssignmentList) return;
  const assignments = new Map((state.brandingAssignments || []).map((item) => [String(item.locationId || item.location_id), item]));
  const kitIds = new Set((state.brandingKits || []).map((kit) => String(kit.id)));
  const standardOptions = [`<option value="">Standard-Branding</option>`, ...(state.brandingKits || []).map((kit) => `<option value="${escapeHtml(kit.id)}">${escapeHtml(kit.name || kit.branding?.companyName || "Branding-Kit")}</option>`)].join("");
  const rows = (state.locations || []).map((location) => {
    const assignment = assignments.get(location.id) || {};
    const kitId = String(assignment.kitId || assignment.kit_id || "");
    const preservedOption = kitId && !kitIds.has(kitId)
      ? `<option value="${escapeHtml(kitId)}">${escapeHtml(kitId === "custom" ? "Individuelles Branding (bestehend)" : `Bestehendes Branding · ${assignment.kitName || assignment.kit_name || kitId}`)}</option>`
      : "";
    return `<article class="branding-assignment-row" data-branding-location="${escapeHtml(location.id)}" data-initial-branding-kit="${escapeHtml(kitId)}">
      <div><strong>${escapeHtml(location.id)} · ${escapeHtml(location.name)}</strong><small>${kitId ? `Eigenes Kit: ${escapeHtml(assignment.kitName || assignment.kit_name || kitId)}` : "Verwendet das Standard-Branding"}</small></div>
      <label class="field"><span>Branding-Kit</span><select data-location-branding-kit>${standardOptions}${preservedOption}</select></label>
    </article>`;
  }).join("");
  elements.brandingAssignmentList.innerHTML = rows
    ? `${rows}<div class="form-actions-inline branding-assignment-actions"><span class="settings-note">Alle Änderungen werden gemeinsam gespeichert.</span><button class="primary-button" type="button" data-save-branding-assignments>Alle Zuordnungen speichern</button></div>`
    : '<p class="settings-note">Keine Standorte vorhanden.</p>';
  elements.brandingAssignmentList.querySelectorAll("[data-branding-location]").forEach((row) => {
    const assignment = assignments.get(row.dataset.brandingLocation) || {};
    row.querySelector("[data-location-branding-kit]").value = assignment.kitId || assignment.kit_id || "";
  });
}

async function loadBrandingAssignments() {
  if (!elements.brandingAssignmentList) return;
  try {
    const result = await api("/api/branding/assignments");
    state.brandingAssignments = result.assignments || [];
    if (result.kits) state.brandingKits = result.kits;
    renderBrandingKits();
    renderBrandingAssignments();
  } catch (error) {
    elements.brandingAssignmentList.innerHTML = `<p class="settings-note">${escapeHtml(error.status === 403 ? "Nur Admin oder Personalleitung darf Standort-Brandings verwalten." : error.message)}</p>`;
  }
}

async function saveBrandingAssignments() {
  const assignments = [...elements.brandingAssignmentList.querySelectorAll("[data-branding-location]")]
    .filter((row) => row.querySelector("[data-location-branding-kit]").value !== (row.dataset.initialBrandingKit || ""))
    .map((row) => ({
      locationId: row.dataset.brandingLocation,
      kitId: row.querySelector("[data-location-branding-kit]").value,
    }));
  if (!assignments.length) {
    showToast("Es wurden keine Standort-Brandings geändert.");
    return;
  }
  try {
    const result = await api("/api/branding/assignments", {
      method: "PUT",
      body: JSON.stringify({ assignments }),
    });
    state.brandingAssignments = result.assignments || state.brandingAssignments;
    if (result.kits) state.brandingKits = result.kits;
    renderBrandingAssignments();
    await loadAll();
    showToast("Alle Standort-Brandings wurden gespeichert.");
  } catch (error) { showToast(error.message, true); }
}

function hasIntegrationPermission(permission) {
  return state.portalStatus?.portalEnabled !== true || state.portalSession?.user?.permissions?.includes(permission);
}

function currentMonthRange() {
  const now = new Date();
  return {
    from: toIsoDate(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: toIsoDate(now),
  };
}

function integrationProfiles(direction, kind) {
  return (state.integrations.profiles || []).filter((profile) => profile.direction === direction && profile.kind === kind && profile.active !== false);
}

function renderIntegrationProfileLists() {
  const canWrite = hasIntegrationPermission("integrations:profiles:write");
  const render = (profiles, target, emptyText) => {
    if (!target) return;
    target.innerHTML = profiles.length ? profiles.map((profile) => `
      <div class="integration-profile-row" data-integration-profile="${escapeHtml(profile.id)}">
        <div><strong>${escapeHtml(profile.name)}</strong><small>${profile.format.toUpperCase()} · ${profile.configuration?.layout === "movement_lines" ? "Lohnarten" : profile.direction === "export" ? "Tagesjournal" : "Feldzuordnung"}</small></div>
        ${canWrite ? `<button class="icon-button" type="button" data-delete-integration-profile="${escapeHtml(profile.id)}" aria-label="Profil l\u00f6schen">\u00d7</button>` : ""}
      </div>
    `).join("") : `<p class="settings-note">${escapeHtml(emptyText)}</p>`;
  };
  const importProfiles = integrationProfiles("import", "personnel");
  const exportProfiles = integrationProfiles("export", "payroll");
  render(importProfiles, elements.importProfileList, "Noch kein Importprofil gespeichert.");
  render(exportProfiles, elements.exportProfileList, "Noch kein Exportprofil gespeichert.");
  if (elements.personnelImportProfile) {
    const selected = elements.personnelImportProfile.value;
    elements.personnelImportProfile.innerHTML = `<option value="">Ohne Profil / automatisch erkennen</option>${importProfiles.map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join("")}`;
    if (importProfiles.some((profile) => profile.id === selected)) elements.personnelImportProfile.value = selected;
  }
  if (elements.payrollProfile) {
    const selected = elements.payrollProfile.value;
    elements.payrollProfile.innerHTML = `<option value="">Ohne gespeichertes Profil</option>${exportProfiles.map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join("")}`;
    if (exportProfiles.some((profile) => profile.id === selected)) elements.payrollProfile.value = selected;
  }
}

function renderIntegrationHistory() {
  if (!elements.integrationHistory) return;
  const runs = state.integrations.runs || [];
  elements.integrationHistory.innerHTML = runs.length ? runs.map((run) => {
    const label = run.direction === "import" ? "Personalimport" : "Lohnexport";
    const details = run.direction === "import"
      ? `${run.createdCount} neu · ${run.updatedCount} aktualisiert · ${run.skippedCount} \u00fcbersprungen`
      : `${run.totalCount} Zeilen · ${run.status === "draft" ? "Entwurf" : "final"}`;
    return `<div class="integration-history-row"><span class="status-badge ${run.errorCount ? "warning" : ""}">${escapeHtml(label)}</span><div><strong>${escapeHtml(details)}</strong><small>${escapeHtml(run.actorEmployeeNumber || "lokal")} · ${new Date(run.completedAt || run.startedAt).toLocaleString("de-AT")}</small></div><span>${escapeHtml(run.format.toUpperCase())}</span></div>`;
  }).join("") : `<p class="settings-note">Noch kein Import oder Export protokolliert.</p>`;
}

function renderPayrollContextOptions() {
  if (!elements.payrollLocation) return;
  const locations = state.locations.filter((location) => location.active !== false);
  const selected = elements.payrollLocation.value || state.locationId || locations[0]?.id || "";
  elements.payrollLocation.innerHTML = locations.map((location) => `<option value="${escapeHtml(location.id)}">${escapeHtml(location.id)} · ${escapeHtml(location.name)}</option>`).join("");
  if (locations.some((location) => location.id === selected)) elements.payrollLocation.value = selected;
  renderPayrollDepartments();
}

function renderPayrollDepartments() {
  if (!elements.payrollDepartment) return;
  const location = state.locations.find((item) => item.id === elements.payrollLocation.value);
  const selected = elements.payrollDepartment.value;
  elements.payrollDepartment.innerHTML = `<option value="">Gesamter Standort</option>${(location?.departments || []).filter((department) => department.active !== false).map((department) => `<option value="${department.id}">${escapeHtml(department.name)}</option>`).join("")}`;
  if ((location?.departments || []).some((department) => String(department.id) === selected)) elements.payrollDepartment.value = selected;
}

function selectedPayrollLayoutDefinition() {
  return (state.integrations.payrollCatalog?.layouts || []).find((layout) => layout.id === elements.payrollLayout?.value)
    || state.integrations.payrollCatalog?.layouts?.[0] || null;
}

function renderPayrollColumns(selectedColumns = null) {
  const layout = selectedPayrollLayoutDefinition();
  if (!layout || !elements.payrollColumnSelection) return;
  const current = selectedColumns || [...elements.payrollColumnSelection.querySelectorAll("input:checked")].map((input) => input.value);
  const checked = new Set(current.length ? current : layout.defaultColumns);
  elements.payrollColumnSelection.innerHTML = layout.columns.map((column) => `
    <label><input type="checkbox" value="${escapeHtml(column.id)}" ${checked.has(column.id) ? "checked" : ""} /><span>${escapeHtml(column.label)}</span></label>
  `).join("");
  if (elements.payrollWageCodeDetails) elements.payrollWageCodeDetails.classList.toggle("hidden", layout.id !== "movement_lines");
  renderPayrollWageCodes();
}

const payrollCodeLabels = {
  regular_work: "Regul\u00e4re Arbeitszeit", saturday_bonus: "Samstagszuschlag", vacation: "Urlaub", sickness: "Krankenstand",
  time_off: "Zeitausgleich", branch_assignment: "Andere Filiale", vocational_school: "Berufsschule", training: "Schulung",
  special_leave: "Sonderurlaub", external_appointment: "Au\u00dfer-Haus-Termin", team_meeting: "Teamsitzung", public_holiday: "Feiertag", other: "Sonstiges",
};

function renderPayrollWageCodes(values = null) {
  if (!elements.payrollWageCodeMap) return;
  const current = values || Object.fromEntries([...elements.payrollWageCodeMap.querySelectorAll("input[data-payroll-code]")].map((input) => [input.dataset.payrollCode, input.value]));
  const codes = state.integrations.payrollCatalog?.internalCodes || [];
  elements.payrollWageCodeMap.innerHTML = codes.map((code) => `<label class="field"><span>${escapeHtml(payrollCodeLabels[code] || code)}</span><input data-payroll-code="${escapeHtml(code)}" maxlength="40" value="${escapeHtml(current[code] || "")}" placeholder="${escapeHtml(code)}" /></label>`).join("");
}

function currentPayrollConfiguration() {
  const wageCodeMap = Object.fromEntries([...elements.payrollWageCodeMap.querySelectorAll("input[data-payroll-code]")]
    .map((input) => [input.dataset.payrollCode, input.value.trim()]).filter(([, value]) => value));
  return {
    layout: elements.payrollLayout.value,
    sourceMode: elements.payrollSourceMode.value,
    format: elements.payrollFormat.value,
    delimiter: elements.payrollDelimiter.value,
    decimalSeparator: elements.payrollDecimalSeparator.value,
    columns: [...elements.payrollColumnSelection.querySelectorAll("input:checked")].map((input) => input.value),
    wageCodeMap,
  };
}

function applyPayrollConfiguration(configuration = {}) {
  if (configuration.layout) elements.payrollLayout.value = configuration.layout;
  if (configuration.sourceMode) elements.payrollSourceMode.value = configuration.sourceMode;
  if (configuration.format) elements.payrollFormat.value = configuration.format;
  if (configuration.delimiter) elements.payrollDelimiter.value = configuration.delimiter;
  if (configuration.decimalSeparator) elements.payrollDecimalSeparator.value = configuration.decimalSeparator;
  renderPayrollColumns(configuration.columns || null);
  renderPayrollWageCodes(configuration.wageCodeMap || {});
  elements.payrollDelimiter.closest("label")?.classList.toggle("hidden", elements.payrollFormat.value !== "csv");
  elements.payrollDecimalSeparator.closest("label")?.classList.toggle("hidden", elements.payrollFormat.value !== "csv");
  state.integrations.payrollPreflight = null;
  elements.payrollDownloadButton.disabled = true;
}

function renderPayrollPreflight(result = null) {
  if (!elements.payrollPreflightResult) return;
  if (!result) {
    elements.payrollPreflightResult.innerHTML = `<p class="settings-note">Vor dem Download werden Datenqualit\u00e4t und Freigabestatus gepr\u00fcft.</p>`;
    elements.payrollDownloadButton.disabled = true;
    return;
  }
  const blockerLabels = {
    MISSING_REVIEW: "Tagespr\u00fcfung fehlt",
    STALE_REVIEW: "Tagespr\u00fcfung ist veraltet",
    PENDING_CORRECTION: "Korrektur ist noch offen",
    TIME_EVALUATION_ERROR: "Zeitbuchungen m\u00fcssen gepr\u00fcft werden",
    WORK_ABSENCE_OVERLAP: "Arbeitszeit und Abwesenheit \u00fcberschneiden sich",
    CROSS_LOCATION_REVIEW_UNAVAILABLE: "Standortübergreifende Ist-Zeit ist nur als Entwurf verfügbar",
    MIXED_DEPARTMENTS: "Mehrere Abteilungen müssen getrennt exportiert werden",
    INACTIVE_EMPLOYMENT_HISTORY_REQUIRED: "Beschäftigungszeitraum eines inaktiven Teammitglieds muss geprüft werden",
  };
  const blockerCodes = [...new Set((result.blockers || []).map((item) => item.code))];
  const blockerDetails = (result.blockers || []).slice(0, 100).map((item) => `<li><strong>${escapeHtml(item.employeeNumber || "\u2013")}</strong> \u00b7 ${escapeHtml(item.workDate ? formatDate(item.workDate) : "ohne Datum")} \u00b7 ${escapeHtml(blockerLabels[item.code] || item.code)}</li>`).join("");
  const blockerText = result.blockers?.length
    ? `<div class="integration-alert error"><strong>${result.blockers.length} offene Pr\u00fcfpunkte</strong><span>${blockerCodes.map((code) => escapeHtml(blockerLabels[code] || code)).join(", ")}</span></div><details><summary>Betroffene Teammitglieder und Tage anzeigen</summary><ul>${blockerDetails}</ul>${result.blockers.length > 100 ? `<p class="settings-note">Weitere ${result.blockers.length - 100} Pr\u00fcfpunkte sind vorhanden.</p>` : ""}</details>`
    : result.rowCount
      ? `<div class="integration-alert ok"><strong>Pr\u00fcfung bestanden</strong><span>Der finale Export kann erstellt werden.</span></div>`
      : `<div class="integration-alert"><strong>Keine Exportdaten</strong><span>F\u00fcr den gew\u00e4hlten Zeitraum wurden keine exportierbaren Bewegungen gefunden.</span></div>`;
  const warnings = (result.warnings || []).map((warning) => `<li>${escapeHtml(warning.message || warning.code)}</li>`).join("");
  const sampleColumns = (result.columns || []).slice(0, 8);
  const sample = (result.sampleRows || []).slice(0, 10);
  elements.payrollPreflightResult.innerHTML = `
    <div class="integration-metrics"><span><strong>${result.employeeCount}</strong> Teammitglieder</span><span><strong>${result.dayCount}</strong> Tageswerte</span><span><strong>${result.rowCount}</strong> Exportzeilen</span></div>
    ${blockerText}
    ${warnings ? `<details><summary>${result.warnings.length} Hinweis(e)</summary><ul>${warnings}</ul></details>` : ""}
    ${sample.length ? `<div class="integration-table-wrap"><table class="integration-table"><thead><tr>${sampleColumns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead><tbody>${sample.map((row) => `<tr>${sampleColumns.map((column) => `<td>${escapeHtml(row[column.id] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : `<p class="settings-note">Im gew\u00e4hlten Zeitraum wurden keine exportierbaren Bewegungen gefunden.</p>`}
  `;
  elements.payrollDownloadButton.disabled = !result.rowCount || (result.blockers?.length > 0 && !elements.payrollAllowDraft.checked);
}

async function loadIntegrations() {
  const requests = [];
  const keys = [];
  if (hasIntegrationPermission("employees:import")) { keys.push("importCatalog"); requests.push(api("/api/integrations/personnel-import/catalog")); }
  if (hasIntegrationPermission("payroll:export")) { keys.push("payrollCatalog"); requests.push(api("/api/integrations/payroll-export/catalog")); }
  if (hasIntegrationPermission("integrations:read")) {
    keys.push("profiles", "runs");
    requests.push(api("/api/integrations/profiles").then((result) => result.profiles || []), api("/api/integrations/runs?limit=30").then((result) => result.runs || []));
  }
  const values = await Promise.all(requests);
  keys.forEach((key, index) => { state.integrations[key] = values[index]; });
  const range = currentMonthRange();
  if (!elements.payrollDateFrom.value) elements.payrollDateFrom.value = range.from;
  if (!elements.payrollDateTo.value) elements.payrollDateTo.value = range.to;
  renderIntegrationProfileLists();
  renderIntegrationHistory();
  renderPayrollContextOptions();
  renderPayrollColumns();
  renderPayrollPreflight(state.integrations.payrollPreflight);
  populatePersonnelImportDefaults();
}

function populatePersonnelImportDefaults() {
  const catalog = state.integrations.importCatalog;
  if (!catalog) return;
  const locationValue = elements.personnelImportDefaultLocation.value || state.locationId;
  elements.personnelImportDefaultLocation.innerHTML = (catalog.references?.locations || []).filter((location) => location.active !== false).map((location) => `<option value="${escapeHtml(location.id)}">${escapeHtml(location.id)} · ${escapeHtml(location.name)}</option>`).join("");
  if ([...elements.personnelImportDefaultLocation.options].some((option) => option.value === locationValue)) elements.personnelImportDefaultLocation.value = locationValue;
  const positionValue = elements.personnelImportDefaultPosition.value || "verkaufsmitarbeiter";
  elements.personnelImportDefaultPosition.innerHTML = (catalog.references?.positions || []).map((position) => `<option value="${escapeHtml(position.id)}">${escapeHtml(position.name)}</option>`).join("");
  if ([...elements.personnelImportDefaultPosition.options].some((option) => option.value === positionValue)) elements.personnelImportDefaultPosition.value = positionValue;
}

function setPersonnelImportStep(step) {
  elements.personnelImportFileStep.classList.toggle("hidden", step !== "file");
  elements.personnelImportMappingStep.classList.toggle("hidden", step !== "mapping");
  elements.personnelImportPreviewStep.classList.toggle("hidden", step !== "preview");
  const order = { file: 0, mapping: 1, preview: 2 };
  [...elements.personnelImportProgress.children].forEach((item, index) => item.classList.toggle("active", index <= order[step]));
  elements.backPersonnelImportButton?.classList.toggle("hidden", step !== "preview");
}

function setPersonnelImportMessage(message = "", error = false) {
  elements.personnelImportMessage.textContent = message;
  elements.personnelImportMessage.classList.toggle("hidden", !message);
  elements.personnelImportMessage.classList.toggle("error", error);
}

async function discardPersonnelImportSessions() {
  const ids = [...new Set([
    state.integrations.preview?.previewId,
    state.integrations.inspection?.inspectionId,
  ].filter(Boolean))];
  await Promise.allSettled(ids.map((id) => rawApi(`/api/integrations/personnel-import/sessions/${encodeURIComponent(id)}`, { method: "DELETE" })));
}

function clearPersonnelImportWizard() {
  state.integrations.inspection = null;
  state.integrations.preview = null;
  elements.personnelImportFile.value = "";
  elements.personnelImportMapping.innerHTML = "";
  elements.personnelImportSummary.innerHTML = "";
  elements.personnelImportPreviewBody.innerHTML = "";
  elements.personnelImportPreviewHint.textContent = "";
  elements.applyPersonnelImportButton.disabled = true;
  setPersonnelImportMessage();
  setPersonnelImportStep("file");
}

function resetPersonnelImportWizard() {
  void discardPersonnelImportSessions();
  clearPersonnelImportWizard();
}

async function openPersonnelImportWizard() {
  if (!state.integrations.importCatalog) await loadIntegrations();
  resetPersonnelImportWizard();
  populatePersonnelImportDefaults();
  renderIntegrationProfileLists();
  elements.personnelImportModal.showModal();
}

function selectedImportSheet() {
  return state.integrations.inspection?.sheets?.find((sheet) => sheet.name === elements.personnelImportSheet.value)
    || state.integrations.inspection?.sheets?.[0] || null;
}

function selectedImportProfile() {
  return integrationProfiles("import", "personnel").find((profile) => profile.id === elements.personnelImportProfile.value) || null;
}

function importHeadersForSelection() {
  const sheet = selectedImportSheet();
  if (!sheet) return [];
  const headerRow = Math.max(1, Math.min(20, Number(elements.personnelImportHeaderRow.value || sheet.suggestedHeaderRow || 1)));
  const values = sheet.topRows?.[headerRow - 1] || sheet.headers?.map((header) => header.label) || [];
  return values.map((label, columnIndex) => ({ columnIndex, label: label || `Spalte ${columnIndex + 1}` }));
}

function selectedImportHeaderCandidate() {
  const sheet = selectedImportSheet();
  if (!sheet) return null;
  const rowNumber = Math.max(1, Math.min(20, Number(elements.personnelImportHeaderRow.value || sheet.suggestedHeaderRow || 1)));
  return sheet.headerCandidates?.find((candidate) => Number(candidate.rowNumber) === rowNumber)
    || (rowNumber === Number(sheet.suggestedHeaderRow) ? {
      rowNumber,
      headerFingerprint: sheet.headerFingerprint,
      suggestedMapping: sheet.suggestedMapping,
    } : null);
}

function renderPersonnelImportMapping() {
  const sheet = selectedImportSheet();
  const catalog = state.integrations.importCatalog;
  if (!sheet || !catalog) return;
  const headers = importHeadersForSelection();
  const headerCandidate = selectedImportHeaderCandidate();
  const profile = selectedImportProfile();
  const profileMatches = profile?.configuration?.format === state.integrations.inspection.format
    && (!profile.configuration.headerFingerprint || profile.configuration.headerFingerprint === headerCandidate?.headerFingerprint);
  const mapping = profileMatches ? profile.configuration.mapping || {} : headerCandidate?.suggestedMapping || {};
  elements.personnelImportMapping.innerHTML = catalog.fields.map((field) => `
    <label class="field"><span>${escapeHtml(field.label)}${field.required ? " *" : ""}</span><select data-import-field="${escapeHtml(field.id)}"><option value="">Nicht importieren</option>${headers.map((header) => `<option value="${header.columnIndex}" ${Number(mapping[field.id]?.columnIndex) === header.columnIndex ? "selected" : ""}>${escapeHtml(header.label)} · Spalte ${header.columnIndex + 1}</option>`).join("")}</select></label>
  `).join("");
  if (profile && !profileMatches) setPersonnelImportMessage("Das Profil passt nicht exakt zu dieser Kopfzeile. Die Spalten wurden neu vorgeschlagen.", false);
  else setPersonnelImportMessage();
}

async function inspectPersonnelImport() {
  const file = elements.personnelImportFile.files?.[0];
  if (!file) { setPersonnelImportMessage("Bitte zuerst eine CSV- oder XLSX-Datei ausw\u00e4hlen.", true); return; }
  elements.inspectPersonnelImportButton.disabled = true;
  setPersonnelImportMessage("Datei wird sicher gepr\u00fcft …");
  try {
    const profileConfiguration = selectedImportProfile()?.configuration || {};
    const parameters = new URLSearchParams({
      encoding: profileConfiguration.encoding || "auto",
      delimiter: profileConfiguration.delimiter || "auto",
    });
    const lowerName = file.name.toLowerCase();
    const contentType = lowerName.endsWith(".xlsx")
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : lowerName.endsWith(".tsv") ? "text/tab-separated-values" : "text/csv";
    const response = await rawApi(`/api/integrations/personnel-import/inspect?${parameters}`, {
      method: "POST",
      headers: { "Content-Type": contentType, "X-Import-Filename": encodeURIComponent(file.name) },
      body: file,
    });
    state.integrations.inspection = await response.json();
    elements.personnelImportSheet.innerHTML = state.integrations.inspection.sheets.map((sheet) => `<option value="${escapeHtml(sheet.name)}">${escapeHtml(sheet.name)} · ${sheet.rowCount} Zeilen</option>`).join("");
    if (profileConfiguration.sheetName && [...elements.personnelImportSheet.options].some((option) => option.value === profileConfiguration.sheetName)) {
      elements.personnelImportSheet.value = profileConfiguration.sheetName;
    }
    const sheet = selectedImportSheet();
    const profileHeaderRow = Number(profileConfiguration.headerRow || 0);
    elements.personnelImportHeaderRow.value = profileHeaderRow >= 1 && profileHeaderRow <= 20
      ? profileHeaderRow
      : sheet?.suggestedHeaderRow || 1;
    renderPersonnelImportMapping();
    setPersonnelImportStep("mapping");
    setPersonnelImportMessage(`${state.integrations.inspection.format.toUpperCase()} erkannt · Quelldatei bleibt nur f\u00fcr diese befristete Vorschau im Arbeitsspeicher.`);
  } catch (error) {
    setPersonnelImportMessage(error.message, true);
  } finally {
    elements.inspectPersonnelImportButton.disabled = false;
  }
}

function currentPersonnelImportMapping() {
  return Object.fromEntries([...elements.personnelImportMapping.querySelectorAll("select[data-import-field]")]
    .filter((select) => select.value !== "").map((select) => [select.dataset.importField, { columnIndex: Number(select.value) }]));
}

function currentPersonnelImportConfiguration() {
  const sheet = selectedImportSheet();
  return {
    version: 1,
    format: state.integrations.inspection?.format || "csv",
    sheetName: sheet?.name || "",
    headerRow: Number(elements.personnelImportHeaderRow.value || 1),
    encoding: state.integrations.inspection?.encoding || "auto",
    delimiter: state.integrations.inspection?.delimiter || "auto",
    mapping: currentPersonnelImportMapping(),
    defaults: {
      contractedHours: Number(elements.personnelImportDefaultHours.value || 38.5),
      positionId: elements.personnelImportDefaultPosition.value,
      homeLocationId: elements.personnelImportDefaultLocation.value,
      active: true,
    },
    headerFingerprint: selectedImportHeaderCandidate()?.headerFingerprint || "",
    duplicateStrategy: elements.personnelImportDuplicateStrategy.value,
  };
}

function actionLabel(action) {
  return { create: "Neu", update: "Aktualisierung", skip: "\u00dcbersprungen", error: "Fehler" }[action] || action;
}

function renderPersonnelImportPreview(result) {
  elements.personnelImportSummary.innerHTML = `<span><strong>${result.summary.create}</strong> neu</span><span><strong>${result.summary.update}</strong> aktualisiert</span><span><strong>${result.summary.skip}</strong> \u00fcbersprungen</span><span class="${result.summary.errors ? "error" : ""}"><strong>${result.summary.errors}</strong> Fehler</span>`;
  elements.personnelImportPreviewBody.innerHTML = result.rows.map((row) => {
    const messages = [...row.errors, ...row.warnings].map((item) => item.message).join(" · ");
    return `<tr class="integration-row-${escapeHtml(row.action)}"><td>${row.rowNumber}</td><td><span class="status-badge ${row.action === "error" ? "warning" : row.action === "skip" ? "inactive" : ""}">${escapeHtml(actionLabel(row.action))}</span></td><td>${escapeHtml(row.display.personnelNumber)}</td><td>${escapeHtml(row.display.fullName)}</td><td>${escapeHtml(row.display.nickname)}</td><td>${escapeHtml(row.display.contractedHours ?? "")}</td><td>${escapeHtml([row.display.location, row.display.department, row.display.position].filter(Boolean).join(" · "))}</td><td>${escapeHtml(messages || "OK")}</td></tr>`;
  }).join("");
  elements.personnelImportPreviewHint.textContent = result.truncated
    ? `Die Tabelle zeigt bis zu 200 Zeilen; Fehler werden zuerst angezeigt. Die Zusammenfassung umfasst die gesamte Datei.${result.hiddenErrorCount ? ` Weitere ${result.hiddenErrorCount} Fehlerzeilen sind in der Quelldatei zu korrigieren.` : ""}`
    : "Alle Importzeilen werden angezeigt.";
  elements.applyPersonnelImportButton.disabled = result.summary.errors > 0 || result.summary.total === 0;
  setPersonnelImportStep("preview");
}

async function previewPersonnelImport() {
  if (!state.integrations.inspection) return;
  const configuration = currentPersonnelImportConfiguration();
  elements.previewPersonnelImportButton.disabled = true;
  setPersonnelImportMessage("Importvorschau wird erstellt …");
  try {
    if (state.integrations.preview?.previewId) {
      await rawApi(`/api/integrations/personnel-import/sessions/${encodeURIComponent(state.integrations.preview.previewId)}`, { method: "DELETE" });
      state.integrations.preview = null;
    }
    const result = await api("/api/integrations/personnel-import/preview", {
      method: "POST",
      body: JSON.stringify({
        inspectionId: state.integrations.inspection.inspectionId,
        sheetName: configuration.sheetName,
        headerRow: configuration.headerRow,
        mapping: configuration.mapping,
        defaults: configuration.defaults,
        duplicateStrategy: configuration.duplicateStrategy,
        profileId: elements.personnelImportProfile.value || null,
        headerFingerprint: configuration.headerFingerprint,
      }),
    });
    state.integrations.preview = result;
    renderPersonnelImportPreview(result);
    setPersonnelImportMessage(result.summary.errors ? "Bitte die markierten Fehler in der Quelldatei oder Zuordnung korrigieren." : "Vorschau gepr\u00fcft. Erst der n\u00e4chste Klick \u00fcbernimmt Stammdaten.", result.summary.errors > 0);
  } catch (error) {
    setPersonnelImportMessage(error.message, true);
  } finally {
    elements.previewPersonnelImportButton.disabled = false;
  }
}

async function returnPersonnelImportToMapping() {
  if (state.integrations.preview?.previewId) {
    await rawApi(`/api/integrations/personnel-import/sessions/${encodeURIComponent(state.integrations.preview.previewId)}`, { method: "DELETE" }).catch(() => null);
  }
  state.integrations.preview = null;
  elements.applyPersonnelImportButton.disabled = true;
  setPersonnelImportStep("mapping");
  setPersonnelImportMessage("Zuordnung oder Standardwerte anpassen und anschließend eine neue Vorschau erstellen.");
}

async function applyPersonnelImport() {
  if (!state.integrations.preview?.previewId) return;
  if (!confirm("Den gepr\u00fcften Personalimport jetzt atomar \u00fcbernehmen?")) return;
  elements.applyPersonnelImportButton.disabled = true;
  try {
    const result = await api("/api/integrations/personnel-import/apply", { method: "POST", body: JSON.stringify({ previewId: state.integrations.preview.previewId }) });
    elements.personnelImportModal.close();
    showToast(`${result.create} Teammitglieder angelegt, ${result.update} aktualisiert, ${result.skip} \u00fcbersprungen.`);
    await loadAll();
    await loadIntegrations();
    setSettingsTab("integrations");
  } catch (error) {
    setPersonnelImportMessage(error.message, true);
    elements.applyPersonnelImportButton.disabled = false;
  }
}

async function saveIntegrationProfile(direction) {
  const isImport = direction === "import";
  const name = (isImport ? elements.personnelImportProfileName : elements.payrollProfileName).value.trim();
  if (!name) { showToast("Bitte einen Profilnamen eingeben.", true); return; }
  const configuration = isImport ? currentPersonnelImportConfiguration() : currentPayrollConfiguration();
  const result = await api("/api/integrations/profiles", {
    method: "POST",
    body: JSON.stringify({ direction, kind: isImport ? "personnel" : "payroll", name, configuration }),
  });
  state.integrations.profiles.push(result.profile);
  (isImport ? elements.personnelImportProfileName : elements.payrollProfileName).value = "";
  renderIntegrationProfileLists();
  if (isImport) elements.personnelImportProfile.value = result.profile.id;
  else elements.payrollProfile.value = result.profile.id;
  showToast("Schnittstellenprofil gespeichert.");
}

async function deleteIntegrationProfile(id) {
  const profile = state.integrations.profiles.find((item) => item.id === id);
  if (!profile || !confirm(`Profil \u201e${profile.name}\u201c wirklich l\u00f6schen?`)) return;
  await api(`/api/integrations/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
  state.integrations.profiles = state.integrations.profiles.filter((item) => item.id !== id);
  renderIntegrationProfileLists();
  showToast("Profil gel\u00f6scht.");
}

async function preflightPayrollExport() {
  elements.payrollPreflightButton.disabled = true;
  elements.payrollDownloadButton.disabled = true;
  elements.payrollPreflightResult.innerHTML = `<p class="settings-note">Exportdaten werden gepr\u00fcft …</p>`;
  try {
    const result = await api("/api/integrations/payroll-export/preflight", {
      method: "POST",
      body: JSON.stringify({
        dateFrom: elements.payrollDateFrom.value,
        dateTo: elements.payrollDateTo.value,
        locationId: elements.payrollLocation.value,
        departmentId: elements.payrollDepartment.value || null,
        profileId: elements.payrollProfile.value || null,
        configuration: currentPayrollConfiguration(),
      }),
    });
    state.integrations.payrollPreflight = result;
    renderPayrollPreflight(result);
  } catch (error) {
    state.integrations.payrollPreflight = null;
    elements.payrollPreflightResult.innerHTML = `<div class="integration-alert error"><strong>Pr\u00fcfung nicht m\u00f6glich</strong><span>${escapeHtml(error.message)}</span></div>`;
  } finally {
    elements.payrollPreflightButton.disabled = false;
  }
}

function downloadFileResponse(response, fallbackName) {
  return response.blob().then((blob) => {
    const disposition = response.headers.get("Content-Disposition") || "";
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const simple = disposition.match(/filename="?([^";]+)"?/i)?.[1];
    let fileName = fallbackName;
    try { fileName = encoded ? decodeURIComponent(encoded) : simple || fallbackName; } catch {}
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

async function downloadPayrollExport() {
  const preflight = state.integrations.payrollPreflight;
  if (!preflight) return;
  elements.payrollDownloadButton.disabled = true;
  try {
    const response = await rawApi("/api/integrations/payroll-export/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dateFrom: elements.payrollDateFrom.value,
        dateTo: elements.payrollDateTo.value,
        locationId: elements.payrollLocation.value,
        departmentId: elements.payrollDepartment.value || null,
        profileId: elements.payrollProfile.value || null,
        configuration: currentPayrollConfiguration(),
        fingerprint: preflight.fingerprint,
        allowDraft: elements.payrollAllowDraft.checked,
      }),
    });
    await downloadFileResponse(response, `grabenplaner-lohnexport.${elements.payrollFormat.value}`);
    showToast("Lohnverrechnungsdatei erstellt.");
    await loadIntegrations();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    renderPayrollPreflight(state.integrations.payrollPreflight);
  }
}

function setView(view) {
  const features = state.portalStatus?.installationFeatures || {};
  if ((view === "vacations" && features.vacation === false)
    || (view === "requests" && features.requests === false)
    || (view === "timeTracking" && features.timeTracking === false)) view = "planning";
  state.currentView = view;
  if (timePresenceRefreshTimer) clearInterval(timePresenceRefreshTimer);
  timePresenceRefreshTimer = null;
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  elements.planningView.classList.toggle("active", view === "planning");
  elements.requestsView.classList.toggle("active", view === "requests");
  elements.timeTrackingView?.classList.toggle("active", view === "timeTracking");
  elements.vacationsView.classList.toggle("active", view === "vacations");
  elements.personnelView.classList.toggle("active", view === "personnel");
  elements.settingsView.classList.toggle("active", view === "settings");
  if (view === "settings") {
    const activeSettingsTab = document.querySelector("[data-settings-tab].active:not(.hidden)");
    const firstAllowedSettingsTab = document.querySelector("[data-settings-tab]:not(.hidden)");
    if (!activeSettingsTab && firstAllowedSettingsTab) setSettingsTab(firstAllowedSettingsTab.dataset.settingsTab);
  }
  if (view === "requests") loadManagerVacationRequests();
  if (view === "timeTracking") {
    initializeTimeSummaryDates();
    initializeTimeReviewDate();
    Promise.all([loadTimePresence(), loadTimeDayReview(), loadTimeSummary(), loadTimeCorrections()]);
    timePresenceRefreshTimer = setInterval(() => { if (!document.hidden && state.currentView === "timeTracking") loadTimePresence(); }, 30000);
  }
}

function applyRequestedView() {
  const parameters = new URLSearchParams(window.location.search);
  const requestedView = parameters.get("view");
  if (!["planning", "requests", "timeTracking", "vacations", "personnel", "settings"].includes(requestedView)) return;
  if (requestedView === "requests") {
    const requestedKind = parameters.get("kind");
    if (["vacation", "time_off", "amu"].includes(requestedKind)) state.requestKindTab = requestedKind;
    document.querySelectorAll("[data-request-kind-tab]").forEach((button) => button.classList.toggle("active", button.dataset.requestKindTab === state.requestKindTab));
  }
  setView(requestedView);
}

function setSettingsTab(tab) {
  document.querySelectorAll("[data-settings-tab]").forEach((button) => button.classList.toggle("active", button.dataset.settingsTab === tab));
  document.querySelector(`[data-settings-tab="${tab}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  elements.generalSettings.classList.toggle("active", tab === "general");
  elements.brandingSettings.classList.toggle("active", tab === "branding");
  elements.pdfSettings.classList.toggle("active", tab === "pdf");
  elements.personnelSettings.classList.toggle("active", tab === "personnel");
  elements.integrationSettings?.classList.toggle("active", tab === "integrations");
  elements.wifiAutomationSettings?.classList.toggle("active", tab === "wifiAutomation");
  elements.accessSettings.classList.toggle("active", tab === "access");
  elements.rightsSettings?.classList.toggle("active", tab === "rights");
  elements.backupSettings.classList.toggle("active", tab === "backup");
  elements.usbProvisioningSettings?.classList.toggle("active", tab === "usbProvisioning");
  const canSaveGeneralSettings = !state.portalStatus?.portalEnabled
    || state.portalSession?.user?.permissions?.includes("settings:write");
  elements.saveSettingsButton?.classList.toggle("hidden", ["wifiAutomation", "integrations", "usbProvisioning"].includes(tab) || !canSaveGeneralSettings);
  if (tab === "access") {
    loadPortalUsers();
    loadAmuSettings();
    loadGreetingSettings();
  }
  if (tab === "rights") loadRightsManagement();
  if (tab === "integrations") loadIntegrations().catch((error) => showToast(error.message, true));
  if (tab === "wifiAutomation") loadWifiAutomationSettings();
  if (tab === "branding") Promise.all([loadManagementBrandingPreference(), loadBrandingAssignments()]).then(() => renderSettings()).catch((error) => showToast(error.message, true));
  if (tab === "usbProvisioning") {
    renderUsbAvailability(state.portalStatus?.usbProvisioning || {});
    if (state.portalStatus?.usbProvisioning?.available === true) {
      loadUsbProvisioning().catch((error) => showToast(error.message, true));
    }
  }
}

function setPersonnelTab(tab) {
  state.personnelTab = tab;
  document.querySelectorAll("[data-personnel-tab]").forEach((button) => button.classList.toggle("active", button.dataset.personnelTab === tab));
  elements.employeeSettings.classList.toggle("active", tab === "employees");
  elements.locationSettings.classList.toggle("active", tab === "locations");
}

function updateColorPicker(color) {
  const normalized = /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "#0b84c6";
  state.selectedColor = normalized;
  document.querySelector("#employeeColorPicker").value = normalized;
  document.querySelector("#employeeColorHex").value = normalized;
  document.querySelector("#employeeColorPreview").style.setProperty("--preview-color", normalized);
}

function updateEmployeeDepartmentOptions(selectedDepartmentId = "") {
  const locationId = elements.employeeHomeLocation.value || state.locationId;
  const departments = departmentsForLocation(locationId);
  elements.employeePreferredDepartment.innerHTML = `<option value="">Keine Abteilung</option>${departments.map((department) =>
    `<option value="${department.id}">${escapeHtml(department.name)}</option>`,
  ).join("")}`;
  if (selectedDepartmentId && departments.some((department) => String(department.id) === String(selectedDepartmentId))) {
    elements.employeePreferredDepartment.value = String(selectedDepartmentId);
  } else {
    elements.employeePreferredDepartment.value = "";
  }
}

function canEditEmployeeAccessProfile(employee = null) {
  if (!state.portalStatus?.portalEnabled) return false;
  if (!["developer", "it_admin"].includes(state.portalSession?.user?.role)) return false;
  return employee?.portal_access?.roleLocked !== true && employee?.portal_access?.role !== "developer";
}

function appRoleAssignableInPersonnelModal(roleId) {
  const actorRole = state.portalSession?.user?.role;
  if (roleId === "developer") return false;
  if (actorRole === "developer") return true;
  return actorRole === "it_admin" && ["employee", "department_manager", "manager", "hr"].includes(roleId);
}

function permissionDisplayLabel(permissionId) {
  return state.portalPermissionCatalog.find((permission) => permission.id === permissionId)?.label
    || permissionId.replaceAll(":", " · ");
}

function renderEmployeeAccessProfile(employee = null) {
  if (!elements.employeeAccessProfile) return;
  const access = employee?.portal_access || {
    configured: false,
    role: "employee",
    roleName: "Mitarbeiter",
    roleLocked: false,
    rolePermissions: state.portalRoles.find((role) => role.id === "employee")?.permissions || [],
    grantedPermissions: [],
  };
  const editable = canEditEmployeeAccessProfile(employee);
  const currentRole = elements.employeeAppRole.value || access.role || "employee";
  const options = editable
    ? state.portalRoles.filter((role) => appRoleAssignableInPersonnelModal(role.id))
    : state.portalRoles.filter((role) => role.id === access.role);
  if (!options.some((role) => role.id === currentRole)) {
    const current = state.portalRoles.find((role) => role.id === currentRole || role.id === access.role);
    if (current) options.unshift(current);
  }
  elements.employeeAppRole.innerHTML = options.map((role) => `<option value="${escapeHtml(role.id)}">${escapeHtml(role.name)}</option>`).join("");
  elements.employeeAppRole.value = options.some((role) => role.id === currentRole) ? currentRole : (access.role || "employee");
  elements.employeeAppRole.disabled = !editable;
  const role = state.portalRoles.find((entry) => entry.id === elements.employeeAppRole.value)
    || state.portalRoles.find((entry) => entry.id === access.role);
  const rolePermissions = new Set(role?.permissions || access.rolePermissions || []);
  elements.employeeAppRoleDescription.textContent = role?.description || "Grundrechte werden durch die ausgewählte App-Rolle vorgegeben.";
  const basePermissionLabels = [...rolePermissions].map(permissionDisplayLabel);
  const visibleBase = basePermissionLabels.slice(0, 6);
  elements.employeeRolePermissions.innerHTML = `${visibleBase.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}${basePermissionLabels.length > visibleBase.length ? `<span>+ ${basePermissionLabels.length - visibleBase.length} weitere</span>` : ""}`
    || "<span>Keine Grundrechte</span>";
  const groups = new Map();
  for (const permission of state.portalPermissionCatalog) {
    const group = permission.group || "Weitere Rechte";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(permission);
  }
  let additionalCount = 0;
  elements.employeeAdditionalRights.innerHTML = [...groups.entries()].map(([group, permissions]) => {
    const entries = permissions.map((permission) => {
      const baseRight = rolePermissions.has(permission.id);
      const additionalRight = state.employeeAccessDraft.has(permission.id) && !baseRight;
      if (additionalRight) additionalCount += 1;
      return `<label class="employee-access-right ${baseRight ? "base-right" : ""} ${additionalRight ? "additional-right" : ""}"><input type="checkbox" data-employee-access-permission value="${escapeHtml(permission.id)}" ${baseRight || additionalRight ? "checked" : ""} ${editable && !baseRight ? "" : "disabled"} /><span><strong>${escapeHtml(permission.label || permission.id)}</strong><small>${baseRight ? "Grundrecht der Rolle" : permission.description || "Individuelles Zusatzrecht"}</small></span></label>`;
    }).join("");
    return `<section><h4>${escapeHtml(group)}</h4><div>${entries}</div></section>`;
  }).join("");
  elements.employeeAdditionalRightsCount.textContent = String(additionalCount);
  elements.employeeAccessProfile.classList.toggle("locked", !editable);
  elements.employeeAccessStatus.textContent = access.roleLocked || access.role === "developer" ? "Developer geschützt" : editable ? "Bearbeitbar" : "Nur Ansicht";
  elements.employeeAccessStatus.classList.toggle("inactive", !editable);
  elements.employeeAccessHint.textContent = access.roleLocked || access.role === "developer"
    ? "Der Developer-Zugang ist technisch geschützt und kann nicht über die App verändert werden."
    : editable
      ? `${access.configured ? "Bestehender" : "Neuer"} Portal-Zugang: Rolle und Zusatzrechte werden gemeinsam mit den Personalstammdaten gespeichert. Das Startpasswort wird weiterhin unter „Zugänge“ gesetzt.`
      : "App-Rolle und Rechte sind hier nur sichtbar. Änderungen sind ausschließlich durch Developer oder IT-Admin möglich.";
}

function openEmployeeModal(employee = null) {
  const permissions = state.portalSession?.user?.permissions || [];
  const fullAccess = !state.portalStatus?.portalEnabled || permissions.includes("employees:write");
  const displayAccess = Boolean(employee) && permissions.includes("employees:display:write");
  if (!fullAccess && !displayAccess) return;
  state.employeeEditMode = fullAccess ? "full" : "display";
  elements.employeeForm.reset();
  elements.employeeHomeLocation.innerHTML = (state.locations || []).map((location) =>
    `<option value="${escapeHtml(location.id)}">${escapeHtml(location.id)} · ${escapeHtml(location.name)}</option>`,
  ).join("");
  document.querySelector("#employeeNumber").value = employee?.personnel_number || "";
  document.querySelector("#employeeNumber").disabled = Boolean(employee);
  document.querySelector("#employeeName").value = employee?.full_name || "";
  document.querySelector("#employeeNickname").value = employee?.nickname || "";
  document.querySelector("#employeeHours").value = employee?.contracted_hours ?? 38.5;
  elements.employeePosition.innerHTML = (state.positions || []).map((position) =>
    `<option value="${escapeHtml(position.id)}">${escapeHtml(position.name)}</option>`,
  ).join("");
  elements.employeePosition.value = employee?.position_id || "verkaufsmitarbeiter";
  const canManageConfirmationLevel = canManageWifiAutomationSettings();
  elements.employeeTimeConfirmationLevel.value = employee?.time_confirmation_level || "C";
  elements.employeeTimeConfirmationLevelField?.classList.toggle("hidden", !canManageConfirmationLevel);
  elements.employeeHomeLocation.value = employee?.home_location_id || state.locationId || state.locations?.[0]?.id || "01";
  updateEmployeeDepartmentOptions(employee?.preferred_department_id || "");
  document.querySelector("#employeePreferredDay").value = employee?.preferred_day_off || "";
  const fixedDays = fixedWorkdays(employee);
  document.querySelectorAll('[name="employeeFixedWorkday"]').forEach((checkbox) => {
    checkbox.checked = fixedDays.includes(checkbox.value);
  });
  document.querySelector("#employeeActive").checked = employee?.active ?? true;
  state.employeeAccessDraft = new Set(employee?.portal_access?.grantedPermissions || []);
  elements.employeeAppRole.value = employee?.portal_access?.role || "employee";
  renderEmployeeAccessProfile(employee);
  updateColorPicker(employee?.color || "#0b84c6");
  const displayOnly = state.employeeEditMode === "display";
  const protectedControls = [
    "employeeName", "employeeNickname", "employeeHours", "employeeHomeLocation", "employeePosition",
    "employeeTimeConfirmationLevel", "employeePreferredDepartment", "employeePreferredDay", "employeeActive",
  ];
  for (const id of protectedControls) document.querySelector(`#${id}`).disabled = displayOnly;
  elements.employeeTimeConfirmationLevel.disabled = displayOnly || !canManageConfirmationLevel;
  document.querySelectorAll('[name="employeeFixedWorkday"]').forEach((control) => { control.disabled = displayOnly; });
  document.querySelector("#employeeColorPicker").disabled = false;
  document.querySelector("#employeeColorHex").disabled = false;
  elements.employeeModalTitle.textContent = displayOnly ? `${employee.nickname} · Farbe ändern` : employee ? `${employee.nickname} bearbeiten` : "Teammitglied anlegen";
  elements.employeeEditScopeHint?.classList.toggle("hidden", !displayOnly);
  elements.deleteEmployeeButton.classList.toggle("hidden", !employee || displayOnly);
  elements.employeeModal.showModal();
}

function calculateShiftPreview() {
  if (!state.data) return;
  const startValue = document.querySelector("#shiftStart").value;
  const endValue = document.querySelector("#shiftEnd").value;
  const dateValue = document.querySelector("#shiftDate").value;
  if (!startValue || !endValue || !dateValue) return;
  let start = timeToMinutes(startValue);
  let end = timeToMinutes(endValue);
  if (end <= start) end += 1440;
  const raw = end - start;
  const settings = state.data.settings;
  const rulePause = settings.break_rule_enabled === "1" && raw > Number(settings.break_after_minutes)
    ? Number(settings.break_duration_minutes) : 0;
  const config = dayConfig(dateValue, settings);
  const lunchPause = config?.lunchEnabled
    ? Math.max(0, Math.min(end, timeToMinutes(config.lunchEnd)) - Math.max(start, timeToMinutes(config.lunchStart)))
    : 0;
  const pause = Math.max(rulePause, lunchPause);
  let counted = raw - pause;
  let bonus = 0;
  if (new Date(`${dateValue}T12:00:00`).getDay() === 6 && settings.saturday_bonus_enabled === "1") {
    const bonusFrom = timeToMinutes(settings.saturday_bonus_from);
    const eligible = Math.max(0, end - Math.max(start, bonusFrom));
    bonus = eligible * (Number(settings.saturday_bonus_factor) - 1);
    counted += bonus;
  }
  elements.shiftCalculation.textContent = `Planzeit ${formatHours(raw)} · Pause ${formatHours(pause)}${bonus ? ` · Samstagszuschlag +${formatHours(bonus)}` : ""} · Gewertet ${formatHours(counted)}`;
}

function openShiftModal(employeeNumber, date, shift = null) {
  if (isWeekLocked()) {
    showToast("Diese Kalenderwoche ist schreibgeschützt.", true);
    return;
  }
  const hours = operatingHours(shift?.shift_date || date);
  if (!hours) {
    showToast("An Sonntagen ist kein Dienst vorgesehen.", true);
    return;
  }
  const specialCase = fullDaySpecialCaseFor(shift?.employee_number || employeeNumber, shift?.shift_date || date);
  if (specialCase && !shift) {
    showToast(`An diesem Tag ist bereits „${optionLabels[specialCase.option_type]}“ eingetragen.`, true);
    return;
  }
  const initialEmployee = state.data.employees.find((employee) => employee.personnel_number === (shift?.employee_number || employeeNumber));
  if (initialEmployee && !shift && !employeeCanWorkOnDate(initialEmployee, shift?.shift_date || date)) {
    showToast(`${initialEmployee.nickname} hat an diesem Wochentag keinen fix vereinbarten Arbeitstag.`, true);
    return;
  }
  document.querySelector("#shiftEmployee").innerHTML = state.data.employees.map((employee) =>
    `<option value="${escapeHtml(employee.personnel_number)}">${escapeHtml(employee.nickname)} · ${escapeHtml(employee.personnel_number)}</option>`,
  ).join("");
  const departments = departmentsForLocation(state.locationId);
  elements.shiftDepartment.innerHTML = `<option value="">Keine / Allgemein</option>${departments.map((department) =>
    `<option value="${department.id}">${escapeHtml(department.name)}</option>`,
  ).join("")}`;
  elements.shiftForm.reset();
  document.querySelector("#shiftId").value = shift?.id || "";
  document.querySelector("#shiftEmployee").value = shift?.employee_number || employeeNumber;
  const selectedEmployee = state.data.employees.find((employee) => employee.personnel_number === (shift?.employee_number || employeeNumber));
  elements.shiftDepartment.value = shift?.department_id || state.departmentId || selectedEmployee?.preferred_department_id || "";
  document.querySelector("#shiftDate").value = shift?.shift_date || date;
  document.querySelector("#shiftStart").value = shift?.start_time || hours.start;
  document.querySelector("#shiftEnd").value = shift?.end_time || hours.end;
  document.querySelector("#shiftArea").value = shift?.area || "";
  document.querySelector("#shiftNote").value = shift?.note || "";
  elements.shiftModalTitle.textContent = shift ? "Dienst bearbeiten" : "Dienst eintragen";
  elements.deleteShiftButton.classList.toggle("hidden", !shift);
  calculateShiftPreview();
  elements.shiftModal.showModal();
}

function openOptionsModal() {
  if (isWeekLocked()) {
    showToast("Diese Kalenderwoche ist schreibgeschützt.", true);
    return;
  }
  const employeeOptions = state.data.employees.map((employee) =>
    `<option value="${escapeHtml(employee.personnel_number)}">${escapeHtml(employee.nickname)} · ${escapeHtml(employee.personnel_number)}</option>`,
  ).join("");
  document.querySelector("#optionEmployee").innerHTML = employeeOptions;
  document.querySelector("#optionDateFrom").value = state.weekStart;
  document.querySelector("#optionDateTo").value = state.weekStart;
  document.querySelector("#optionType").value = "vacation";
  document.querySelector("#optionAllDay").checked = true;
  const defaultHours = dayConfig(state.weekStart, state.data.settings);
  document.querySelector("#optionStartTime").value = defaultHours?.start || "09:00";
  document.querySelector("#optionEndTime").value = defaultHours?.end || "18:00";
  document.querySelector("#optionHours").value = "";
  document.querySelector("#optionNote").value = "";
  elements.globalBlockDate.value = state.weekStart;
  elements.globalBlockReason.value = publicHolidayForDate(state.weekStart)?.name || "";
  elements.globalBlockHoliday.checked = Boolean(publicHolidayForDate(state.weekStart));
  resetGlobalBlockEditor();
  updateOptionCreditFields();
  resetOptionEditor();
  updateOptionWeekControls();
  renderOptionList();
  elements.optionsModal.showModal();
  elements.optionsModal.focus();
}

function updateOptionWeekControls() {
  const weekEnd = addDays(state.weekStart, 6);
  elements.optionsWeekLabel.textContent = `KW ${state.data.calendarWeek}`;
  elements.optionsWeekRange.textContent = `${formatDate(state.weekStart)} – ${formatDate(weekEnd)}`;
  ["optionDateFrom", "optionDateTo"].forEach((id) => {
    const input = document.querySelector(`#${id}`);
    input.min = state.weekStart;
    input.max = weekEnd;
    if (!input.value || input.value < state.weekStart || input.value > weekEnd) input.value = state.weekStart;
  });
  elements.globalBlockDate.min = state.weekStart;
  elements.globalBlockDate.max = weekEnd;
  if (!elements.globalBlockDate.value || elements.globalBlockDate.value < state.weekStart || elements.globalBlockDate.value > weekEnd) {
    elements.globalBlockDate.value = state.weekStart;
  }
}

async function switchOptionsWeek(offsetWeeks) {
  resetOptionEditor();
  state.weekStart = addDays(state.weekStart, offsetWeeks * 7);
  await loadAll();
  if (elements.optionsModal.open) {
    const employeeOptions = state.data.employees.map((employee) =>
      `<option value="${escapeHtml(employee.personnel_number)}">${escapeHtml(employee.nickname)} · ${escapeHtml(employee.personnel_number)}</option>`,
    ).join("");
    document.querySelector("#optionEmployee").innerHTML = employeeOptions;
    updateOptionWeekControls();
    resetGlobalBlockEditor();
    elements.globalBlockDate.value = state.weekStart;
    elements.globalBlockReason.value = "";
    elements.globalBlockHoliday.checked = false;
    updateGlobalBlockHolidaySuggestion();
    updateOptionCreditFields();
    renderOptionList();
  }
}

function resetGlobalBlockEditor() {
  state.editingGlobalBlockId = null;
  elements.globalBlockSubmitButton.textContent = "Tag sperren";
}

function updateGlobalBlockHolidaySuggestion() {
  const holiday = publicHolidayForDate(elements.globalBlockDate.value);
  if (holiday && !elements.globalBlockReason.value.trim()) {
    elements.globalBlockReason.value = holiday.name;
    elements.globalBlockHoliday.checked = true;
  }
}

function fillGlobalBlockForm(block) {
  state.editingGlobalBlockId = block.id;
  elements.globalBlockDate.value = block.block_date;
  elements.globalBlockReason.value = block.reason || block.holiday_name || "";
  elements.globalBlockHoliday.checked = Boolean(block.is_public_holiday);
  elements.globalBlockSubmitButton.textContent = "Sperrtag ändern";
}

function resetOptionEditor() {
  state.editingOptionId = null;
  state.editingOptionGroupId = null;
  elements.optionSubmitButton.textContent = "Hinzufügen";
  elements.cancelOptionEditButton.classList.add("hidden");
}

function fillOptionForm(option) {
  state.editingOptionId = option.id;
  state.editingOptionGroupId = option.group_id || null;
  document.querySelector("#optionEmployee").value = option.employee_number;
  document.querySelector("#optionType").value = option.option_type;
  document.querySelector("#optionDateFrom").value = option.date_from;
  document.querySelector("#optionDateTo").value = option.date_to;
  document.querySelector("#optionAllDay").checked = optionIsAllDay(option);
  document.querySelector("#optionStartTime").value = option.start_time || "09:00";
  document.querySelector("#optionEndTime").value = option.end_time || "18:00";
  document.querySelector("#optionHours").value = option.credited_minutes_per_day ? Number(option.credited_minutes_per_day) / 60 : "";
  document.querySelector("#optionNote").value = option.note || "";
  updateOptionCreditFields();
  elements.optionSubmitButton.textContent = "Änderung speichern";
  elements.cancelOptionEditButton.classList.remove("hidden");
  elements.optionForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function updateOptionCreditFields() {
  const type = document.querySelector("#optionType").value;
  const alwaysAllDay = ["vacation", "sick", "branch", "vocational_school", "special_leave"].includes(type);
  const supportsTime = ["school", "time_off", "external_appointment", "team_meeting", "other"].includes(type);
  const manualAllDay = ["school", "external_appointment", "team_meeting", "other"].includes(type);
  const allDayInput = document.querySelector("#optionAllDay");
  if (alwaysAllDay) allDayInput.checked = true;
  const allDay = allDayInput.checked || alwaysAllDay;
  const manual = allDay && manualAllDay;
  const employeeNumber = document.querySelector("#optionEmployee").value;
  const employee = state.data.employees.find((item) => item.personnel_number === employeeNumber);
  const dailyHours = employee ? Number(employee.contracted_hours) / 5 : 0;
  document.querySelector("#optionAllDayField").classList.toggle("hidden", !supportsTime);
  allDayInput.disabled = alwaysAllDay;
  document.querySelector("#optionTimeFields").classList.toggle("hidden", allDay || !supportsTime);
  document.querySelector("#optionHoursField").classList.toggle("hidden", !manual);
  document.querySelector("#optionHours").required = manual;
  const start = document.querySelector("#optionStartTime").value;
  const end = document.querySelector("#optionEndTime").value;
  const timedHours = start && end && end > start ? (timeToMinutes(end) - timeToMinutes(start)) / 60 : 0;
  document.querySelector("#optionCreditHint").textContent = manual
    ? "Ganztägig: Die eingetragenen Stunden werden für jeden ausgewählten Tag angerechnet."
    : type === "time_off"
      ? allDay
        ? "Ganztägiger Zeitausgleich wird mit 0 Stunden angerechnet und sperrt den ganzen Tag."
        : "Zeitlicher Zeitausgleich wird mit 0 Stunden angerechnet und sperrt nur den eingetragenen Zeitraum."
      : supportsTime && !allDay
        ? `Zeitlicher Eintrag: ${new Intl.NumberFormat("de-AT", { maximumFractionDigits: 2 }).format(timedHours)} Stunden werden angerechnet.`
        : `Ganzer Tag: Wochen-Soll ÷ 5 = ${new Intl.NumberFormat("de-AT", { maximumFractionDigits: 2 }).format(dailyHours)} Stunden pro Tag.`;
}

function handleOptionTypeChange() {
  const type = document.querySelector("#optionType").value;
  document.querySelector("#optionAllDay").checked = ["vacation", "sick", "branch", "vocational_school", "special_leave"].includes(type);
  updateOptionCreditFields();
}

function openAutoPlanModal() {
  if (isWeekLocked()) {
    showToast("Diese Kalenderwoche ist schreibgeschützt.", true);
    return;
  }
  elements.autoPlanWeek.textContent = `${formatDate(state.weekStart)} bis ${formatDate(addDays(state.weekStart, state.data.settings.show_sunday === "1" ? 6 : 5))} · KW ${state.data.calendarWeek}`;
  document.querySelector('input[name="autoMode"][value="fill"]').checked = true;
  elements.autoPlanModal.showModal();
}

function openResetWeekModal() {
  if (isWeekLocked()) {
    showToast("Diese Kalenderwoche ist schreibgeschützt.", true);
    return;
  }
  elements.resetWeekText.textContent = `${formatDate(state.weekStart)} bis ${formatDate(addDays(state.weekStart, state.data.settings.show_sunday === "1" ? 6 : 5))} · KW ${state.data.calendarWeek}`;
  elements.resetWeekModal.showModal();
}

function renderOptionList() {
  const options = state.data.weekOptions;
  elements.optionList.innerHTML = options.length ? options.map((option) => `
    <div class="option-item">
      <span class="option-item-color" style="background:${option.color}"></span>
      <div><strong>${escapeHtml(option.employee_number)} ${escapeHtml(option.nickname)} · ${optionLabels[option.option_type]}</strong>
      <small>${formatOptionDates(option)} · ${formatOptionTime(option)}${option.note ? ` · ${escapeHtml(option.note)}` : ""} · gerechnet ${formatHours(option.credited_minutes || 0)}</small></div>
      <div class="option-actions">
        <button type="button" class="edit-option" data-edit-option="${option.id}">Bearbeiten</button>
        <button type="button" class="delete-option" data-delete-option="${option.id}">Entfernen</button>
      </div>
    </div>`).join("") : '<div class="empty-options">Für diese Woche sind noch keine Sonderfälle eingetragen.</div>';
}

function renderOptionList() {
  const options = state.data.weekOptions;
  const blocks = state.data.globalDayBlocks || [];
  const blockItems = blocks.map((block) => `
    <div class="option-item global-option-item">
      <span class="option-item-color" style="background:#9aa2a4"></span>
      <div><strong>Alle · ${escapeHtml(block.reason || block.holiday_name || "Tag gesperrt")}</strong>
      <small>${formatDate(block.block_date)}${block.is_public_holiday ? " · Feiertag · gerechnet Wochen-Soll ÷ 5" : " · keine Stundenanrechnung"}</small></div>
      <div class="option-actions">
        <button type="button" class="edit-option" data-edit-global-block="${block.id}">Bearbeiten</button>
        <button type="button" class="delete-option" data-delete-global-block="${block.id}">Entfernen</button>
      </div>
    </div>`);
  const optionItems = options.map((option) => `
    <div class="option-item">
      <span class="option-item-color" style="background:${option.color}"></span>
      <div><strong>${escapeHtml(option.employee_number)} ${escapeHtml(option.nickname)} · ${optionLabels[option.option_type]}</strong>
      <small>${formatOptionDates(option)} · ${formatOptionTime(option)}${option.note ? ` · ${escapeHtml(option.note)}` : ""} · gerechnet ${formatHours(option.credited_minutes || 0)}</small></div>
      <div class="option-actions">
        <button type="button" class="edit-option" data-edit-option="${option.id}">Bearbeiten</button>
        <button type="button" class="delete-option" data-delete-option="${option.id}">Entfernen</button>
      </div>
    </div>`);
  elements.optionList.innerHTML = blockItems.length || optionItems.length
    ? [...blockItems, ...optionItems].join("")
    : '<div class="empty-options">Für diese Woche sind noch keine Sonderfälle eingetragen.</div>';
}

async function saveEmployee(event) {
  event.preventDefault();
  const number = document.querySelector("#employeeNumber").value.trim();
  const isEdit = document.querySelector("#employeeNumber").disabled;
  if (isEdit && state.employeeEditMode === "display") {
    try {
      await api(`/api/employees/${encodeURIComponent(number)}/display`, {
        method: "PATCH",
        body: JSON.stringify({ color: state.selectedColor }),
      });
      elements.employeeModal.close();
      showToast("Die Teamfarbe wurde aktualisiert.");
      await loadAll();
    } catch (error) { showToast(error.message, true); }
    return;
  }
  const body = {
    personnelNumber: number,
    fullName: document.querySelector("#employeeName").value,
    nickname: document.querySelector("#employeeNickname").value,
    contractedHours: Number(document.querySelector("#employeeHours").value),
    positionId: elements.employeePosition.value,
    homeLocationId: elements.employeeHomeLocation.value,
    preferredDepartmentId: elements.employeePreferredDepartment.value,
    preferredDayOff: document.querySelector("#employeePreferredDay").value,
    fixedWorkdays: Array.from(document.querySelectorAll('[name="employeeFixedWorkday"]:checked')).map((input) => input.value),
    color: state.selectedColor,
    active: document.querySelector("#employeeActive").checked,
  };
  if (canManageWifiAutomationSettings()) body.timeConfirmationLevel = elements.employeeTimeConfirmationLevel.value;
  const editedEmployee = state.allEmployees.find((employee) => employee.personnel_number === number) || null;
  if (canEditEmployeeAccessProfile(editedEmployee)) {
    const role = elements.employeeAppRole.value || "employee";
    const basePermissions = new Set(state.portalRoles.find((entry) => entry.id === role)?.permissions || []);
    body.accessProfile = {
      role,
      permissions: [...state.employeeAccessDraft].filter((permission) => !basePermissions.has(permission)),
    };
  }
  try {
    await api(isEdit ? `/api/employees/${encodeURIComponent(number)}` : "/api/employees", {
      method: isEdit ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    elements.employeeModal.close();
    state.rightsManagement = null;
    showToast(isEdit ? "Teammitglied wurde aktualisiert." : "Teammitglied wurde angelegt.");
    await loadAll();
  } catch (error) { showToast(error.message, true); }
}

function canManageTimeTrackingSettings() {
  return !state.portalStatus?.portalEnabled
    || state.portalSession?.user?.permissions?.includes("time:settings");
}

function syncLocationTimeTrackingFields() {
  const canManage = canManageTimeTrackingSettings();
  const trustedNetwork = elements.locationTimeTrackingAccessMode?.value === "trusted_network";
  for (const field of [elements.locationTimeTrackingEnabled, elements.locationTimeTrackingAccessMode, elements.locationTimeTrackingVarianceMinutes]) {
    if (field) field.disabled = !canManage;
  }
  if (elements.locationTimeTrackingAllowedNetworks) {
    elements.locationTimeTrackingAllowedNetworks.disabled = !canManage || !trustedNetwork;
  }
}

function resetLocationForm() {
  state.editingLocationId = null;
  elements.locationForm.reset();
  elements.locationId.disabled = false;
  elements.locationMinStaff.value = 0;
  elements.locationActive.checked = true;
  elements.locationTimeTrackingEnabled.checked = false;
  elements.locationTimeTrackingAccessMode.value = "anywhere";
  elements.locationTimeTrackingAllowedNetworks.value = "";
  elements.locationTimeTrackingVarianceMinutes.value = "15";
  syncLocationTimeTrackingFields();
  setLocationDayFields(currentLocation()?.day_settings || state.locations?.[0]?.day_settings || {});
  elements.locationSubmitButton.textContent = "Filiale anlegen";
  const title = elements.locationEditorModal?.querySelector(".modal-header h2");
  if (title) title.textContent = "Filiale anlegen";
}

function fillLocationForm(location) {
  state.editingLocationId = location.id;
  elements.locationId.value = location.id;
  elements.locationId.disabled = true;
  elements.locationName.value = location.name;
  elements.locationMinStaff.value = Number(location.min_staff || 0);
  elements.locationActive.checked = Boolean(location.active);
  elements.locationTimeTrackingEnabled.checked = Boolean(location.time_tracking_enabled);
  elements.locationTimeTrackingAccessMode.value = location.time_tracking_access_mode === "trusted_network" ? "trusted_network" : "anywhere";
  elements.locationTimeTrackingAllowedNetworks.value = location.time_tracking_allowed_networks || "";
  elements.locationTimeTrackingVarianceMinutes.value = String(Number(location.time_tracking_variance_minutes ?? 15));
  syncLocationTimeTrackingFields();
  setLocationDayFields(location.day_settings || {});
  elements.locationSubmitButton.textContent = "Filiale speichern";
  const title = elements.locationEditorModal?.querySelector(".modal-header h2");
  if (title) title.textContent = "Filiale bearbeiten";
}

function setLocationDayFields(daySettings = {}) {
  document.querySelectorAll("[data-day-settings]").forEach((row) => {
    const day = row.dataset.daySettings;
    const values = daySettings[day] || {};
    const field = (name) => row.querySelector(`[data-field="${name}"]`);
    field("start").value = values.start || (day === "saturday" ? "10:00" : "09:00");
    field("end").value = values.end || (day === "saturday" ? "17:00" : "18:00");
    field("lunchEnabled").checked = values.lunchEnabled === true;
    field("lunchStart").value = values.lunchStart || "13:00";
    field("lunchEnd").value = values.lunchEnd || "14:00";
    field("minStaff").value = Number(values.minStaff || 0);
    field("minFrom").value = values.minFrom || field("start").value;
    field("minTo").value = values.minTo || field("end").value;
    document.querySelector(`#${day}Open`).checked = values.open !== false;
  });
}

function readLocationDayFields() {
  return Object.fromEntries([...document.querySelectorAll("[data-day-settings]")].map((row) => {
    const field = (name) => row.querySelector(`[data-field="${name}"]`);
    return [row.dataset.daySettings, {
      open: document.querySelector(`#${row.dataset.daySettings}Open`).checked,
      start: field("start").value, end: field("end").value,
      lunchEnabled: field("lunchEnabled").checked,
      lunchStart: field("lunchStart").value, lunchEnd: field("lunchEnd").value,
      minStaff: Number(field("minStaff").value || 0),
      minFrom: field("minFrom").value, minTo: field("minTo").value,
    }];
  }));
}

async function saveLocation(event) {
  event.preventDefault();
  const isEdit = Boolean(state.editingLocationId);
  const id = isEdit ? state.editingLocationId : elements.locationId.value;
  try {
    const timeTrackingSettings = canManageTimeTrackingSettings() ? {
      timeTrackingEnabled: elements.locationTimeTrackingEnabled.checked,
      timeTrackingAccessMode: elements.locationTimeTrackingAccessMode.value,
      timeTrackingAllowedNetworks: elements.locationTimeTrackingAllowedNetworks.value,
      timeTrackingVarianceMinutes: Number(elements.locationTimeTrackingVarianceMinutes.value || 15),
    } : {};
    state.locations = await api(isEdit ? `/api/locations/${encodeURIComponent(id)}` : "/api/locations", {
      method: isEdit ? "PUT" : "POST",
      body: JSON.stringify({
        id,
        name: elements.locationName.value,
        minStaff: Number(elements.locationMinStaff.value || 0),
        active: elements.locationActive.checked,
        ...timeTrackingSettings,
        daySettings: readLocationDayFields(),
      }),
    });
    elements.locationEditorModal?.close();
    resetLocationForm();
    showToast(isEdit ? "Filiale wurde gespeichert." : "Filiale wurde angelegt.");
    await loadAll();
  } catch (error) { showToast(error.message, true); }
}

function resetDepartmentForm() {
  state.editingDepartmentId = null;
  elements.departmentForm.reset();
  elements.departmentId.value = "";
  elements.departmentLocation.value = state.locationId || elements.departmentLocation.options[0]?.value || "";
  elements.departmentMinStaff.value = 0;
  elements.departmentActive.checked = true;
  elements.departmentSubmitButton.textContent = "Abteilung anlegen";
  const title = elements.departmentEditorModal?.querySelector(".modal-header h2");
  if (title) title.textContent = "Abteilung anlegen";
}

function fillDepartmentForm(department) {
  state.editingDepartmentId = department.id;
  elements.departmentId.value = department.id;
  elements.departmentLocation.value = department.location_id;
  elements.departmentName.value = department.name;
  elements.departmentMinStaff.value = Number(department.min_staff || 0);
  elements.departmentActive.checked = Boolean(department.active);
  elements.departmentSubmitButton.textContent = "Abteilung speichern";
  const title = elements.departmentEditorModal?.querySelector(".modal-header h2");
  if (title) title.textContent = "Abteilung bearbeiten";
}

async function saveDepartment(event) {
  event.preventDefault();
  const isEdit = Boolean(state.editingDepartmentId);
  try {
    state.locations = await api(isEdit ? `/api/departments/${state.editingDepartmentId}` : "/api/departments", {
      method: isEdit ? "PUT" : "POST",
      body: JSON.stringify({
        locationId: elements.departmentLocation.value,
        name: elements.departmentName.value,
        minStaff: Number(elements.departmentMinStaff.value || 0),
        active: elements.departmentActive.checked,
      }),
    });
    elements.departmentEditorModal?.close();
    resetDepartmentForm();
    showToast(isEdit ? "Abteilung wurde gespeichert." : "Abteilung wurde angelegt.");
    await loadAll();
  } catch (error) { showToast(error.message, true); }
}

function resetPositionForm() {
  state.editingPositionId = null;
  elements.positionForm.reset();
  elements.positionId.value = "";
  elements.positionSubmitButton.textContent = "Position hinzufügen";
  elements.cancelPositionEditButton.classList.add("hidden");
}

function fillPositionForm(position) {
  state.editingPositionId = position.id;
  elements.positionId.value = position.id;
  elements.positionName.value = position.name;
  elements.positionSubmitButton.textContent = "Position speichern";
  elements.cancelPositionEditButton.classList.remove("hidden");
}

async function savePosition(event) {
  event.preventDefault();
  const isEdit = Boolean(state.editingPositionId);
  try {
    state.positions = await api(isEdit ? `/api/positions/${encodeURIComponent(state.editingPositionId)}` : "/api/positions", {
      method: isEdit ? "PUT" : "POST",
      body: JSON.stringify({ name: elements.positionName.value }),
    });
    resetPositionForm();
    renderPositions();
    showToast(isEdit ? "Position wurde gespeichert." : "Position wurde hinzugefügt.");
  } catch (error) { showToast(error.message, true); }
}

async function deletePosition(id) {
  if (!confirm("Diese eigene Position wirklich löschen? Bestehende Teammitglieder werden auf Verkaufsmitarbeiter gesetzt.")) return;
  try {
    await api(`/api/positions/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.positions = await api("/api/positions");
    resetPositionForm();
    showToast("Position wurde gelöscht.");
    await loadAll();
  } catch (error) { showToast(error.message, true); }
}

async function saveShift(event) {
  event.preventDefault();
  const id = document.querySelector("#shiftId").value;
  const body = {
    employeeNumber: document.querySelector("#shiftEmployee").value,
    departmentId: elements.shiftDepartment.value || "",
    date: document.querySelector("#shiftDate").value,
    startTime: document.querySelector("#shiftStart").value,
    endTime: document.querySelector("#shiftEnd").value,
    area: document.querySelector("#shiftArea").value,
    note: document.querySelector("#shiftNote").value,
  };
  try {
    await api(id ? `/api/shifts/${id}` : "/api/shifts", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
    elements.shiftModal.close();
    state.weekStart = getMonday(new Date(`${body.date}T12:00:00`));
    showToast(id ? "Dienst wurde aktualisiert." : "Dienst wurde eingetragen.");
    await loadAll();
  } catch (error) { showToast(error.message, true); }
}

async function saveOption(event) {
  event.preventDefault();
  const isEdit = Boolean(state.editingOptionId);
  const body = {
    employeeNumber: document.querySelector("#optionEmployee").value,
    weekStart: state.weekStart,
    dateFrom: document.querySelector("#optionDateFrom").value,
    dateTo: document.querySelector("#optionDateTo").value,
    optionType: document.querySelector("#optionType").value,
    allDay: document.querySelector("#optionAllDay").checked,
    startTime: document.querySelector("#optionStartTime").value,
    endTime: document.querySelector("#optionEndTime").value,
    manualHours: document.querySelector("#optionHours").value,
    note: document.querySelector("#optionNote").value,
    groupId: state.editingOptionGroupId,
  };
  try {
    await api(isEdit ? `/api/week-options/${state.editingOptionId}` : "/api/week-options", {
      method: isEdit ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    await loadAll();
    renderOptionList();
    document.querySelector("#optionNote").value = "";
    document.querySelector("#optionHours").value = "";
    resetOptionEditor();
    showToast(isEdit ? "Planungsoption wurde aktualisiert." : "Planungsoption wurde hinzugefügt.");
  } catch (error) { showToast(error.message, true); }
}

async function saveGlobalBlock() {
  const isEdit = Boolean(state.editingGlobalBlockId);
  try {
    await api(isEdit ? `/api/global-day-blocks/${state.editingGlobalBlockId}` : "/api/global-day-blocks", {
      method: isEdit ? "PUT" : "POST",
      body: JSON.stringify({
        weekStart: state.weekStart,
        locationId: state.locationId,
        blockDate: elements.globalBlockDate.value,
        reason: elements.globalBlockReason.value,
        isPublicHoliday: elements.globalBlockHoliday.checked,
      }),
    });
    await loadAll();
    renderOptionList();
    resetGlobalBlockEditor();
    elements.globalBlockReason.value = "";
    updateGlobalBlockHolidaySuggestion();
    showToast(isEdit ? "Sperrtag wurde aktualisiert." : "Sperrtag wurde eingetragen.");
  } catch (error) { showToast(error.message, true); }
}

async function deleteGlobalBlock(id) {
  if (!id || !confirm("Diesen Sperrtag wirklich entfernen?")) return;
  try {
    await api(`/api/global-day-blocks/${id}`, { method: "DELETE" });
    await loadAll();
    renderOptionList();
    showToast("Sperrtag wurde entfernt.");
  } catch (error) { showToast(error.message, true); }
}

async function createAutomaticPlan(event) {
  event.preventDefault();
  const replaceExisting = document.querySelector('input[name="autoMode"]:checked').value === "replace";
  try {
    const result = await api("/api/schedule/auto", {
      method: "POST",
      body: JSON.stringify({ weekStart: state.weekStart, replaceExisting, locationId: state.locationId, departmentId: state.departmentId || "" }),
    });
    elements.autoPlanModal.close();
    await loadAll();
    const warningText = result.warnings.length ? ` ${result.warnings.join(" ")}` : "";
    showToast(`${result.created} Dienste wurden automatisch erstellt.${warningText}`, result.warnings.length > 0);
  } catch (error) { showToast(error.message, true); }
}

async function resetCurrentWeek(event) {
  event.preventDefault();
  try {
    const result = await api(`/api/schedule?week=${state.weekStart}${contextQuery(true)}`, { method: "DELETE" });
    elements.resetWeekModal.close();
    await loadAll();
    showToast(`${result.deleted} Dienste wurden aus der aktuellen Woche gelöscht.`);
  } catch (error) { showToast(error.message, true); }
}

const scheduleNoteMaxLength = 900;

function stripEmoji(value) {
  return String(value || "")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/[\u2600-\u27BF]/gu, "")
    .replace(/\uFEFF/g, "");
}

function sanitizeScheduleNoteEditor() {
  const editorRoot = scheduleNoteQuill?.root || elements.scheduleNoteEditor;
  if (!editorRoot || scheduleNoteSanitizing) return;
  const before = editorRoot.innerHTML;
  const after = stripEmoji(before);
  if (before !== after) {
    if (scheduleNoteQuill) {
      const selection = scheduleNoteQuill.getSelection();
      scheduleNoteSanitizing = true;
      scheduleNoteQuill.clipboard.dangerouslyPasteHTML(after);
      if (selection) scheduleNoteQuill.setSelection(Math.min(selection.index, scheduleNoteQuill.getLength()), 0, "silent");
      scheduleNoteSanitizing = false;
    } else {
      editorRoot.innerHTML = after;
      const range = document.createRange();
      range.selectNodeContents(editorRoot);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
}

function scheduleNotePlainText() {
  return stripEmoji(scheduleNoteQuill?.getText() || elements.scheduleNoteEditor?.innerText || "").trim();
}

function scheduleNoteHtml() {
  const html = stripEmoji(scheduleNoteQuill?.root?.innerHTML || elements.scheduleNoteEditor?.innerHTML || "").trim();
  return /^<p><br><\/p>$/i.test(html) ? "" : html;
}

function setScheduleNoteHtml(html) {
  const cleanHtml = stripEmoji(html || "");
  if (scheduleNoteQuill) {
    scheduleNoteSanitizing = true;
    scheduleNoteQuill.setText("");
    if (cleanHtml) scheduleNoteQuill.clipboard.dangerouslyPasteHTML(cleanHtml);
    scheduleNoteSanitizing = false;
  } else if (elements.scheduleNoteEditor) {
    elements.scheduleNoteEditor.innerHTML = cleanHtml;
  }
}

function updateScheduleNoteCounter() {
  sanitizeScheduleNoteEditor();
  const text = scheduleNotePlainText();
  if (text.length > scheduleNoteMaxLength) {
    if (scheduleNoteQuill) {
      scheduleNoteQuill.deleteText(scheduleNoteMaxLength, scheduleNoteQuill.getLength(), "silent");
    } else {
      elements.scheduleNoteEditor.innerText = text.slice(0, scheduleNoteMaxLength);
    }
  }
  elements.scheduleNoteCounter.textContent = `${Math.min(text.length, scheduleNoteMaxLength)}/${scheduleNoteMaxLength} Zeichen · Smileys werden für schlanke PDFs automatisch entfernt.`;
}

function openScheduleNoteModal() {
  if (isWeekLocked()) {
    showToast("Diese Kalenderwoche ist schreibgeschützt.", true);
    return;
  }
  const note = state.data.scheduleNote || {};
  elements.scheduleNoteForm.reset();
  setScheduleNoteHtml(note.note_html || escapeHtml(note.note_text || "").replace(/\n/g, "<br>"));
  elements.deleteScheduleNoteButton.classList.toggle("hidden", !note.note_text);
  updateScheduleNoteCounter();
  elements.scheduleNoteModal.showModal();
  setTimeout(() => scheduleNoteQuill?.focus(), 50);
}

function initScheduleNoteEditor() {
  if (!elements.scheduleNoteEditor || scheduleNoteQuill || !window.Quill) return;
  const Size = window.Quill.import("attributors/class/size");
  Size.whitelist = ["small", "large"];
  window.Quill.register(Size, true);
  scheduleNoteQuill = new window.Quill(elements.scheduleNoteEditor, {
    theme: "snow",
    placeholder: "z. B. Bitte Schaufensteraktion beachten",
    formats: ["bold", "italic", "underline", "size"],
    modules: {
      toolbar: "#scheduleNoteToolbar",
      clipboard: { matchVisual: false },
    },
  });
  scheduleNoteQuill.on("text-change", updateScheduleNoteCounter);
}

async function saveScheduleNote(event) {
  event.preventDefault();
  sanitizeScheduleNoteEditor();
  try {
    await api("/api/schedule-note", {
      method: "PUT",
      body: JSON.stringify({
        weekStart: state.weekStart,
        locationId: state.locationId,
        departmentId: state.departmentId || "",
        noteText: scheduleNotePlainText(),
        noteHtml: scheduleNoteHtml(),
      }),
    });
    elements.scheduleNoteModal.close();
    showToast("Besondere Bemerkung wurde gespeichert.");
    await loadAll();
  } catch (error) { showToast(error.message, true); }
}

async function deleteScheduleNote() {
  if (!state.data.scheduleNote?.note_text || !confirm("Diese besondere Bemerkung wirklich löschen?")) return;
  try {
    await api(`/api/schedule-note?week=${state.weekStart}${contextQuery(true)}`, { method: "DELETE" });
    elements.scheduleNoteModal.close();
    showToast("Besondere Bemerkung wurde gelöscht.");
    await loadAll();
  } catch (error) { showToast(error.message, true); }
}

async function createManualBackup() {
  try {
    const backup = await api("/api/backup", { method: "POST" });
    await loadSystemInfo();
    const paths = [backup.appBackup?.path, backup.externalBackup?.path].filter(Boolean);
    showToast(paths.length > 1 ? "Backups erstellt: intern und lokale PC-Sicherung." : `Backup erstellt: ${paths[0] || backup.path}`);
  } catch (error) { showToast(error.message, true); }
}

function renderUpdateStatus(status = state.updateStatus) {
  if (!elements.updateCheckButton) return;
  elements.updateCheckButton.classList.remove("current", "available", "security", "error", "checking");
  if (!status) {
    elements.updateCheckIcon.textContent = "↻";
    elements.updateCheckText.textContent = "Update prüfen";
    elements.updateCheckHint.textContent = "GitHub";
    return;
  }
  elements.updateCheckButton.classList.add(status.cssClass || "");
  elements.updateCheckIcon.textContent = status.icon || "↻";
  elements.updateCheckText.textContent = status.text || "Update prüfen";
  elements.updateCheckHint.textContent = status.hint || "GitHub";
}

async function checkForUpdates(showResult = true) {
  state.updateStatus = { cssClass: "checking", icon: "↻", text: "Prüfe Update", hint: "GitHub..." };
  renderUpdateStatus();
  try {
    const status = await api("/api/update-status");
    const updateTypeLabel = status.updateTypeLabel || "Update";
    state.updateStatus = {
      ...status,
      cssClass: status.updateAvailable ? (status.updateKind === "security" ? "security" : "available") : "current",
      icon: status.updateAvailable ? "!" : "✓",
      text: status.updateAvailable ? `${updateTypeLabel} verfügbar` : "Aktuell",
      hint: status.updateAvailable ? status.latestVersion : status.currentLabel,
    };
    renderUpdateStatus();
    if (showResult) {
      showToast(status.updateAvailable
        ? status.canAutoUpdate
          ? `${updateTypeLabel} ${status.latestVersion} verfügbar. Klick unten links startet die Aktualisierung.`
          : `${status.managementNote || `${updateTypeLabel} ${status.latestVersion} verfügbar.`}`
        : "Du hast die aktuellste Version.");
    }
    return status;
  } catch (error) {
    state.updateStatus = { cssClass: "error", icon: "?", text: "Update unklar", hint: "GitHub nicht erreichbar" };
    renderUpdateStatus();
    if (showResult) showToast(error.message, true);
    return null;
  }
}

async function handleUpdateButton() {
  const status = state.updateStatus?.latestTag ? state.updateStatus : await checkForUpdates(false);
  if (!status) {
    await checkForUpdates(true);
    return;
  }
  if (!status.updateAvailable) {
    showToast("Du hast die aktuellste Version.");
    return;
  }
  if (!status.canAutoUpdate) {
    showToast(status.managementNote || "Dieses Update muss kontrolliert am Server eingespielt werden.");
    return;
  }
  const updateTypeLabel = status.updateTypeLabel || "Update";
  const confirmed = confirm(`${updateTypeLabel} ${status.latestVersion} ist verfügbar.\n\nDie Aktualisierung ersetzt nur die App-Dateien. Dienstpläne, Datenbank und Backups bleiben erhalten.\n\nJetzt aktualisieren und Grabenplaner automatisch neu starten?`);
  if (!confirmed) return;
  try {
    elements.updateCheckButton.disabled = true;
    elements.updateCheckText.textContent = "Update läuft";
    elements.updateCheckHint.textContent = "Neustart folgt";
    const result = await api("/api/update-apply", { method: "POST", body: JSON.stringify({}) });
    showToast(result.message || "Update wird installiert.");
  } catch (error) {
    elements.updateCheckButton.disabled = false;
    showToast(error.message, true);
  }
}

async function exitApplication() {
  const serverActive = state.portalStatus?.operationMode === "server";
  const question = serverActive
    ? "Den Grabenplaner-Server wirklich sicher beenden? Andere angemeldete Personen verlieren dabei die Verbindung."
    : "Grabenplaner sicher beenden? Danach kannst du dieses Browserfenster schließen.";
  if (!confirm(question)) return;
  if (elements.systemExitButton) elements.systemExitButton.disabled = true;
  try {
    const result = await api("/api/system/exit", {
      method: "POST",
      body: JSON.stringify({}),
    });
    showToast(result.message || (serverActive ? "Der Server wird beendet." : "Grabenplaner wird beendet."));
    setTimeout(() => {
      document.body.innerHTML = serverActive
        ? '<main class="shutdown-screen"><h1>Grabenplaner-Server wurde beendet.</h1><p>Du kannst dieses Fenster schließen.</p></main>'
        : '<main class="shutdown-screen"><h1>Grabenplaner wurde beendet.</h1><p>Du kannst dieses Fenster schließen. Den USB-Stick bitte bei Bedarf selbst über Windows sicher auswerfen.</p></main>';
    }, 900);
  } catch (error) {
    if (elements.systemExitButton) elements.systemExitButton.disabled = false;
    showToast(error.message, true);
  }
}

async function importBackup() {
  const fileInput = document.querySelector("#backupImportFile");
  const file = fileInput.files?.[0];
  if (!file) {
    showToast("Bitte zuerst eine Backup-Datei auswählen.", true);
    return;
  }
  const preserveBranding = document.querySelector('input[name="backupImportMode"]:checked')?.value !== "complete";
  const modeText = preserveBranding ? "Das aktuelle Branding bleibt erhalten." : "Das Branding aus dem Backup wird ebenfalls übernommen.";
  if (!confirm(`Dieses Backup ersetzt nach einem Neustart die aktuelle Datenbank. ${modeText} Vorher wird automatisch ein Sicherheitsbackup erstellt. Fortfahren?`)) return;
  try {
    const response = await fetch(`/api/backup/import?preserveBranding=${preserveBranding ? "1" : "0"}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Backup-Filename": encodeURIComponent(file.name),
        ...csrfHeader(),
      },
      body: await file.arrayBuffer(),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Backup konnte nicht importiert werden.");
    showToast(result.message || "Backup importiert. Grabenplaner startet automatisch neu.");
  } catch (error) { showToast(error.message, true); }
}

async function exportBrandingKit() {
  try {
    const response = await fetch(`/api/branding/export.zip?${contextQuery(true).slice(1)}`);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || "Branding-Kit konnte nicht exportiert werden.");
    }
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "grabenplaner-branding-kit.zip";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    showToast("Branding-Kit wurde exportiert.");
  } catch (error) { showToast(error.message, true); }
}

async function importBrandingKit() {
  const file = elements.brandingImportFile.files?.[0];
  if (!file) {
    showToast("Bitte zuerst eine Branding-ZIP oder Branding-JSON auswählen.", true);
    return;
  }
  const isZip = /\.zip$/i.test(file.name) || file.type === "application/zip" || file.type === "application/x-zip-compressed";
  if (!confirm("Branding-Kit importieren? Firmenname, Logo, Admin-Kontakt und PDF-Titel werden für den aktuellen Standort übernommen.")) return;
  try {
    if (isZip) {
      const response = await fetch(`/api/branding/import.zip?${contextQuery(true).slice(1)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/zip",
          "X-Branding-Filename": encodeURIComponent(file.name),
          ...csrfHeader(),
        },
        body: await file.arrayBuffer(),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Branding-ZIP konnte nicht importiert werden.");
      if (result.kits) state.brandingKits = result.kits;
    } else {
      let kit;
      try {
        kit = JSON.parse((await file.text()).replace(/^\uFEFF/, ""));
      } catch {
        showToast("Die Branding-Datei ist keine gültige JSON-Datei.", true);
        return;
      }
      const result = await api("/api/branding/import", {
        method: "PUT",
        body: JSON.stringify({
          locationId: state.locationId,
          departmentId: state.departmentId || "",
          kit,
        }),
      });
      if (result.kits) state.brandingKits = result.kits;
    }
    showToast("Branding-Kit wurde importiert.");
    await loadAll();
    await loadSystemInfo();
  } catch (error) { showToast(error.message, true); }
}

async function applyInstalledBrandingKit(kitId) {
  try {
    const result = await api("/api/branding/preference", {
      method: "PUT",
      body: JSON.stringify({ kitId }),
    });
    updateManagementBrandingPreference(result);
    renderSettings();
    showToast("Branding-Kit wurde angewendet.");
  } catch (error) { showToast(error.message, true); }
}

async function deleteInstalledBrandingKit(kitId, kitName) {
  if (!confirm(`Branding-Kit „${kitName || kitId}“ wirklich löschen? Bereits verwendete Kits bleiben geschützt.`)) return;
  try {
    const result = await api(`/api/branding/kits/${encodeURIComponent(kitId)}?locationId=${encodeURIComponent(state.locationId || "")}`, { method: "DELETE" });
    if (result.kits) state.brandingKits = result.kits;
    renderBrandingKits();
    renderBrandingAssignments();
    showToast("Branding-Kit wurde gelöscht.");
  } catch (error) {
    showToast(error.code === "BRANDING_KIT_IN_USE" ? "Das Branding-Kit ist noch ausgewählt oder einem Standort zugeordnet." : error.message, true);
  }
}

const usbWizardSteps = ["profile", "branding", "team", "guide", "drive"];
const usbProfileFeatures = {
  full: ["planning", "vacations", "absence_requests", "employee_portal", "time_tracking", "sickness_amu", "wifi_time_suggestions"],
  "planning-vacation": ["planning", "vacations", "absence_requests"],
};

function usbFeatureInputs() {
  return [...elements.usbModuleSelection.querySelectorAll('input[type="checkbox"]')];
}

function applyUsbProfile(profile = elements.usbInstallationProfile.value) {
  const selected = new Set(usbProfileFeatures[profile] || []);
  if (profile !== "custom") {
    for (const input of usbFeatureInputs()) input.checked = input.disabled || selected.has(input.value);
  }
  syncUsbFeatureDependencies();
}

function syncUsbFeatureDependencies() {
  const values = Object.fromEntries(usbFeatureInputs().map((input) => [input.value, input]));
  if (values.wifi_time_suggestions?.checked) values.time_tracking.checked = true;
  if (values.sickness_amu?.checked) values.absence_requests.checked = true;
  if (values.time_tracking?.checked || values.sickness_amu?.checked || values.wifi_time_suggestions?.checked) values.employee_portal.checked = true;
  updateUsbSummary();
}

function selectedUsbFeatures() {
  return usbFeatureInputs().filter((input) => input.checked).map((input) => input.value);
}

function selectedUsbLocationIds() {
  return [...elements.usbLocationSelection.querySelectorAll('[data-usb-location]:checked')].map((input) => input.value);
}

function currentUsbDrive() {
  return (state.usbProvisioning.metadata?.drives || []).find((drive) => drive.token === state.usbProvisioning.selectedDriveToken) || null;
}

function formatUsbSize(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024 ** 3) return `${Math.max(0, value / 1024 ** 2).toFixed(0)} MB`;
  return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
}

function setUsbWizardStep(step) {
  if (!usbWizardSteps.includes(step)) return;
  state.usbProvisioning.step = step;
  const index = usbWizardSteps.indexOf(step);
  document.querySelectorAll("[data-usb-wizard-step]").forEach((button) => {
    const active = button.dataset.usbWizardStep === step;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "step" : "false");
  });
  document.querySelectorAll("[data-usb-wizard-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.usbWizardPanel === step));
  elements.usbWizardPreviousButton.disabled = index === 0;
  elements.usbWizardNextButton.classList.toggle("hidden", index === usbWizardSteps.length - 1);
  elements.usbWizardStepHint.textContent = `Schritt ${index + 1} von ${usbWizardSteps.length} · ${document.querySelector(`[data-usb-wizard-step="${step}"] strong`)?.textContent || ""}`;
  if (step === "drive") refreshUsbDrives().catch((error) => showToast(error.message, true));
  updateUsbSummary();
}

function renderUsbAvailability(metadata) {
  const available = metadata?.available === true;
  const reasonCode = String(metadata?.reasonCode || "");
  let title = "Nur direkt am Windows-Host möglich";
  let fallbackReason = "Aus Sicherheitsgründen können nur USB-Sticks verwendet werden, die direkt am Windows-Host angeschlossen sind. USB-Sticks an einem entfernten PC, Tablet oder Smartphone sind nicht erreichbar.";
  if (reasonCode === "USB_WINDOWS_REQUIRED") {
    title = "Nur auf einem Windows-Host verfügbar";
    fallbackReason = "Die Vorbereitung und Formatierung sind nur an einem Windows-Host verfügbar.";
  } else if (reasonCode === "USB_DEPLOYMENT_UNSUPPORTED") {
    title = "In dieser Umgebung nicht verfügbar";
    fallbackReason = "Der USB-Stick-Assistent ist in dieser Test- oder Entwicklungsumgebung nicht verfügbar.";
  }
  elements.usbProvisioningAvailabilityBadge.textContent = available ? "Bereit" : "Gesperrt";
  elements.usbProvisioningAvailabilityBadge.classList.toggle("inactive", !available);
  elements.usbProvisioningAvailabilityTitle.textContent = available ? "Windows-Host ist bereit" : title;
  elements.usbProvisioningAvailabilityText.textContent = available
    ? "Formatierung und Installation erfolgen auf diesem Windows-Host mit den aktuellen Benutzerrechten."
    : (metadata?.reason || fallbackReason);
  elements.usbProvisioningWizard.classList.toggle("hidden", !available);
}

function renderUsbCreators() {
  const creators = state.usbProvisioning.metadata?.creators || [];
  const previous = elements.usbCreatorEmployee.value;
  const currentEmployeeNumber = state.portalSession?.user?.employeeNumber || "";
  elements.usbCreatorEmployee.innerHTML = creators.map((creator) => `<option value="${escapeHtml(creator.employeeNumber)}">${escapeHtml(creator.employeeNumber)} · ${escapeHtml(creator.fullName)} · ${escapeHtml(creator.role)}</option>`).join("");
  const selected = creators.find((creator) => creator.employeeNumber === previous)
    || creators.find((creator) => creator.employeeNumber === currentEmployeeNumber)
    || creators[0];
  if (!selected) {
    elements.usbCreatorSummary.innerHTML = '<span class="usb-creator-mark">!</span><div><strong>Kein geeignetes Erstellerkonto</strong><small>Richte zuerst einen aktiven Developer-, IT-Admin- oder Admin-Zugang mit Passwort ein.</small></div><span class="status-badge inactive">Fehlt</span>';
    return;
  }
  elements.usbCreatorEmployee.value = selected.employeeNumber;
  state.usbProvisioning.creatorEmployeeNumber = selected.employeeNumber;
  state.usbProvisioning.selectedEmployees.add(selected.employeeNumber);
  elements.usbCreatorSummary.innerHTML = `<span class="usb-creator-mark">A</span><div><strong>${escapeHtml(selected.employeeNumber)} · ${escapeHtml(selected.fullName)}</strong><small>${escapeHtml(selected.positionName || selected.role)} · wird auf dem Zielstick als Admin angelegt</small></div><span class="status-badge">Pflicht</span>`;
}

function renderUsbBrandings() {
  const kits = state.brandingKits || [];
  const previous = elements.usbPrimaryBranding.value;
  elements.usbPrimaryBranding.innerHTML = kits.map((kit) => `<option value="${escapeHtml(kit.id)}">${escapeHtml(kit.name)}</option>`).join("");
  const preferred = kits.some((kit) => kit.id === previous) ? previous
    : (state.brandingPreference?.kitId && kits.some((kit) => kit.id === state.brandingPreference.kitId)
      ? state.brandingPreference.kitId : (kits.find((kit) => kit.active)?.id || kits[0]?.id || "neutral"));
  elements.usbPrimaryBranding.value = preferred;
  const primary = kits.find((kit) => kit.id === preferred);
  elements.usbPrimaryBrandingPreview.innerHTML = primary
    ? `<img src="${escapeHtml(primary.branding.logoUrl)}" alt="" /><strong>${escapeHtml(primary.name)}</strong><small>${escapeHtml(primary.branding.companyName || "Grabenplaner")}</small>`
    : '<span class="status-badge inactive">Fehlt</span><strong>Kein Branding ausgewählt</strong>';
  const selectedExtras = new Set([...elements.usbAdditionalBrandings.querySelectorAll("input:checked")].map((input) => input.value));
  elements.usbAdditionalBrandings.innerHTML = kits.filter((kit) => kit.id !== "neutral").map((kit) => {
    const forced = kit.id === preferred;
    return `<label><input type="checkbox" value="${escapeHtml(kit.id)}" ${forced || selectedExtras.has(kit.id) ? "checked" : ""} ${forced ? "disabled" : ""} /><span><strong>${escapeHtml(kit.name)}</strong><small>${forced ? "Haupt-Branding · wird immer mitinstalliert" : "Zusätzlich mitinstallieren"}</small></span></label>`;
  }).join("") || '<p class="settings-note">Neben dem neutralen Standard sind noch keine Branding-Kits installiert.</p>';
}

function renderUsbLocations() {
  const selectedBefore = new Set([...elements.usbLocationSelection.querySelectorAll('[data-usb-location]:checked')].map((input) => input.value));
  const locations = (state.locations || []).filter((location) => location.active);
  const creatorLocationId = selectedUsbCreator()?.homeLocationId || "";
  elements.usbLocationSelection.innerHTML = locations.map((location) => {
    const required = location.id === creatorLocationId;
    const selected = required || (selectedBefore.size ? selectedBefore.has(location.id) : true);
    const departmentText = (location.departments || []).filter((department) => department.active).map((department) => department.name).join(", ") || "Keine Abteilung";
    return `<label class="usb-selection-row"><input data-usb-location type="checkbox" value="${escapeHtml(location.id)}" ${selected ? "checked" : ""} ${required ? "disabled" : ""} /><span><strong>${escapeHtml(location.id)} · ${escapeHtml(location.name)}</strong><small>${escapeHtml(departmentText)}</small></span><span class="status-badge ${selected ? "" : "inactive"}">${required ? "Ersteller" : selected ? "Dabei" : "Nicht dabei"}</span></label>`;
  }).join("") || '<p class="settings-note">Es ist kein aktiver Standort vorhanden.</p>';
}

function synchronizeUsbTeamWithLocations() {
  const selectedLocations = new Set(selectedUsbLocationIds());
  const creatorNumber = elements.usbCreatorEmployee.value;
  for (const employee of state.allEmployees || []) {
    if (employee.personnel_number !== creatorNumber && !selectedLocations.has(String(employee.home_location_id || ""))) {
      state.usbProvisioning.selectedEmployees.delete(employee.personnel_number);
    }
  }
  for (const draft of state.usbProvisioning.employeeDrafts) {
    if (!selectedLocations.has(String(draft.homeLocationId || ""))) state.usbProvisioning.selectedEmployees.delete(draft.personnelNumber);
  }
  state.usbProvisioning.selectedEmployees.add(creatorNumber);
  renderUsbEmployees();
}

function selectedUsbCreator() {
  const creators = state.usbProvisioning.metadata?.creators || [];
  return creators.find((creator) => creator.employeeNumber === elements.usbCreatorEmployee.value) || creators[0] || null;
}

function usbRoleOptions(selectedRole, { departmentId = null } = {}) {
  const assignable = new Set(selectedUsbCreator()?.assignableRoleIds || ["employee"]);
  const allowed = (state.portalRoles || []).filter((role) => assignable.has(role.id)
    && (role.id !== "department_manager" || Number(departmentId || 0) > 0));
  const effectiveRole = allowed.some((role) => role.id === selectedRole) ? selectedRole : "employee";
  return allowed.map((role) => `<option value="${escapeHtml(role.id)}" ${role.id === effectiveRole ? "selected" : ""}>${escapeHtml(role.name)}</option>`).join("");
}

function usbPermissionOptions(selected = []) {
  const values = new Set(selected);
  return (state.portalPermissionCatalog || []).map((permission) => `<label><input type="checkbox" value="${escapeHtml(permission.id)}" ${values.has(permission.id) ? "checked" : ""} /><span>${escapeHtml(permission.label)}</span></label>`).join("");
}

function captureUsbEmployeeRows() {
  for (const row of elements.usbEmployeeSelection.querySelectorAll("[data-usb-employee]")) {
    const number = row.dataset.usbEmployee;
    const selected = Boolean(row.querySelector("[data-usb-employee-selected]")?.checked);
    if (selected) state.usbProvisioning.selectedEmployees.add(number);
    else state.usbProvisioning.selectedEmployees.delete(number);
    state.usbProvisioning.employeeOverrides.set(number, {
      role: row.querySelector("[data-usb-role]")?.value || "employee",
      startPassword: row.querySelector("[data-usb-start-password]")?.value || "",
      additionalPermissions: [...row.querySelectorAll(".usb-rights-grid input:checked")].map((input) => input.value),
    });
  }
}

function renderUsbEmployees() {
  const creatorNumber = elements.usbCreatorEmployee.value;
  const selectedLocations = new Set(selectedUsbLocationIds());
  const query = elements.usbEmployeeSearch.value.trim().toLocaleLowerCase("de");
  const existing = (state.allEmployees || []).filter((employee) => employee.active
    && (employee.personnel_number === creatorNumber || selectedLocations.has(String(employee.home_location_id || "")))
    && (!query || `${employee.personnel_number} ${employee.full_name} ${employee.nickname}`.toLocaleLowerCase("de").includes(query)));
  const rows = existing.map((employee) => {
    const number = employee.personnel_number;
    const creator = number === creatorNumber;
    const selected = creator || state.usbProvisioning.selectedEmployees.has(number);
    const override = state.usbProvisioning.employeeOverrides.get(number) || {};
    const role = creator ? "admin" : (override.role || employee.portal_access?.role || "employee");
    return `<article class="usb-team-row" data-usb-employee="${escapeHtml(number)}" data-usb-source="${escapeHtml(number)}">
      <label class="usb-team-identity"><input data-usb-employee-selected type="checkbox" ${selected ? "checked" : ""} ${creator ? "disabled" : ""} /><span><strong>${escapeHtml(number)} · ${escapeHtml(employee.full_name)}</strong><small>${escapeHtml(employee.nickname)} · ${escapeHtml(employee.home_location_name || employee.home_location_id || "")}</small></span></label>
      <select data-usb-role ${creator ? "disabled" : ""}>${creator ? '<option value="admin" selected>Admin</option>' : usbRoleOptions(role, { departmentId: employee.preferred_department_id })}</select>
      <input data-usb-start-password type="password" minlength="6" autocomplete="new-password" value="${escapeHtml(override.startPassword || "")}" placeholder="Startpasswort optional" ${creator ? "disabled" : ""} />
      ${creator ? '<span class="status-badge">Admin · Pflicht</span>' : `<details><summary>Zusatzrechte</summary><div class="usb-rights-grid">${usbPermissionOptions(override.additionalPermissions || employee.portal_access?.grantedPermissions || [])}</div></details>`}
    </article>`;
  });
  const draftRows = state.usbProvisioning.employeeDrafts.filter((draft) => selectedLocations.has(String(draft.homeLocationId || ""))
    && (!query || `${draft.personnelNumber} ${draft.fullName} ${draft.nickname}`.toLocaleLowerCase("de").includes(query))).map((draft) => {
    const override = state.usbProvisioning.employeeOverrides.get(draft.personnelNumber) || {};
    const selected = state.usbProvisioning.selectedEmployees.has(draft.personnelNumber);
    return `<article class="usb-team-row" data-usb-employee="${escapeHtml(draft.personnelNumber)}" data-usb-draft="1">
    <label class="usb-team-identity"><input data-usb-employee-selected type="checkbox" ${selected ? "checked" : ""} /><span><strong>${escapeHtml(draft.personnelNumber)} · ${escapeHtml(draft.fullName)}</strong><small>${escapeHtml(draft.nickname)} · nur Zielstick</small></span></label>
    <select data-usb-role>${usbRoleOptions(override.role || draft.role, { departmentId: draft.preferredDepartmentId })}</select>
    <input data-usb-start-password type="password" minlength="6" autocomplete="new-password" value="${escapeHtml(override.startPassword ?? draft.startPassword ?? "")}" placeholder="Startpasswort optional" />
    <div class="usb-draft-actions"><details><summary>Zusatzrechte</summary><div class="usb-rights-grid">${usbPermissionOptions(override.additionalPermissions || draft.additionalPermissions || [])}</div></details><button type="button" class="text-action" data-usb-edit-draft="${escapeHtml(draft.personnelNumber)}">Bearbeiten</button><button type="button" class="text-action danger-text" data-usb-remove-draft="${escapeHtml(draft.personnelNumber)}">Entfernen</button></div>
  </article>`;
  });
  elements.usbEmployeeSelection.innerHTML = [...rows, ...draftRows].join("") || '<p class="settings-note">Keine Teammitglieder gefunden.</p>';
}

function renderUsbDrives() {
  const drives = state.usbProvisioning.metadata?.drives || [];
  elements.usbDriveList.innerHTML = drives.map((drive) => `<label class="usb-drive-option ${drive.token === state.usbProvisioning.selectedDriveToken ? "selected" : ""}"><input type="radio" name="usbDrive" value="${escapeHtml(drive.token)}" ${drive.token === state.usbProvisioning.selectedDriveToken ? "checked" : ""} /><span><strong>${escapeHtml(drive.driveLetter)} · ${escapeHtml(drive.model)}</strong><small>${escapeHtml(drive.label || "Ohne Laufwerksname")} · ${escapeHtml(drive.fileSystem || "unbekannt")}</small></span><span>${formatUsbSize(drive.sizeBytes)}</span></label>`).join("")
    || `<p class="settings-note">${escapeHtml(state.usbProvisioning.metadata?.driveWarning || "Kein geeigneter USB-Wechseldatenträger erkannt.")}</p>`;
}

function updateUsbSummary() {
  if (!elements.usbProvisioningSummary) return;
  const drive = currentUsbDrive();
  const features = selectedUsbFeatures().length;
  const locations = selectedUsbLocationIds().length;
  const employees = state.usbProvisioning.selectedEmployees.size;
  const branding = elements.usbPrimaryBranding.selectedOptions?.[0]?.textContent || "nicht gewählt";
  elements.usbProvisioningSummary.innerHTML = `<p><strong>${escapeHtml(elements.usbInstallationName.value.trim() || "Neue Grabenplaner-Installation")}</strong></p><p>Zielbetrieb: Lokal · ${features} Funktionsbereiche · ${locations} Standorte · ${employees} Teammitglieder · ${escapeHtml(branding)}${drive ? ` · Ziel ${escapeHtml(drive.driveLetter)}` : ""}</p>`;
  const expected = drive?.expectedConfirmation || "FORMATIEREN X:";
  elements.usbFormatConfirmation.placeholder = expected;
  elements.usbFormatConfirmationHint.textContent = drive ? `Alle vorhandenen Daten auf ${drive.driveLetter} werden gelöscht. Exakt „${expected}“ eingeben.` : "Zuerst einen geeigneten USB-Stick auswählen.";
  const valid = Boolean(drive && elements.usbCreatorEmployee.value && elements.usbCreatorPassword.value
    && locations > 0 && elements.usbFormatConfirmation.value.trim() === expected);
  elements.usbProvisioningStartButton.disabled = !valid;
}

async function loadUsbProvisioning() {
  const availability = state.portalStatus?.usbProvisioning || {};
  if (availability.available !== true) {
    renderUsbAvailability(availability);
    return;
  }
  const firstLoad = !state.usbProvisioning.metadata;
  const metadata = await api("/api/usb-provisioning/status", {
    headers: { "X-Grabenplaner-USB-Action": "provisioning" },
  });
  state.usbProvisioning.metadata = metadata;
  renderUsbAvailability(metadata);
  if (!metadata.available) return;
  elements.usbWizardDraftStatus.textContent = "Entwurf bereit";
  elements.usbWizardDraftStatus.classList.remove("inactive");
  renderUsbCreators();
  renderUsbBrandings();
  renderUsbLocations();
  if (firstLoad) {
    for (const employee of state.allEmployees.filter((item) => item.active)) state.usbProvisioning.selectedEmployees.add(employee.personnel_number);
  }
  renderUsbEmployees();
  renderUsbDrives();
  if (firstLoad) applyUsbProfile(elements.usbInstallationProfile.value);
  updateUsbSummary();
}

async function refreshUsbDrives() {
  if (!state.usbProvisioning.metadata?.available) return;
  elements.usbRefreshDrivesButton.disabled = true;
  try {
    const result = await api("/api/usb-provisioning/drives", {
      headers: { "X-Grabenplaner-USB-Action": "provisioning" },
    });
    state.usbProvisioning.metadata = { ...state.usbProvisioning.metadata, ...result };
    if (!result.drives.some((drive) => drive.token === state.usbProvisioning.selectedDriveToken)) state.usbProvisioning.selectedDriveToken = "";
    renderUsbDrives();
    updateUsbSummary();
  } finally { elements.usbRefreshDrivesButton.disabled = false; }
}

function usbFirstStepsPayload() {
  return {
    title: elements.usbGuideTitle.value,
    introduction: elements.usbGuideIntroduction.value,
    notes: elements.usbGuideNotes.value,
    contact: elements.usbGuideContact.value,
    includeStartup: elements.usbGuideIncludeStartup.checked,
    includeModules: elements.usbGuideIncludeModules.checked,
    includePdf: elements.usbGuideIncludePdf.checked,
    includeBackup: elements.usbGuideIncludeBackup.checked,
  };
}

function selectedUsbAdditionalBrandings() {
  return [...elements.usbAdditionalBrandings.querySelectorAll("input:checked")].map((input) => input.value);
}

function usbBasePayload() {
  return {
    profile: elements.usbInstallationProfile.value,
    enabledFeatures: selectedUsbFeatures(),
    installationName: elements.usbInstallationName.value,
    primaryBrandingKitId: elements.usbPrimaryBranding.value || "neutral",
    additionalBrandingKitIds: selectedUsbAdditionalBrandings(),
    selectedLocationIds: selectedUsbLocationIds(),
    firstSteps: usbFirstStepsPayload(),
  };
}

async function previewUsbFirstSteps() {
  elements.usbGuidePreviewButton.disabled = true;
  try {
    const response = await fetch("/api/usb-provisioning/first-steps.pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Grabenplaner-USB-Action": "provisioning", ...csrfHeader() },
      body: JSON.stringify(usbBasePayload()),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || "Die PDF-Vorschau konnte nicht erstellt werden.");
    }
    const url = URL.createObjectURL(await response.blob());
    const old = elements.usbGuidePreviewFrame.dataset.objectUrl;
    elements.usbGuidePreviewFrame.src = url;
    elements.usbGuidePreviewFrame.dataset.objectUrl = url;
    if (old) URL.revokeObjectURL(old);
  } finally { elements.usbGuidePreviewButton.disabled = false; }
}

async function importUsbBranding() {
  const file = elements.usbBrandingImportFile.files?.[0];
  if (!file) throw new Error("Bitte zuerst ein Branding-Kit auswählen.");
  const response = await fetch("/api/usb-provisioning/branding/import", {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "X-Branding-Filename": encodeURIComponent(file.name), "X-Grabenplaner-USB-Action": "provisioning", ...csrfHeader() },
    body: await file.arrayBuffer(),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Branding-Kit konnte nicht importiert werden.");
  state.brandingKits = result.kits || state.brandingKits;
  renderUsbBrandings();
  showToast("Branding-Kit wurde für die Auswahl installiert, ohne das aktuelle Erscheinungsbild zu ändern.");
}

function collectUsbEmployees() {
  return [...elements.usbEmployeeSelection.querySelectorAll("[data-usb-employee]")].filter((row) => row.querySelector("[data-usb-employee-selected]")?.checked).map((row) => {
    const personnelNumber = row.dataset.usbEmployee;
    const draft = state.usbProvisioning.employeeDrafts.find((item) => item.personnelNumber === personnelNumber);
    return {
      ...(draft || {}),
      personnelNumber,
      sourcePersonnelNumber: row.dataset.usbSource || "",
      role: row.querySelector("[data-usb-role]")?.value || "employee",
      startPassword: row.querySelector("[data-usb-start-password]")?.value || "",
      additionalPermissions: [...row.querySelectorAll(".usb-rights-grid input:checked")].map((input) => input.value),
    };
  });
}

function setUsbProgress(percent, title, text) {
  elements.usbProvisioningProgressPanel.classList.remove("hidden");
  elements.usbProvisioningProgressPercent.textContent = `${percent} %`;
  elements.usbProvisioningProgressTrack.setAttribute("aria-valuenow", String(percent));
  elements.usbProvisioningProgressTrack.querySelector("span").style.width = `${percent}%`;
  elements.usbProvisioningProgressTitle.textContent = title;
  elements.usbProvisioningProgressText.textContent = text;
  elements.usbWizardDraftStatus.textContent = percent >= 100 ? "Erstellt" : percent > 0 ? "In Arbeit" : "Fehler";
  elements.usbWizardDraftStatus.classList.toggle("inactive", percent <= 0);
}

async function createUsbStick() {
  const drive = currentUsbDrive();
  if (!drive) return;
  if (!confirm(`${drive.driveLetter} (${drive.model}, ${formatUsbSize(drive.sizeBytes)}) wird vollständig formatiert. Alle vorhandenen Daten werden unwiderruflich gelöscht. Fortfahren?`)) return;
  captureUsbEmployeeRows();
  elements.usbEmployeeSearch.value = "";
  renderUsbEmployees();
  elements.usbProvisioningStartButton.disabled = true;
  elements.usbWizardActions.classList.add("hidden");
  elements.usbProvisioningResultPanel.classList.add("hidden");
  elements.usbProvisioningProgressSteps.innerHTML = ["Paket", "Datenbank", "Branding", "PDF", "Formatierung", "Kopie", "Prüfung"].map((step) => `<span>${step}</span>`).join("");
  setUsbProgress(12, "Installation wird vorbereitet", "Die Ziel-Datenbank, Brandings und Dokumentation werden vollständig vor der Formatierung erstellt.");
  const progressTimer = setTimeout(() => setUsbProgress(42, "Vorbereitung geprüft", "Der USB-Stick wird nun von Windows formatiert und anschließend beschrieben."), 1800);
  try {
    const response = await fetch("/api/usb-provisioning/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Grabenplaner-USB-Action": "provisioning", ...csrfHeader() },
      body: JSON.stringify({
        ...usbBasePayload(),
        creatorEmployeeNumber: elements.usbCreatorEmployee.value,
        creatorPassword: elements.usbCreatorPassword.value,
        employees: collectUsbEmployees(),
        selectionToken: drive.token,
        confirmation: elements.usbFormatConfirmation.value,
        hideProgramFolder: elements.usbHideProgramFolder.checked,
        protectProgramFiles: elements.usbProtectProgramFiles.checked,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Der USB-Stick konnte nicht erstellt werden.");
    setUsbProgress(100, "USB-Stick geprüft", "Alle vorbereiteten Dateien wurden kopiert und mit SHA-256 überprüft.");
    elements.usbProvisioningResultPanel.classList.remove("hidden");
    elements.usbProvisioningResultText.textContent = `${result.driveLetter} ist als Grabenplaner-Stick bereit. Das Erstellerkonto ${result.creator} wurde als Admin übernommen.`;
    elements.usbProvisioningResultDetails.innerHTML = `<span>${result.employeeCount} Teammitglieder</span><span>${result.locationCount} Standorte</span><span>${result.brandingCount} Brandings</span><span>Prüfsumme ${escapeHtml(String(result.manifestSha256 || "").slice(0, 12))}…</span>`;
    elements.usbCreatorPassword.value = "";
    elements.usbFormatConfirmation.value = "";
    state.usbProvisioning.selectedDriveToken = "";
    showToast("Der USB-Stick wurde sicher erstellt und geprüft.");
  } finally {
    clearTimeout(progressTimer);
    elements.usbWizardActions.classList.remove("hidden");
    updateUsbSummary();
  }
}

function openUsbEmployeeDraft(personnelNumber = "") {
  elements.usbEmployeeDraftForm.reset();
  const draft = state.usbProvisioning.employeeDrafts.find((item) => item.personnelNumber === personnelNumber) || null;
  const draftOverride = draft ? (state.usbProvisioning.employeeOverrides.get(draft.personnelNumber) || {}) : {};
  elements.usbEmployeeDraftForm.dataset.editNumber = draft?.personnelNumber || "";
  elements.usbDraftPersonnelNumber.disabled = Boolean(draft);
  elements.usbDraftColor.value = "#0b84c6";
  elements.usbDraftContractedHours.value = "38.5";
  elements.usbDraftPosition.innerHTML = state.positions.map((position) => `<option value="${escapeHtml(position.id)}">${escapeHtml(position.name)}</option>`).join("");
  const selectedLocations = new Set(selectedUsbLocationIds());
  elements.usbDraftLocation.innerHTML = (state.locations || []).filter((location) => location.active && selectedLocations.has(location.id)).map((location) => `<option value="${escapeHtml(location.id)}">${escapeHtml(location.id)} · ${escapeHtml(location.name)}</option>`).join("");
  if (draft) {
    elements.usbDraftPersonnelNumber.value = draft.personnelNumber;
    elements.usbDraftFullName.value = draft.fullName;
    elements.usbDraftNickname.value = draft.nickname;
    elements.usbDraftColor.value = draft.color;
    elements.usbDraftContractedHours.value = String(draft.contractedHours);
    elements.usbDraftPosition.value = draft.positionId;
    elements.usbDraftLocation.value = draft.homeLocationId;
    elements.usbDraftPassword.value = draftOverride.startPassword ?? draft.startPassword ?? "";
  }
  updateUsbDraftDepartments();
  if (draft?.preferredDepartmentId) elements.usbDraftDepartment.value = String(draft.preferredDepartmentId);
  updateUsbDraftRoleOptions(draftOverride.role || draft?.role || "employee");
  elements.usbEmployeeDraftModal.showModal();
}

function updateUsbDraftDepartments() {
  const departments = departmentsForLocation(elements.usbDraftLocation.value);
  elements.usbDraftDepartment.innerHTML = `<option value="">Keine Abteilung</option>${departments.map((department) => `<option value="${department.id}">${escapeHtml(department.name)}</option>`).join("")}`;
}

function updateUsbDraftRoleOptions(preferredRole = elements.usbDraftRole.value || "employee") {
  elements.usbDraftRole.innerHTML = usbRoleOptions(preferredRole, { departmentId: elements.usbDraftDepartment.value });
}

function saveUsbEmployeeDraft(event) {
  event.preventDefault();
  const editNumber = elements.usbEmployeeDraftForm.dataset.editNumber || "";
  const draft = {
    personnelNumber: elements.usbDraftPersonnelNumber.value.trim(),
    fullName: elements.usbDraftFullName.value.trim(),
    nickname: elements.usbDraftNickname.value.trim(),
    color: elements.usbDraftColor.value,
    contractedHours: Number(elements.usbDraftContractedHours.value),
    positionId: elements.usbDraftPosition.value,
    homeLocationId: elements.usbDraftLocation.value,
    preferredDepartmentId: Number(elements.usbDraftDepartment.value || 0) || null,
    role: elements.usbDraftRole.value,
    startPassword: elements.usbDraftPassword.value,
    additionalPermissions: [],
  };
  if (!/^\d{1,12}$/.test(draft.personnelNumber) || !draft.fullName || !draft.nickname) {
    showToast("Bitte Personalnummer, Namen und Spitznamen vollständig eingeben.", true);
    return;
  }
  if (draft.role === "department_manager" && !draft.preferredDepartmentId) {
    showToast("Für eine Abteilungsleitung muss eine Abteilung ausgewählt sein.", true);
    return;
  }
  if (state.allEmployees.some((employee) => employee.personnel_number === draft.personnelNumber)
    || state.usbProvisioning.employeeDrafts.some((employee) => employee.personnelNumber === draft.personnelNumber && employee.personnelNumber !== editNumber)) {
    showToast("Diese Personalnummer ist bereits vorhanden.", true);
    return;
  }
  if (editNumber) {
    const index = state.usbProvisioning.employeeDrafts.findIndex((employee) => employee.personnelNumber === editNumber);
    if (index >= 0) state.usbProvisioning.employeeDrafts[index] = draft;
  } else {
    state.usbProvisioning.employeeDrafts.push(draft);
  }
  state.usbProvisioning.employeeOverrides.set(draft.personnelNumber, {
    role: draft.role,
    startPassword: draft.startPassword,
    additionalPermissions: state.usbProvisioning.employeeOverrides.get(draft.personnelNumber)?.additionalPermissions || [],
  });
  state.usbProvisioning.selectedEmployees.add(draft.personnelNumber);
  elements.usbEmployeeDraftModal.close();
  renderUsbEmployees();
  updateUsbSummary();
}

function removeUsbEmployeeDraft(personnelNumber) {
  state.usbProvisioning.employeeDrafts = state.usbProvisioning.employeeDrafts
    .filter((employee) => employee.personnelNumber !== personnelNumber);
  state.usbProvisioning.selectedEmployees.delete(personnelNumber);
  state.usbProvisioning.employeeOverrides.delete(personnelNumber);
  renderUsbEmployees();
  updateUsbSummary();
}

async function saveCustomManagementBranding() {
  const result = await api("/api/branding/preference", {
    method: "PUT",
    body: JSON.stringify({
      kitId: "custom",
      branding: {
        companyName: elements.brandingCompanyName.value,
        logoUrl: elements.brandingLogoUrl.value,
        iconUrl: elements.brandingIconUrl.value,
        logoAlt: elements.brandingLogoAlt.value,
        adminEmail: elements.brandingAdminEmail.value,
      },
    }),
  });
  updateManagementBrandingPreference(result);
}

async function saveOperationMode() {
  const operationMode = state.desiredOperationMode || state.portalStatus?.operationMode || "local";
  try {
    const result = await api("/api/operation-mode", {
      method: "PUT",
      body: JSON.stringify({ operationMode }),
    });
    if (!result.restartRequired) {
      showToast("Der Betriebsmodus wurde gespeichert.");
      return;
    }
    const modeText = operationMode === "lan" ? "LAN-Host" : operationMode === "server" ? "Serverbetrieb" : "Lokalbetrieb";
    if (!confirm(`Der Wechsel auf ${modeText} erfordert einen sicheren Neustart. Jetzt neu starten?`)) return;
    await api("/api/system/restart", { method: "POST", body: "{}" });
    document.body.innerHTML = '<main class="shutdown-screen"><h1>Grabenplaner startet neu.</h1><p>Diese Seite kann in wenigen Sekunden neu geladen werden.</p></main>';
    setTimeout(() => window.location.reload(), 6000);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function saveSettings(silent = false) {
  try {
    const permissions = state.portalSession?.user?.permissions || [];
    const role = state.portalSession?.user?.role || "admin";
    const portalEnabled = state.portalStatus?.portalEnabled === true;
    const payload = {
        locationId: state.locationId,
        departmentId: state.departmentId || "",
        pdfTitle: document.querySelector("#pdfTitleSetting").value,
        pdfFilenamePrefix: document.querySelector("#pdfFilenamePrefix").value,
        pdfFilenameIncludeKw: document.querySelector("#pdfFilenameIncludeKw").checked,
        pdfFilenameIncludeTimestamp: document.querySelector("#pdfFilenameIncludeTimestamp").checked,
        vacationPdfTitle: document.querySelector("#vacationPdfTitleSetting").value,
        vacationPdfFilenamePrefix: document.querySelector("#vacationPdfFilenamePrefix").value,
        vacationPdfFilenameIncludePeriod: document.querySelector("#vacationPdfFilenameIncludePeriod").checked,
        vacationPdfFilenameIncludeTimestamp: document.querySelector("#vacationPdfFilenameIncludeTimestamp").checked,
        vacationPdfShowBalance: document.querySelector("#vacationPdfShowBalance").checked,
        vacationPdfBalanceShowEntitlement: document.querySelector("#vacationPdfBalanceShowEntitlement").checked,
        vacationPdfBalanceShowPlanned: document.querySelector("#vacationPdfBalanceShowPlanned").checked,
        vacationPdfBalanceShowConsumed: document.querySelector("#vacationPdfBalanceShowConsumed").checked,
        vacationPdfCalendarStyle: document.querySelector("#vacationPdfCalendarStyle").value,
        toastDuration: document.querySelector("#toastDuration").value,
        showInactivePersonnel: document.querySelector("#showInactivePersonnel").checked,
        showSaturdayServiceStats: document.querySelector("#showSaturdayServiceStats").checked,
        externalBackupEnabled: document.querySelector("#externalBackupEnabled").checked,
        backupDirectory: document.querySelector("#backupDirectory").value,
        backupIntervalHours: Number(document.querySelector("#backupIntervalHours").value),
        vacationCountSaturday: document.querySelector("#vacationCountSaturday").checked,
        allowPastWeekEditing: document.querySelector("#allowPastWeekEditing").checked,
        currentWeekAutoLock: elements.currentWeekAutoLock.checked,
        currentWeekLockMode: elements.currentWeekLockMode.value,
        currentWeekLockDay: elements.currentWeekLockDay.value,
        currentWeekLockTime: elements.currentWeekLockTime.value,
        breakRuleEnabled: document.querySelector("#breakRuleEnabled").checked,
        breakAfterMinutes: Math.round(Number(document.querySelector("#breakAfterHours").value) * 60),
        breakDurationMinutes: Number(document.querySelector("#breakDuration").value),
        saturdayBonusEnabled: document.querySelector("#saturdayBonusEnabled").checked,
        saturdayBonusFrom: document.querySelector("#saturdayBonusFrom").value,
        saturdayBonusFactor: Number(document.querySelector("#saturdayBonusFactor").value),
        showSunday: document.querySelector("#showSunday").checked,
    };
    if (!portalEnabled || permissions.includes("operation_mode:write")) {
      payload.operationMode = state.desiredOperationMode || state.portalStatus?.operationMode || "local";
    }
    const result = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    if ((!portalEnabled || permissions.includes("branding:write")) && elements.brandingSettings?.classList.contains("active") && state.brandingFormDirty) {
      await saveCustomManagementBranding();
    }
    if (result.restartRequired && !silent) {
      const modeText = state.desiredOperationMode === "lan" ? "LAN-Host" : state.desiredOperationMode === "server" ? "Serverbetrieb" : "Lokalbetrieb";
      if (confirm(`Die Einstellungen wurden gespeichert. Für den Wechsel auf ${modeText} muss Grabenplaner sicher neu starten. Jetzt neu starten?`)) {
        await api("/api/system/restart", { method: "POST", body: "{}" });
        document.body.innerHTML = '<main class="shutdown-screen"><h1>Grabenplaner startet neu.</h1><p>Diese Seite kann in wenigen Sekunden neu geladen werden.</p></main>';
        setTimeout(() => window.location.reload(), 6000);
        return true;
      }
    }
    if (!silent) showToast("Einstellungen wurden gespeichert.");
    await loadAll();
    return true;
  } catch (error) {
    showToast(error.message, true);
    return false;
  }
}

async function deleteEmployee() {
  const number = document.querySelector("#employeeNumber").value;
  if (!number || !confirm("Teammitglied und alle zugehörigen Dienste wirklich löschen?")) return;
  try {
    await api(`/api/employees/${encodeURIComponent(number)}`, { method: "DELETE" });
    elements.employeeModal.close();
    showToast("Teammitglied wurde gelöscht.");
    await loadAll();
  } catch (error) { showToast(error.message, true); }
}

async function deleteShift() {
  const id = document.querySelector("#shiftId").value;
  if (!id || !confirm("Diesen Dienst wirklich löschen?")) return;
  try {
    await api(`/api/shifts/${id}`, { method: "DELETE" });
    elements.shiftModal.close();
    showToast("Dienst wurde gelöscht.");
    await loadAll();
  } catch (error) { showToast(error.message, true); }
}

function updatePdfPreview() {
  const title = document.querySelector("#pdfTitleSetting").value || "Dienstplan";
  const prefix = (document.querySelector("#pdfFilenamePrefix").value || "Dienstplan").trim();
  const filenameParts = [prefix || "Dienstplan"];
  const now = new Date();
  if (document.querySelector("#pdfFilenameIncludeKw").checked) filenameParts.push(`KW${state.data?.calendarWeek || ""}`);
  if (document.querySelector("#pdfFilenameIncludeTimestamp").checked) {
    filenameParts.push(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`);
  }
  document.querySelector("#pdfTitlePreview").textContent = `${title} · Woche ab ${formatDate(state.weekStart)} · KW ${state.data?.calendarWeek || ""}`;
  document.querySelector("#pdfFilenamePreview").textContent = `${filenameParts.join(" ")}.pdf`;

  const vacationRange = selectedVacationRange();
  const vacationTitle = document.querySelector("#vacationPdfTitleSetting").value || "Urlaubsplanung";
  const vacationPrefix = (document.querySelector("#vacationPdfFilenamePrefix").value || "Urlaubsplanung").trim();
  const vacationFilenameParts = [vacationPrefix || "Urlaubsplanung"];
  if (document.querySelector("#vacationPdfFilenameIncludePeriod").checked) {
    vacationFilenameParts.push(state.vacationViewMode === "year" ? `Jahr ${state.vacationYear}` : vacationRange.label);
  }
  if (document.querySelector("#vacationPdfFilenameIncludeTimestamp").checked) {
    vacationFilenameParts.push(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`);
  }
  document.querySelector("#vacationPdfTitlePreview").textContent = `${vacationTitle} · ${vacationRange.label}`;
  document.querySelector("#vacationPdfFilenamePreview").textContent = `${vacationFilenameParts.join(" ")}.pdf`;
  if (elements.vacationLayoutPreview) {
    const style = document.querySelector("#vacationPdfCalendarStyle")?.value || "bars";
    elements.vacationLayoutPreview.classList.toggle("dots", style === "dots");
    elements.vacationLayoutPreview.classList.toggle("bars", style !== "dots");
  }
}

async function generateSchedulePdfPreview() {
  const saved = await saveSettings(true);
  if (!saved) return;
  elements.schedulePdfPreviewFrame.src = `/api/schedule-preview.pdf?week=${state.weekStart}${contextQuery(true)}&t=${Date.now()}`;
  showToast("Dienstplan-PDF-Vorschau wurde erzeugt.");
}

async function generateVacationPdfPreview() {
  const saved = await saveSettings(true);
  if (!saved) return;
  const range = selectedVacationRange();
  const parameters = new URLSearchParams({
    year: String(state.vacationYear),
    view: state.vacationViewMode,
    quarter: String(state.vacationQuarter),
    month: String(state.vacationMonth),
    location: state.locationId || "",
    t: String(Date.now()),
  });
  elements.vacationPdfPreviewFrame.src = `/api/vacations-preview.pdf?${parameters.toString()}`;
  showToast(`Urlaubs-PDF-Vorschau ${range.label} wurde erzeugt.`);
}

let toastTimer;
function showToast(message, error = false) {
  clearTimeout(toastTimer);
  const openDialog = document.querySelector("dialog[open]");
  (openDialog || document.body).appendChild(elements.toast);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.add("visible");
  const duration = { short: 5000, medium: 10000, long: 15000 }[state.data?.settings?.toast_duration || "medium"] || 10000;
  toastTimer = setTimeout(() => {
    elements.toast.classList.remove("visible");
    document.body.appendChild(elements.toast);
  }, duration);
}

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
elements.adminLoginForm?.addEventListener("submit", loginToAdministration);
elements.adminLoginPersonnelNumber?.addEventListener("input", scheduleAdminLoginBrandingPreview);
elements.adminLoginPersonnelNumber?.addEventListener("blur", previewAdminLoginBranding);
elements.portalLogoutButton?.addEventListener("click", logoutPortal);
elements.localModeOption?.addEventListener("click", () => {
  state.desiredOperationMode = "local";
  renderOperationMode();
});
elements.serverModeOption?.addEventListener("click", () => {
  if (state.portalStatus?.adminSetupState !== "configured") {
    setSettingsTab("access");
    openAdminSetup();
    return;
  }
  state.desiredOperationMode = "lan";
  renderOperationMode();
});
elements.publicServerModeOption?.addEventListener("click", () => {
  if (state.portalStatus?.operationMode === "server") return;
  showToast("Der Serverbetrieb wird aus Sicherheitsgründen ausschließlich über die geschützte Serverkonfiguration aktiviert.");
});
elements.refreshServerDiagnosticsButton?.addEventListener("click", refreshServerDiagnostics);
elements.currentWeekAutoLock?.addEventListener("change", updateWeekLockSettings);
elements.currentWeekLockMode?.addEventListener("change", updateWeekLockSettings);
elements.currentWeekLockDay?.addEventListener("change", updateWeekLockSettings);
elements.saveOperationModeButton?.addEventListener("click", saveOperationMode);
elements.adminSetupButton?.addEventListener("click", openAdminSetup);
elements.adminSetupForm?.addEventListener("submit", setupPortalAdmin);
elements.portalUserList?.addEventListener("click", (event) => {
  const row = event.target.closest("[data-portal-user]");
  if (!row) return;
  if (event.target.closest("[data-save-portal-user]")) savePortalUser(row);
  if (event.target.closest("[data-unlock-portal-user]")) unlockPortalUser(row);
});
elements.portalUserList?.addEventListener("change", (event) => {
  const row = event.target.closest("[data-portal-user]");
  if (!row) return;
  const role = row.querySelector("[data-portal-role]").value;
  row.querySelector("[data-scope-location]").classList.toggle("hidden", !["manager", "department_manager"].includes(role));
  row.querySelector("[data-scope-department]").classList.toggle("hidden", role !== "department_manager");
  if (event.target.matches("[data-scope-location]")) {
    const departments = state.locations.find((location) => location.id === event.target.value)?.departments || [];
    row.querySelector("[data-scope-department]").innerHTML = departments.map((department) => `<option value="${department.id}">${escapeHtml(department.name)}</option>`).join("");
  }
});
elements.delegationLocation?.addEventListener("change", refreshDelegationEmployees);
elements.delegationForm?.addEventListener("submit", saveApprovalDelegation);
elements.delegationList?.addEventListener("click", async (event) => {
  const row = event.target.closest("[data-delegation-id]");
  if (!row || !event.target.closest("[data-delete-delegation]") || !confirm("Diese Vertretung wirklich löschen?")) return;
  try { await api(`/api/portal/v1/approval-delegations/${row.dataset.delegationId}`, { method: "DELETE" }); await loadApprovalDelegations(); } catch (error) { showToast(error.message, true); }
});
elements.refreshRequestsButton?.addEventListener("click", loadManagerVacationRequests);
elements.refreshTimePresenceButton?.addEventListener("click", () => Promise.all([loadTimePresence(), loadTimeDayReview(), loadTimeSummary(), loadTimeCorrections()]));
elements.loadTimeDayReviewButton?.addEventListener("click", loadTimeDayReview);
elements.timeReviewFilter?.addEventListener("change", renderTimeDayReview);
elements.loadTimeSummaryButton?.addEventListener("click", loadTimeSummary);
elements.timeTrackingLocation?.addEventListener("change", () => {
  refreshTimePresenceDepartments();
  Promise.all([loadTimePresence(), loadTimeDayReview(), loadTimeSummary(), loadTimeCorrections()]);
});
elements.timeTrackingDepartment?.addEventListener("change", () => Promise.all([loadTimePresence(), loadTimeDayReview(), loadTimeSummary(), loadTimeCorrections()]));
elements.timeDayReviewList?.addEventListener("click", (event) => {
  const row = event.target.closest("[data-time-day-employee]");
  if (row && event.target.closest("[data-open-time-day-review]")) openTimeDayReview(row.dataset.timeDayEmployee);
});
elements.timeDayReviewForm?.addEventListener("submit", (event) => { event.preventDefault(); saveTimeDayReview(true); });
elements.removeTimeDayReviewButton?.addEventListener("click", () => saveTimeDayReview(false));
elements.timeCorrectionRequestList?.addEventListener("click", (event) => {
  const row = event.target.closest("[data-time-correction-request]");
  if (row && event.target.closest("[data-review-time-correction]")) openTimeCorrectionReview(row.dataset.timeCorrectionRequest);
});
elements.timeCorrectionReviewForm?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-time-correction-decision]");
  if (button) decideTimeCorrection(button.dataset.timeCorrectionDecision);
});
elements.addTimeCorrectionReviewEntry?.addEventListener("click", addTimeCorrectionReviewEntry);
elements.timeCorrectionReviewEntries?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-time-correction-entry]");
  if (!button) return;
  const rows = elements.timeCorrectionReviewEntries.querySelectorAll(".time-correction-entry-row");
  if (rows.length <= 2) {
    showToast("Eine vollständige Korrektur benötigt mindestens Kommen und Gehen.", true);
    return;
  }
  button.closest(".time-correction-entry-row")?.remove();
});
elements.timePresenceList?.addEventListener("click", (event) => {
  const correctionButton = event.target.closest("[data-resolve-stale]");
  if (correctionButton) {
    openStaleTimeCorrection(correctionButton.dataset.resolveStale);
    return;
  }
  const button = event.target.closest("[data-personnel-record]");
  if (button) openPersonnelRecord(button.dataset.personnelRecord);
});
elements.timeCorrectionForm?.addEventListener("submit", submitStaleTimeCorrection);
elements.locationTimeTrackingAccessMode?.addEventListener("change", syncLocationTimeTrackingFields);
elements.managerVacationRequestList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-request-action]");
  const row = button?.closest("[data-manager-request]");
  if (button && row) openRequestAction(row.dataset.managerRequest, row.dataset.requestKind);
  const amuButton = event.target.closest("[data-open-amu-action]");
  const amuRow = amuButton?.closest("[data-amu-report]");
  if (amuButton && amuRow) openAmuAction(amuRow.dataset.amuReport);
});
document.querySelectorAll("[data-request-kind-tab]").forEach((button) => button.addEventListener("click", () => {
  state.requestKindTab = button.dataset.requestKindTab;
  if (state.requestKindTab === "amu" && !["actionable", "all"].includes(elements.requestStatusFilter.value)) elements.requestStatusFilter.value = "actionable";
  document.querySelectorAll("[data-request-kind-tab]").forEach((item) => item.classList.toggle("active", item === button));
  renderManagerRequests();
}));
elements.requestStatusFilter?.addEventListener("change", renderManagerRequests);
elements.requestWorkflowSummary?.addEventListener("click", (event) => {
  if (event.target.closest("[data-toggle-hr-workflow]")) toggleHrWorkflow(!state.workflowSettings?.vacationHrApprovalRequired);
});
elements.vacationHrApprovalRequired?.addEventListener("change", (event) => toggleHrWorkflow(event.target.checked));
elements.saveAmuSettingsButton?.addEventListener("click", saveAmuSettings);
elements.saveGreetingSettingsButton?.addEventListener("click", saveGreetingSettings);
elements.rightsEmployeeSearch?.addEventListener("input", renderRightsManagement);
elements.rightsUserList?.addEventListener("click", (event) => {
  const card = event.target.closest("[data-rights-user]");
  if (card && event.target.closest("[data-edit-user-rights]")) openRightsEditor(card.dataset.rightsUser);
});
elements.rightsEditorForm?.addEventListener("submit", saveUserRights);
elements.saveMobileLeadershipSettingsButton?.addEventListener("click", saveMobileLeadershipSettings);
elements.requestActionForm?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-request-action]");
  if (button) decideVacationRequest(button.dataset.requestAction);
  const amuButton = event.target.closest("[data-amu-action]");
  if (amuButton) reviewAmu(amuButton.dataset.amuAction);
});
elements.requestBlackoutForm?.addEventListener("submit", saveRequestBlackout);
elements.addRequestBlackoutButton?.addEventListener("click", () => { resetRequestBlackoutForm(); elements.requestBlackoutForm.classList.remove("hidden"); });
elements.requestBlackoutLocation?.addEventListener("change", () => refreshRequestBlackoutDepartments());
elements.cancelRequestBlackoutEdit?.addEventListener("click", resetRequestBlackoutForm);
elements.requestBlackoutList?.addEventListener("click", (event) => {
  const row = event.target.closest("[data-request-blackout]");
  if (!row) return;
  if (event.target.closest("[data-edit-request-blackout]")) editRequestBlackout(row.dataset.requestBlackout);
  if (event.target.closest("[data-delete-request-blackout]")) deleteRequestBlackout(row.dataset.requestBlackout);
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-password-toggle]");
  if (!button) return;
  const input = document.getElementById(button.dataset.passwordToggle);
  if (!input) return;
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  button.textContent = show ? "Verbergen" : "Anzeigen";
  button.setAttribute("aria-label", show ? "Passwort verbergen" : "Passwort anzeigen");
});
elements.updateCheckButton?.addEventListener("click", handleUpdateButton);
elements.systemExitButton?.addEventListener("click", exitApplication);
elements.exportBrandingButton?.addEventListener("click", exportBrandingKit);
elements.importBrandingButton?.addEventListener("click", importBrandingKit);
["brandingCompanyName", "brandingAdminEmail", "brandingLogoUrl", "brandingIconUrl", "brandingLogoAlt"].forEach((id) => {
  elements[id]?.addEventListener("input", () => {
    state.brandingFormDirty = true;
    applyBranding({
      companyName: elements.brandingCompanyName.value,
      adminEmail: elements.brandingAdminEmail.value,
      logoUrl: elements.brandingLogoUrl.value,
      iconUrl: elements.brandingIconUrl.value,
      logoAlt: elements.brandingLogoAlt.value,
    });
  });
});
elements.brandingKitLibrary?.addEventListener("click", (event) => {
  const applyButton = event.target.closest("[data-apply-branding-kit]");
  if (applyButton && !applyButton.disabled) applyInstalledBrandingKit(applyButton.dataset.applyBrandingKit);
  const deleteButton = event.target.closest("[data-delete-branding-kit]");
  if (deleteButton) deleteInstalledBrandingKit(deleteButton.dataset.deleteBrandingKit, deleteButton.dataset.brandingKitName);
});
elements.brandingAssignmentList?.addEventListener("click", (event) => {
  if (event.target.closest("[data-save-branding-assignments]")) saveBrandingAssignments();
});
document.querySelectorAll("[data-usb-wizard-step]").forEach((button) => button.addEventListener("click", () => setUsbWizardStep(button.dataset.usbWizardStep)));
elements.usbWizardPreviousButton?.addEventListener("click", () => {
  const index = usbWizardSteps.indexOf(state.usbProvisioning.step);
  setUsbWizardStep(usbWizardSteps[Math.max(0, index - 1)]);
});
elements.usbWizardNextButton?.addEventListener("click", () => {
  const index = usbWizardSteps.indexOf(state.usbProvisioning.step);
  setUsbWizardStep(usbWizardSteps[Math.min(usbWizardSteps.length - 1, index + 1)]);
});
elements.usbInstallationProfile?.addEventListener("change", () => applyUsbProfile());
elements.usbModuleSelection?.addEventListener("change", (event) => {
  if (!event.target.matches('input[type="checkbox"]')) return;
  elements.usbInstallationProfile.value = "custom";
  syncUsbFeatureDependencies();
});
elements.usbInstallationName?.addEventListener("input", updateUsbSummary);
elements.usbPrimaryBranding?.addEventListener("change", () => { renderUsbBrandings(); updateUsbSummary(); });
elements.usbAdditionalBrandings?.addEventListener("change", updateUsbSummary);
elements.usbImportBrandingButton?.addEventListener("click", () => importUsbBranding().catch((error) => showToast(error.message, true)));
elements.usbCreatorEmployee?.addEventListener("change", () => {
  const previousCreator = state.usbProvisioning.creatorEmployeeNumber;
  captureUsbEmployeeRows();
  if (previousCreator && previousCreator !== elements.usbCreatorEmployee.value) {
    state.usbProvisioning.employeeOverrides.delete(previousCreator);
  }
  elements.usbCreatorPassword.value = "";
  renderUsbCreators();
  renderUsbLocations();
  synchronizeUsbTeamWithLocations();
  updateUsbSummary();
});
elements.usbCreatorPassword?.addEventListener("input", updateUsbSummary);
elements.usbLocationSelection?.addEventListener("change", (event) => {
  captureUsbEmployeeRows();
  const input = event.target.closest("[data-usb-location]");
  if (input) {
    const badge = input.closest(".usb-selection-row")?.querySelector(".status-badge");
    if (badge) { badge.textContent = input.checked ? "Dabei" : "Nicht dabei"; badge.classList.toggle("inactive", !input.checked); }
  }
  synchronizeUsbTeamWithLocations();
  updateUsbSummary();
});
elements.usbAddLocationButton?.addEventListener("click", () => { setView("personnel"); setPersonnelTab("locations"); showToast("Standorte können hier verwaltet werden. Danach zum USB-Assistenten zurückkehren."); });
elements.usbEmployeeSearch?.addEventListener("input", () => { captureUsbEmployeeRows(); renderUsbEmployees(); });
elements.usbEmployeeSelection?.addEventListener("change", () => { captureUsbEmployeeRows(); updateUsbSummary(); });
elements.usbEmployeeSelection?.addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-usb-edit-draft]");
  if (editButton) {
    captureUsbEmployeeRows();
    openUsbEmployeeDraft(editButton.dataset.usbEditDraft);
    return;
  }
  const removeButton = event.target.closest("[data-usb-remove-draft]");
  if (removeButton) removeUsbEmployeeDraft(removeButton.dataset.usbRemoveDraft);
});
elements.usbAddEmployeeButton?.addEventListener("click", () => openUsbEmployeeDraft());
elements.usbEmployeeDraftForm?.addEventListener("submit", saveUsbEmployeeDraft);
elements.usbDraftLocation?.addEventListener("change", () => {
  updateUsbDraftDepartments();
  updateUsbDraftRoleOptions();
});
elements.usbDraftDepartment?.addEventListener("change", () => updateUsbDraftRoleOptions());
elements.usbGuidePreviewButton?.addEventListener("click", () => previewUsbFirstSteps().catch((error) => showToast(error.message, true)));
elements.usbRefreshDrivesButton?.addEventListener("click", () => refreshUsbDrives().catch((error) => showToast(error.message, true)));
elements.usbDriveList?.addEventListener("change", (event) => {
  const input = event.target.closest('input[name="usbDrive"]');
  if (!input) return;
  state.usbProvisioning.selectedDriveToken = input.value;
  renderUsbDrives();
  updateUsbSummary();
});
[elements.usbFormatConfirmation, elements.usbHideProgramFolder, elements.usbProtectProgramFiles].forEach((input) => input?.addEventListener("input", updateUsbSummary));
elements.usbProvisioningStartButton?.addEventListener("click", () => createUsbStick().catch((error) => {
  setUsbProgress(0, "USB-Stick nicht erstellt", error.message);
  showToast(error.message, true);
}));
elements.openPersonnelImportButton?.addEventListener("click", () => openPersonnelImportWizard().catch((error) => showToast(error.message, true)));
elements.inspectPersonnelImportButton?.addEventListener("click", inspectPersonnelImport);
elements.personnelImportSheet?.addEventListener("change", () => {
  const sheet = selectedImportSheet();
  elements.personnelImportHeaderRow.value = sheet?.suggestedHeaderRow || 1;
  renderPersonnelImportMapping();
});
elements.personnelImportHeaderRow?.addEventListener("input", renderPersonnelImportMapping);
elements.personnelImportProfile?.addEventListener("change", () => {
  const profile = selectedImportProfile();
  const configuration = profile?.configuration || {};
  const defaults = profile?.configuration?.defaults || {};
  if (defaults.homeLocationId) elements.personnelImportDefaultLocation.value = defaults.homeLocationId;
  if (defaults.positionId) elements.personnelImportDefaultPosition.value = defaults.positionId;
  if (defaults.contractedHours !== undefined) elements.personnelImportDefaultHours.value = defaults.contractedHours;
  if (profile?.configuration?.duplicateStrategy) elements.personnelImportDuplicateStrategy.value = profile.configuration.duplicateStrategy;
  if (state.integrations.inspection) {
    if (configuration.sheetName && [...elements.personnelImportSheet.options].some((option) => option.value === configuration.sheetName)) {
      elements.personnelImportSheet.value = configuration.sheetName;
    }
    const sheet = selectedImportSheet();
    const headerRow = Number(configuration.headerRow || 0);
    elements.personnelImportHeaderRow.value = headerRow >= 1 && headerRow <= 20 ? headerRow : sheet?.suggestedHeaderRow || 1;
    renderPersonnelImportMapping();
  }
});
elements.previewPersonnelImportButton?.addEventListener("click", previewPersonnelImport);
elements.applyPersonnelImportButton?.addEventListener("click", applyPersonnelImport);
elements.resetPersonnelImportButton?.addEventListener("click", resetPersonnelImportWizard);
elements.backPersonnelImportButton?.addEventListener("click", () => returnPersonnelImportToMapping().catch((error) => setPersonnelImportMessage(error.message, true)));
elements.personnelImportModal?.addEventListener("close", () => {
  void discardPersonnelImportSessions();
  clearPersonnelImportWizard();
});
elements.savePersonnelImportProfileButton?.addEventListener("click", () => saveIntegrationProfile("import").catch((error) => showToast(error.message, true)));
[elements.importProfileList, elements.exportProfileList].forEach((list) => list?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-integration-profile]");
  if (button) deleteIntegrationProfile(button.dataset.deleteIntegrationProfile).catch((error) => showToast(error.message, true));
}));
elements.payrollProfile?.addEventListener("change", () => {
  const profile = integrationProfiles("export", "payroll").find((item) => item.id === elements.payrollProfile.value);
  applyPayrollConfiguration(profile?.configuration || {});
});
elements.payrollLocation?.addEventListener("change", () => { renderPayrollDepartments(); state.integrations.payrollPreflight = null; renderPayrollPreflight(); });
elements.payrollDepartment?.addEventListener("change", () => { state.integrations.payrollPreflight = null; renderPayrollPreflight(); });
elements.payrollLayout?.addEventListener("change", () => { renderPayrollColumns([]); state.integrations.payrollPreflight = null; renderPayrollPreflight(); });
elements.payrollFormat?.addEventListener("change", () => applyPayrollConfiguration(currentPayrollConfiguration()));
[elements.payrollDateFrom, elements.payrollDateTo, elements.payrollSourceMode, elements.payrollDelimiter, elements.payrollDecimalSeparator, elements.payrollColumnSelection, elements.payrollWageCodeMap].forEach((control) => control?.addEventListener("change", () => {
  state.integrations.payrollPreflight = null;
  renderPayrollPreflight();
}));
elements.payrollAllowDraft?.addEventListener("change", () => renderPayrollPreflight(state.integrations.payrollPreflight));
elements.payrollPreflightButton?.addEventListener("click", preflightPayrollExport);
elements.payrollDownloadButton?.addEventListener("click", downloadPayrollExport);
elements.savePayrollProfileButton?.addEventListener("click", () => saveIntegrationProfile("export").catch((error) => showToast(error.message, true)));
document.querySelectorAll("[data-settings-tab]").forEach((button) => button.addEventListener("click", () => setSettingsTab(button.dataset.settingsTab)));
elements.saveWifiAutomationSettingsButton?.addEventListener("click", saveWifiAutomationSettings);
elements.saveWifiLocationMappingsButton?.addEventListener("click", saveWifiLocationMappings);
elements.saveWifiConfirmationLevelsButton?.addEventListener("click", saveWifiConfirmationLevels);
elements.wifiConfirmationLevelSearch?.addEventListener("input", renderWifiConfirmationLevels);
elements.wifiConfirmationLevelList?.addEventListener("change", (event) => {
  const select = event.target.closest("[data-wifi-confirmation-level]");
  if (!select) return;
  const employee = (state.wifiAutomationSettings?.employees || [])
    .find((item) => item.employeeNumber === select.dataset.wifiConfirmationLevel);
  if (employee) employee.level = select.value;
});
[elements.wifiMinimumPresenceMinutes, elements.wifiAbsenceGraceMinutes].forEach((input) => input?.addEventListener("input", updateWifiAutomationRuleHint));
document.querySelectorAll("[data-personnel-tab]").forEach((button) => button.addEventListener("click", () => setPersonnelTab(button.dataset.personnelTab)));
document.querySelector(".main-nav").addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-nav-toggle]");
  if (toggle) {
    event.preventDefault();
    event.stopPropagation();
    const key = toggle.dataset.navToggle;
    const children = key === "planning" ? elements.planningNavChildren : elements.vacationNavChildren;
    const opening = children.classList.contains("hidden");
    localStorage.setItem(`grabenplaner-nav-${key}`, opening ? "open" : "closed");
    children.classList.toggle("hidden", !opening);
    toggle.classList.toggle("expanded", opening);
    toggle.setAttribute("aria-expanded", String(opening));
    return;
  }
  const button = event.target.closest("[data-context-view]");
  if (!button) return;
  state.locationId = button.dataset.locationId || state.locationId;
  state.departmentId = button.dataset.departmentId || "";
  setView(button.dataset.contextView);
  loadAll();
});
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => document.querySelector(`#${button.dataset.close}`).close()));
document.querySelector("#previousWeek").addEventListener("click", () => { state.weekStart = addDays(state.weekStart, -7); loadAll(); });
document.querySelector("#nextWeek").addEventListener("click", () => { state.weekStart = addDays(state.weekStart, 7); loadAll(); });
document.querySelector("#todayButton").addEventListener("click", () => { state.weekStart = getMonday(new Date()); loadAll(); });
document.querySelector("#weekJumpDate").addEventListener("change", (event) => {
  if (!event.target.value) return;
  state.weekStart = getMonday(new Date(`${event.target.value}T12:00:00`));
  loadAll();
});
elements.vacationYear.addEventListener("change", () => {
  const year = Number(elements.vacationYear.value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    showToast("Bitte ein gültiges Jahr auswählen.", true);
    elements.vacationYear.value = state.vacationYear;
    return;
  }
  state.vacationYear = year;
  loadAll();
});
elements.vacationViewMode.addEventListener("change", () => {
  state.vacationViewMode = elements.vacationViewMode.value;
  renderVacations();
  updatePdfPreview();
});
elements.vacationQuarter.addEventListener("change", () => {
  state.vacationQuarter = Number(elements.vacationQuarter.value);
  renderVacations();
  updatePdfPreview();
});
elements.vacationMonth.addEventListener("change", () => {
  state.vacationMonth = Number(elements.vacationMonth.value);
  renderVacations();
  updatePdfPreview();
});
elements.addVacationButton.addEventListener("click", openVacationModal);
elements.saveEntitlementsButton.addEventListener("click", saveVacationEntitlements);
elements.editEntitlementsButton.addEventListener("click", () => {
  state.editingVacationEntitlements = true;
  renderVacations();
});
document.querySelector("#optionsButton").addEventListener("click", openOptionsModal);
document.querySelector("#optionType").addEventListener("change", handleOptionTypeChange);
document.querySelector("#optionEmployee").addEventListener("change", updateOptionCreditFields);
elements.globalBlockSubmitButton.addEventListener("click", saveGlobalBlock);
elements.globalBlockDate.addEventListener("change", updateGlobalBlockHolidaySuggestion);
elements.optionPreviousWeek.addEventListener("click", () => switchOptionsWeek(-1));
elements.optionNextWeek.addEventListener("click", () => switchOptionsWeek(1));
elements.optionsModal.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
  event.preventDefault();
  switchOptionsWeek(event.key === "ArrowLeft" ? -1 : 1);
});
elements.cancelOptionEditButton.addEventListener("click", () => {
  resetOptionEditor();
  document.querySelector("#optionNote").value = "";
  document.querySelector("#optionHours").value = "";
  updateOptionCreditFields();
});
document.querySelector("#autoPlanButton").addEventListener("click", openAutoPlanModal);
document.querySelector("#resetWeekButton").addEventListener("click", openResetWeekModal);
elements.scheduleNoteButton.addEventListener("click", openScheduleNoteModal);
elements.scheduleNoteForm.addEventListener("submit", saveScheduleNote);
elements.deleteScheduleNoteButton.addEventListener("click", deleteScheduleNote);
initScheduleNoteEditor();
elements.departmentPdfSelect?.addEventListener("change", () => {
  const selectedDepartment = elements.departmentPdfSelect.value;
  elements.departmentPdfButton.href = `/api/schedule.pdf?week=${state.weekStart}&location=${encodeURIComponent(state.locationId)}&departmentId=${encodeURIComponent(selectedDepartment)}`;
});
document.querySelector("#shiftEmployee").addEventListener("change", () => {
  if (document.querySelector("#shiftId").value) return;
  const employee = state.data?.employees?.find((item) => item.personnel_number === document.querySelector("#shiftEmployee").value);
  if (employee?.preferred_department_id) elements.shiftDepartment.value = String(employee.preferred_department_id);
});
document.querySelector("#addEmployeeButton").addEventListener("click", () => openEmployeeModal());
document.querySelector("#saveSettingsButton").addEventListener("click", () => saveSettings(false));
elements.locationForm.addEventListener("submit", saveLocation);
elements.departmentForm.addEventListener("submit", saveDepartment);
elements.addLocationButton?.addEventListener("click", () => {
  resetLocationForm();
  elements.locationEditorModal?.showModal();
});
elements.addDepartmentButton?.addEventListener("click", () => {
  resetDepartmentForm();
  elements.departmentEditorModal?.showModal();
});
elements.positionForm.addEventListener("submit", savePosition);
elements.cancelLocationEditButton.addEventListener("click", resetLocationForm);
elements.cancelDepartmentEditButton.addEventListener("click", resetDepartmentForm);
elements.cancelPositionEditButton.addEventListener("click", resetPositionForm);
elements.employeeHomeLocation.addEventListener("change", () => updateEmployeeDepartmentOptions());
elements.employeeAppRole?.addEventListener("change", () => {
  const employeeNumber = document.querySelector("#employeeNumber").value.trim();
  renderEmployeeAccessProfile(state.allEmployees.find((employee) => employee.personnel_number === employeeNumber) || null);
});
elements.employeeAdditionalRights?.addEventListener("change", (event) => {
  const input = event.target.closest("[data-employee-access-permission]");
  if (!input || input.disabled) return;
  if (input.checked) state.employeeAccessDraft.add(input.value);
  else state.employeeAccessDraft.delete(input.value);
  const employeeNumber = document.querySelector("#employeeNumber").value.trim();
  renderEmployeeAccessProfile(state.allEmployees.find((employee) => employee.personnel_number === employeeNumber) || null);
});
elements.schedulePdfPreviewButton.addEventListener("click", generateSchedulePdfPreview);
elements.vacationPdfPreviewButton.addEventListener("click", generateVacationPdfPreview);
document.querySelector("#createBackupButton").addEventListener("click", createManualBackup);
document.querySelector("#importBackupButton").addEventListener("click", importBackup);
["pdfTitleSetting", "pdfFilenamePrefix", "pdfFilenameIncludeKw", "pdfFilenameIncludeTimestamp", "vacationPdfTitleSetting", "vacationPdfFilenamePrefix", "vacationPdfFilenameIncludePeriod", "vacationPdfFilenameIncludeTimestamp", "vacationPdfCalendarStyle", "vacationPdfShowBalance", "vacationPdfBalanceShowEntitlement", "vacationPdfBalanceShowPlanned", "vacationPdfBalanceShowConsumed"].forEach((id) => {
  document.querySelector(`#${id}`).addEventListener("input", updatePdfPreview);
  document.querySelector(`#${id}`).addEventListener("change", updatePdfPreview);
});
["optionAllDay", "optionStartTime", "optionEndTime"].forEach((id) => {
  document.querySelector(`#${id}`).addEventListener("input", updateOptionCreditFields);
  document.querySelector(`#${id}`).addEventListener("change", updateOptionCreditFields);
});
document.querySelector("#optionDateFrom").addEventListener("change", () => {
  const from = document.querySelector("#optionDateFrom").value;
  const to = document.querySelector("#optionDateTo").value;
  if (to < from) document.querySelector("#optionDateTo").value = from;
});
document.querySelector("#optionDateTo").addEventListener("change", () => {
  const from = document.querySelector("#optionDateFrom").value;
  const to = document.querySelector("#optionDateTo").value;
  if (to < from) document.querySelector("#optionDateFrom").value = to;
});
elements.employeeForm.addEventListener("submit", saveEmployee);
elements.shiftForm.addEventListener("submit", saveShift);
elements.optionForm.addEventListener("submit", saveOption);
elements.autoPlanForm.addEventListener("submit", createAutomaticPlan);
elements.resetWeekForm.addEventListener("submit", resetCurrentWeek);
elements.vacationForm.addEventListener("submit", saveVacation);
elements.deleteEmployeeButton.addEventListener("click", deleteEmployee);
elements.deleteShiftButton.addEventListener("click", deleteShift);
["shiftStart", "shiftEnd", "shiftDate"].forEach((id) => document.querySelector(`#${id}`).addEventListener("input", calculateShiftPreview));
["vacationEmployee", "vacationDateFrom", "vacationDateTo"].forEach((id) => {
  document.querySelector(`#${id}`).addEventListener("input", updateVacationCalculation);
  document.querySelector(`#${id}`).addEventListener("change", updateVacationCalculation);
});

document.querySelector("#employeeColorPicker").addEventListener("input", (event) => updateColorPicker(event.target.value));
document.querySelector("#employeeColorHex").addEventListener("input", (event) => {
  if (/^#[0-9a-f]{6}$/i.test(event.target.value)) updateColorPicker(event.target.value);
});

elements.employeeTableBody.addEventListener("click", (event) => {
  const recordButton = event.target.closest("[data-personnel-record]");
  if (recordButton) {
    openPersonnelRecord(recordButton.dataset.personnelRecord);
    return;
  }
  const button = event.target.closest("[data-edit-employee]");
  if (!button) return;
  openEmployeeModal(state.allEmployees.find((employee) => employee.personnel_number === button.dataset.editEmployee));
});

elements.locationList.addEventListener("click", (event) => {
  const locationButton = event.target.closest("[data-edit-location]");
  if (locationButton) {
    const location = (state.locations || []).find((item) => item.id === locationButton.dataset.editLocation);
    if (location) {
      fillLocationForm(location);
      elements.locationEditorModal?.showModal();
    }
    return;
  }
  const departmentButton = event.target.closest("[data-edit-department]");
  if (!departmentButton) return;
  const departmentId = Number(departmentButton.dataset.editDepartment);
  const department = (state.locations || []).flatMap((location) => location.departments || []).find((item) => item.id === departmentId);
  if (department) {
    fillDepartmentForm(department);
    elements.departmentEditorModal?.showModal();
  }
});

elements.positionList.addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-edit-position]");
  if (editButton) {
    const position = (state.positions || []).find((item) => item.id === editButton.dataset.editPosition);
    if (position) fillPositionForm(position);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-position]");
  if (deleteButton) deletePosition(deleteButton.dataset.deletePosition);
});

elements.timeline.addEventListener("click", (event) => {
  const optionBlock = event.target.closest(".option-block");
  if (optionBlock) {
    showToast(optionBlock.dataset.optionTitle || "Dieser Zeitraum ist bereits belegt.", true);
    return;
  }
  const shiftButton = event.target.closest("[data-shift-id]");
  if (shiftButton) {
    event.stopPropagation();
    const shift = state.data.shifts.find((item) => item.id === Number(shiftButton.dataset.shiftId));
    openShiftModal(shift.employee_number, shift.shift_date, shift);
    return;
  }
  const lane = event.target.closest("[data-employee-number][data-date]");
  if (lane) openShiftModal(lane.dataset.employeeNumber, lane.dataset.date);
});

elements.optionList.addEventListener("click", async (event) => {
  const editGlobalButton = event.target.closest("[data-edit-global-block]");
  if (editGlobalButton) {
    const block = (state.data.globalDayBlocks || []).find((item) => item.id === Number(editGlobalButton.dataset.editGlobalBlock));
    if (block) fillGlobalBlockForm(block);
    return;
  }
  const deleteGlobalButton = event.target.closest("[data-delete-global-block]");
  if (deleteGlobalButton) {
    deleteGlobalBlock(deleteGlobalButton.dataset.deleteGlobalBlock);
    return;
  }
  const editButton = event.target.closest("[data-edit-option]");
  if (editButton) {
    const option = state.data.weekOptions.find((item) => item.id === Number(editButton.dataset.editOption));
    if (option) fillOptionForm(option);
    return;
  }
  const button = event.target.closest("[data-delete-option]");
  if (!button) return;
  try {
    await api(`/api/week-options/${button.dataset.deleteOption}`, { method: "DELETE" });
    await loadAll();
    renderOptionList();
    showToast("Planungsoption wurde entfernt.");
  } catch (error) { showToast(error.message, true); }
});

elements.vacationCalendar.addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-edit-vacation]");
  if (editButton) {
    const vacation = state.vacationData.vacations.find((item) => item.group_id === editButton.dataset.editVacation);
    if (vacation) openVacationModal(vacation);
    return;
  }
  const button = event.target.closest("[data-delete-vacation]");
  if (!button) return;
  deleteVacation(button.dataset.deleteVacation);
});

bootstrapApplication();
setInterval(() => {
  if (!document.body.classList.contains("portal-locked")) loadSystemInfo();
}, 30000);
setInterval(() => {
  if (!document.body.classList.contains("portal-locked") && state.portalStatus?.portalEnabled) loadManagerVacationRequests();
}, 45000);
window.addEventListener("focus", () => {
  if (!document.body.classList.contains("portal-locked") && state.portalStatus?.portalEnabled) loadManagerVacationRequests();
});
