(() => {
  const storageKey = "grabenplaner-bootstrap-token";
  const parameters = new URLSearchParams(window.location.search);
  const suppliedToken = String(parameters.get("bootstrap") || "").trim();
  let inMemoryToken = "";
  if (suppliedToken.length >= 32) {
    inMemoryToken = suppliedToken;
    try { window.sessionStorage.setItem(storageKey, suppliedToken); } catch {}
    parameters.delete("bootstrap");
    const query = parameters.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, options = {}) => {
    let bootstrapToken = inMemoryToken;
    try { bootstrapToken ||= window.sessionStorage.getItem(storageKey) || ""; } catch {}
    if (bootstrapToken.length < 32) return originalFetch(input, options);
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url, window.location.href);
    if (target.origin !== window.location.origin) return originalFetch(input, options);
    const method = String(options.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return originalFetch(input, options);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(options.headers || {}).forEach((value, name) => headers.set(name, value));
    headers.set("X-Grabenplaner-Bootstrap-Token", bootstrapToken);
    return originalFetch(input, { ...options, headers });
  };
})();

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
  amuCanReview: false,
  amuAccess: null,
  requestCounts: { vacation: 0, timeOff: 0, amu: 0, total: 0 },
  requestKindTab: "vacation",
  currentView: "planning",
  timePresence: null,
  timeDayReview: null,
  timeSummary: null,
  timeCorrections: [],
  rightsManagement: null,
  rightsDashboard: null,
  locationDashboard: null,
  locationDashboardFilter: "all",
  locationDashboardDraggingId: "",
  rightsDashboardSelectedEmployeeNumber: "",
  rightsDashboardSelectedPermissionId: "",
  rightsDashboardTheme: "light",
  pageThemes: {
    planning: "light",
    requests: "light",
    timeTracking: "light",
    vacations: "light",
    personnelAdministration: "light",
    personnel: "light",
    rightsDashboard: "light",
    settings: "light",
  },
  dashboardFontSize: "standard",
  rightsDashboardMode: "locations",
  rightsDashboardSelectedProcessId: "vacation",
  rightsDashboardSelectedProcessStepId: "",
  rightsProcessLocationId: "",
  rightsProcessScenarioIds: {},
  editingCustomProcessId: "",
  editingCustomProcessRevision: null,
  customProcessDraftSteps: [],
  customProcessTriggerPending: new Set(),
  customProcessTriggerIdempotencyKeys: new Map(),
  brandingAssignments: [],
  brandingPreference: null,
  brandingFormDirty: false,
  mobileLeadershipSettings: null,
  personnelFieldRights: null,
  selectedPersonnelFieldRightsRole: "manager",
  personnelFieldRightsDirtyRoles: new Set(),
  personnelFieldRightsDrafts: {},
  selectedRightsEmployeeNumber: "",
  employeeAccessDraft: new Set(),
  amuPolicy: null,
  amuAccessPolicy: null,
  wifiAutomationSettings: null,
  trustLevelSettings: null,
  greetingSettings: null,
  selectedRequest: null,
  allEmployees: [],
  personnelDirectory: [],
  costCenters: [],
  centralVacations: [],
  centralVacationYear: new Date().getFullYear(),
  centralVacationCostCenterFilter: "",
  centralVacationSearch: "",
  centralVacationLoadedYear: null,
  centralVacationLoading: false,
  personnelAdministrationLoaded: false,
  personnelAdministrationLoading: false,
  personnelAdministrationTab: "employees",
  personnelDirectorySearch: "",
  personnelDirectoryCostCenterFilter: "",
  personnelDirectoryStatusFilter: "active",
  editingCostCenterId: null,
  personnelRecord: null,
  personnelRecordDirtyFields: new Set(),
  employeePersonnelRecord: null,
  serverStatus: null,
  serverDiagnostics: null,
  updateStatus: null,
  selectedColor: "#0b84c6",
  integrations: {
    importCatalog: null,
    payrollCatalog: null,
    connectionCatalog: null,
    contracts: [],
    connections: [],
    deliveries: [],
    connectionLoadError: "",
    deliveryLoadError: "",
    editingConnectionId: "",
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
    "planningView", "requestsView", "timeTrackingView", "vacationsView", "personnelAdministrationView", "personnelView", "rightsDashboardView", "settingsView", "filialManagementNav", "filialManagementToggle", "filialManagementNavChildren", "filialTeamsNavButton", "planningNavButton", "vacationsNavButton", "planningNavChildren", "vacationNavChildren", "requestsNavButton", "requestsNavCount", "timeTrackingNavButton", "personnelAdministrationNavButton", "rightsDashboardNavButton", "timeTrackingLocation", "timeTrackingDepartment", "refreshTimePresenceButton", "timePresenceSummary", "timePresenceList", "timePresenceUpdated", "weekTitle", "calendarWeek", "scheduleTitle", "shiftCount",
    "totalHours", "inStoreHours", "optionCount", "employeeCount", "sidebarEmployeeCount", "sidebarVersion", "sidebarSessionInfo", "sidebarSessionRole", "sidebarSessionIdentity", "sidebarSessionPosition", "pdfButton", "timeline", "weekLockNotice",
    "remarks", "hoursOverview", "systemData", "versionLabel", "breakRuleHint", "saturdayRuleHint", "saveSettingsButton", "generalSettings", "brandingSettings", "pdfSettings", "personnelSettings", "vacationSettings", "timeTrackingSettings", "integrationSettings", "backupSettings", "rightsSettings", "employeeSettings",
    "scheduleNoteButton", "scheduleNoteButtonHint", "scheduleNoteModal", "scheduleNoteForm", "scheduleNoteEditor", "scheduleNoteCounter", "deleteScheduleNoteButton",
    "vacationTitle", "vacationSubtitle", "vacationYear", "vacationViewMode", "vacationQuarter", "vacationMonth", "vacationQuarterField", "vacationMonthField",
    "vacationSummary", "vacationCalendar", "vacationCalendarTitle", "vacationPdfButton", "addVacationButton", "saveEntitlementsButton", "editEntitlementsButton", "managerVacationRequestList", "refreshRequestsButton", "requestWorkflowSummary", "requestStatusFilter", "vacationRequestCount", "timeOffRequestCount", "amuRequestCount",
    "requestBlackoutPanel", "requestBlackoutForm", "requestBlackoutId", "requestBlackoutLocation", "requestBlackoutDepartment", "requestBlackoutDateFrom", "requestBlackoutDateTo", "requestBlackoutReason", "requestBlackoutVacation", "requestBlackoutTimeOff", "requestBlackoutActive", "requestBlackoutSubmit", "cancelRequestBlackoutEdit", "addRequestBlackoutButton", "requestBlackoutList",
    "vacationModal", "vacationForm", "vacationModalTitle", "vacationSubmitButton", "vacationEmployee", "vacationDateFrom", "vacationDateTo", "vacationNote", "vacationCalculation",
    "employeeTableBody", "employeeModal", "employeeForm", "employeeModalTitle", "employeeEditScopeHint", "deleteEmployeeButton", "employeeCostCenter", "employeeCostCenterHint", "employeeHomeLocation", "employeeHomeLocationHint", "employeePreferredDepartment", "employeePosition", "employeeTimeConfirmationLevelField", "employeeTimeConfirmationLevel", "employeeTargetWorkdays", "employeeSicknessWithoutAumField", "employeeSicknessWithoutAumEnabled", "employeeSicknessWithoutAumHint", "employeeProtectedRecord", "employeeProtectedRecordHint",
    "personnelAdministrationSummary", "personnelDirectorySection", "personnelDirectorySearch", "personnelDirectoryCostCenterFilter", "personnelDirectoryStatusFilter", "personnelDirectoryBody", "addCentralEmployeeButton", "costCenterSection", "costCenterList", "addCostCenterButton", "costCenterModal", "costCenterForm", "costCenterModalTitle", "costCenterId", "costCenterCode", "costCenterName", "costCenterType", "costCenterDescription", "costCenterActive", "costCenterSubmitButton", "deactivateCostCenterButton", "centralVacationsTab", "centralVacationSection", "centralVacationSummary", "centralVacationSearch", "centralVacationCostCenterFilter", "centralVacationYear", "centralVacationList",
    "employeeAccessProfile", "employeeAccessStatus", "employeeAppRole", "employeeAppRoleDescription", "employeeRolePermissions", "employeeAdditionalRightsDetails", "employeeAdditionalRights", "employeeAdditionalRightsCount", "employeeAccessHint",
    "employeeSettings", "locationSettings", "locationFormCard", "departmentFormCard", "locationEditorModal", "departmentEditorModal", "addLocationButton", "addDepartmentButton", "locationForm", "locationId", "locationName", "locationCostCenterField", "locationCostCenter", "locationCostCenterReadonly", "locationMinStaff", "locationActive", "locationTimeTrackingEnabled", "locationTimeTrackingAccessMode", "locationTimeTrackingAllowedNetworks", "locationTimeTrackingVarianceMinutes", "locationSubmitButton", "cancelLocationEditButton",
    "departmentForm", "departmentId", "departmentLocation", "departmentName", "departmentMinStaff", "departmentActive", "departmentSubmitButton", "cancelDepartmentEditButton", "locationList",
    "shiftModal", "shiftForm", "shiftModalTitle", "deleteShiftButton", "shiftCalculation", "shiftDepartment", "departmentPdfControl", "departmentPdfSelect", "departmentPdfButton",
    "optionsModal", "optionForm", "optionList", "optionsWeekLabel", "optionsWeekRange", "optionPreviousWeek", "optionNextWeek", "globalBlockDate", "globalBlockReason", "globalBlockHoliday", "globalBlockSubmitButton", "optionSubmitButton", "cancelOptionEditButton", "autoPlanModal",
    "autoPlanForm", "autoPlanWeek", "resetWeekModal", "resetWeekForm", "resetWeekText", "schedulePdfPreviewButton", "schedulePdfPreviewFrame", "vacationPdfPreviewButton", "vacationPdfPreviewFrame", "appBackupDirectoryText",
    "positionForm", "positionId", "positionName", "positionSubmitButton", "cancelPositionEditButton", "positionList", "updateCheckButton", "updateCheckIcon", "updateCheckText", "updateCheckHint", "systemExitButton",
    "localModeOption", "localModeBadge", "serverModeOption", "serverModeBadge", "publicServerModeOption", "publicServerModeBadge", "saveOperationModeButton", "portalFoundationHint", "adminAccessModeLabel", "accessSettings", "portalUserList", "accessSettingsHint", "adminSetupButton", "adminSetupModal", "adminSetupForm", "adminSetupEmployee", "adminSetupPassword", "adminSetupPasswordRepeat",
    "rightsManagementHint", "rightsEmployeeSearch", "rightsUserList", "rightsEditorModal", "rightsEditorForm", "rightsEditorTitle", "rightsEditorSummary", "rightsEditorPermissions", "rightsEditorHint", "saveRightsEditorButton", "mobileLeadershipModuleSettings", "mobileLeadershipSettingsHint", "saveMobileLeadershipSettingsButton", "personnelFieldRightsRole", "personnelFieldRightsMatrix", "personnelFieldRightsHint", "savePersonnelFieldRightsButton", "positionSettingsCard", "personnelViewSettingsCard", "trustLevelSettingsCard",
    "rightsDashboardLocationsPanel", "locationDashboardDate", "refreshLocationDashboard", "locationDashboardSummary", "locationDashboardFilters", "locationDashboardGrid", "rightsDashboardRightsPanel", "rightsDashboardProcessesPanel", "rightsDashboardSummary", "rightsDashboardSearch", "rightsDashboardRoleFilter", "rightsDashboardLocationFilter", "rightsDashboardDepartmentFilter", "rightsDashboardOriginFilter", "rightsDashboardResultCount", "rightsDashboardUserList", "rightsDashboardEmpty", "rightsDashboardSelection", "rightsDashboardPersonTitle", "rightsDashboardPersonSubtitle", "rightsDashboardAccessStatus", "rightsDashboardPath", "rightsDashboardMatrix", "rightsDashboardExplanation",
    "rightsProcessLocation", "rightsProcessScenario", "rightsProcessExportPdf", "addCustomProcessButton", "rightsCustomProcessActions", "rightsProcessValidationHint", "rightsProcessValidationSummary", "rightsProcessValidationList", "rightsProcessList", "rightsProcessTitle", "rightsProcessSummary", "rightsProcessStatus", "rightsProcessSimulationNote", "rightsProcessRules", "rightsProcessTimeline", "rightsProcessExplanation",
    "customProcessModal", "customProcessForm", "customProcessModalTitle", "customProcessId", "customProcessTitle", "customProcessSymbol", "customProcessStatus", "customProcessDescription", "customProcessScopeType", "customProcessScopeLocationField", "customProcessScopeLocation", "customProcessScopeDepartmentField", "customProcessScopeDepartment", "customProcessTriggerType", "customProcessShortfallField", "customProcessMinimumShortfall", "addCustomProcessStepButton", "customProcessSteps", "customProcessResponsibilityOptions", "customProcessMessage", "saveCustomProcessButton",
    "serverAlertBanner", "serverAlertTitle", "serverAlertMessage", "serverDiagnosticsCard", "serverDiagnostics", "refreshServerDiagnosticsButton", "databaseBackupSettingsCard", "backupRestoreGuidanceCard",
    "delegationSettingsCard", "delegationForm", "delegationLocation", "delegationEmployee", "delegationDateFrom", "delegationDateTo", "delegationNote", "delegationList",
    "workflowSettingsCard", "vacationHrApprovalRequired", "workflowSettingsHint", "currentWeekAutoLock", "currentWeekLockSettings", "currentWeekLockMode", "manualWeekLockFields", "currentWeekLockDay", "currentWeekLockTime", "currentWeekLockHint", "viewBehaviorSettingsCard", "rememberLastScheduleOverallPlan", "rememberLastVacationOverallPlan", "dashboardFontSize",
    "amuSettingsCard", "amuUploadMaxMb", "amuStoredMaxMb", "amuConvertImagesToPdf", "amuGrayscaleImages", "amuOcrEnabled", "sicknessLocalWarningDays", "sicknessHrWarningDays", "sicknessAumAllowanceEnabled", "sicknessAumAllowanceMaxCases", "sicknessAumAllowanceMaxDays", "amuAutoReviewTrustA", "amuSettingsHint", "saveAmuSettingsButton", "amuManagerDefaultAccess", "amuManagerAccessList", "amuAccessPolicyHint", "saveAmuAccessPolicyButton",
    "greetingSettingsCard", "personalizedGreetingsEnabled", "greetingVacationMinimumDays", "greetingReturnWorkdays", "greetingRecoveryWorkdays", "greetingMorningTemplates", "greetingDaytimeTemplates", "greetingEveningTemplates", "greetingVacationTemplates", "greetingSicknessActiveTemplates", "greetingSicknessReturnTemplates", "greetingSettingsHint", "saveGreetingSettingsButton",
    "wifiSettingsCard", "wifiMinimumPresenceMinutes", "wifiAbsenceGraceMinutes", "wifiAutomationStatus", "wifiAutomationSettingsHint", "saveWifiAutomationSettingsButton", "wifiConnectorDetails", "wifiLocationMappingList", "saveWifiLocationMappingsButton", "wifiConfirmationLevelSearch", "wifiConfirmationLevelList", "wifiConfirmationLevelHint", "saveWifiConfirmationLevelsButton", "trustLevelsEnabled", "trustLevelsVisibleToManagers", "trustLevelsVisibleToDepartmentManagers", "trustLevelsVisibleToEmployees",
    "requestActionModal", "requestActionForm", "requestActionTitle", "requestActionSummary", "requestActionHistory", "requestActionDocuments", "requestActionNote", "requestEditFields", "requestEditDateFromField", "requestEditDateToField", "requestEditTimeField", "requestEditDateFrom", "requestEditDateTo", "requestEditStartTime", "requestEditEndTime", "changeApprovedRequestButton", "cancelApprovedRequestButton",
    "loginGate", "loginBrandLogo", "adminLoginForm", "adminLoginPersonnelNumber", "adminLoginPassword", "adminLoginError", "portalLogoutButton", "employeePortalLink", "deploymentBanner", "personnelRecordModal", "personnelRecordForm", "personnelRecordTitle", "personnelRecordContent", "personnelRecordMessage", "savePersonnelRecordButton",
    "timeCorrectionModal", "timeCorrectionForm", "timeCorrectionTitle", "timeCorrectionEmployee", "timeCorrectionWorkDate", "timeCorrectionEmployeeLabel", "timeCorrectionDateLabel", "timeCorrectionClockOutTime", "timeCorrectionMessage",
    "timeCorrectionReviewModal", "timeCorrectionReviewForm", "timeCorrectionReviewId", "timeCorrectionReviewSummary", "timeCorrectionReviewEntries", "addTimeCorrectionReviewEntry", "timeCorrectionReviewNote", "timeCorrectionReviewMessage",
    "timeDayReviewPanel", "timeReviewDate", "timeReviewFilter", "loadTimeDayReviewButton", "timeDayReviewSummary", "timeDayReviewList", "timeDayReviewModal", "timeDayReviewForm", "timeDayReviewTitle", "timeDayReviewDetail", "timeDayReviewEmployee", "timeDayReviewWorkDate", "timeDayReviewMetrics", "timeDayReviewIssues", "timeDayReviewNote", "timeDayReviewMessage", "removeTimeDayReviewButton",
    "timeSummaryFrom", "timeSummaryTo", "loadTimeSummaryButton", "timeSummaryList", "timeCorrectionPanel", "timeCorrectionCount", "timeCorrectionRequestList",
    "brandLogo", "footerBrandLogo", "adminContactLink", "brandingCompanyName", "brandingAdminEmail", "brandingLogoUrl", "brandingIconUrl", "brandingLogoAlt", "brandingPreviewLogo", "brandingPreviewTitle", "brandingPreviewCompany", "brandingKitLibrary", "brandingAssignmentList", "exportBrandingButton", "brandingImportFile", "importBrandingButton", "toast",
    "usbProvisioningTab", "usbProvisioningSettings", "usbProvisioningAvailabilityCard", "usbProvisioningAvailability", "usbProvisioningAvailabilityBadge", "usbProvisioningAvailabilityTitle", "usbProvisioningAvailabilityText", "usbProvisioningWizard", "usbWizardDraftStatus", "usbInstallationProfile", "usbInstallationName", "usbModuleSelection", "usbPrimaryBranding", "usbPrimaryBrandingPreview", "usbAdditionalBrandings", "usbBrandingImportFile", "usbImportBrandingButton", "usbCreatorSummary", "usbCreatorEmployee", "usbCreatorPassword", "usbLocationSelection", "usbAddLocationButton", "usbEmployeeSearch", "usbAddEmployeeButton", "usbEmployeeSelection", "usbGuideTitle", "usbGuideIntroduction", "usbGuideNotes", "usbGuideContact", "usbGuideIncludeStartup", "usbGuideIncludeModules", "usbGuideIncludePdf", "usbGuideIncludeBackup", "usbGuidePreviewButton", "usbGuidePreviewFrame", "usbRefreshDrivesButton", "usbDriveList", "usbHideProgramFolder", "usbProtectProgramFiles", "usbProvisioningSummary", "usbFormatConfirmation", "usbFormatConfirmationHint", "usbProvisioningStartButton", "usbWizardActions", "usbWizardPreviousButton", "usbWizardStepHint", "usbWizardNextButton", "usbProvisioningProgressPanel", "usbProvisioningProgressTitle", "usbProvisioningProgressPercent", "usbProvisioningProgressTrack", "usbProvisioningProgressText", "usbProvisioningProgressSteps", "usbProvisioningResultPanel", "usbProvisioningResultText", "usbProvisioningResultDetails", "usbEmployeeDraftModal", "usbEmployeeDraftForm", "usbDraftPersonnelNumber", "usbDraftFullName", "usbDraftNickname", "usbDraftColor", "usbDraftContractedHours", "usbDraftPosition", "usbDraftLocation", "usbDraftDepartment", "usbDraftRole", "usbDraftPassword",
    "integrationConnectionsCard", "integrationConnectionList", "integrationDeliveryHistory", "addIntegrationConnectionButton", "integrationContractsCard", "integrationContractList",
    "employeeImportCard", "importProfileCard", "payrollExportCard", "exportProfileCard", "integrationInformationCard", "integrationHistoryCard", "openPersonnelImportButton", "importProfileList", "exportProfileList", "integrationHistory",
    "payrollProfile", "payrollLocation", "payrollDepartment", "payrollDateFrom", "payrollDateTo", "payrollSourceMode", "payrollLayout", "payrollFormat", "payrollApiTargetField", "payrollApiTarget", "payrollDelimiter", "payrollDecimalSeparator", "payrollColumnSelection", "payrollWageCodeDetails", "payrollWageCodeMap", "payrollAllowDraft", "payrollProfileName", "savePayrollProfileButton", "payrollPreflightButton", "payrollDeliverButton", "payrollDownloadButton", "payrollPreflightResult",
    "personnelImportModal", "personnelImportForm", "personnelImportProgress", "personnelImportFileStep", "personnelImportMappingStep", "personnelImportPreviewStep", "personnelImportSourceType", "personnelImportFileField", "personnelImportSqlConnectionField", "personnelImportSqlConnection", "personnelImportFile", "personnelImportProfile", "personnelImportDuplicateStrategy", "personnelImportDefaultLocation", "personnelImportDefaultDepartment", "personnelImportDefaultPosition", "personnelImportDefaultHours", "inspectPersonnelImportButton", "personnelImportSheet", "personnelImportHeaderRow", "personnelImportMapping", "personnelImportProfileName", "savePersonnelImportProfileButton", "previewPersonnelImportButton", "personnelImportSummary", "personnelImportPreviewBody", "personnelImportPreviewHint", "personnelImportMessage", "resetPersonnelImportButton", "backPersonnelImportButton", "applyPersonnelImportButton",
    "integrationConnectionModal", "integrationConnectionForm", "integrationConnectionTitle", "integrationConnectionId", "integrationConnectionKind", "integrationConnectionName", "integrationConnectionActive", "integrationConnectionScopeLocations", "integrationConnectionScopeDepartments", "integrationSqlFields", "integrationSqlHost", "integrationSqlPort", "integrationSqlDatabase", "integrationSqlInstance", "integrationSqlSchema", "integrationSqlView", "integrationSqlAllowedColumns", "integrationSqlTls", "integrationSqlTimeout", "integrationSqlRowLimit", "integrationApiFields", "integrationApiEndpoint", "integrationApiAuthentication", "integrationApiKeyHeaderField", "integrationApiKeyHeader", "integrationApiTimeout", "integrationApiRequestLimit", "integrationApiResponseLimit", "integrationCredentialPanel", "integrationCredentialTitle", "integrationCredentialStatus", "integrationSqlCredentials", "integrationApiCredentials", "integrationBearerTokenField", "integrationApiKeyField", "integrationBasicUsernameField", "integrationBasicPasswordField", "integrationCredentialUsername", "integrationCredentialPassword", "integrationCredentialToken", "integrationCredentialApiKey", "integrationCredentialBasicUsername", "integrationCredentialBasicPassword", "integrationConnectionMessage", "deleteIntegrationConnectionButton", "testIntegrationConnectionButton", "saveIntegrationConnectionButton",
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

function formatDate(isoDate, options = { day: "2-digit", month: "2-digit", year: "numeric" }, fallback = "—") {
  const normalized = String(isoDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return fallback;
  const date = new Date(`${normalized}T12:00:00`);
  if (Number.isNaN(date.getTime())) return fallback;
  try {
    return new Intl.DateTimeFormat("de-AT", options).format(date);
  } catch {
    return fallback;
  }
}

function formatAmuPeriod(report = {}) {
  const start = formatDate(report.incapacity_from, undefined, "Beginn offen");
  const end = report.incapacity_to ? formatDate(report.incapacity_to, undefined, "offen") : "offen";
  return `${start}–${end}`;
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

function escapeHtmlAttribute(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
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

function canReadCentralPersonnel() {
  return !state.portalStatus?.portalEnabled
    || state.portalSession?.user?.permissions?.includes("personnel:central:read") === true;
}

function canWriteCentralPersonnel() {
  return !state.portalStatus?.portalEnabled
    || state.portalSession?.user?.permissions?.includes("personnel:central:write") === true;
}

function canReadCostCenters() {
  return !state.portalStatus?.portalEnabled
    || state.portalSession?.user?.permissions?.includes("cost_centers:read") === true
    || canReadCentralPersonnel();
}

function canWriteCostCenters() {
  return !state.portalStatus?.portalEnabled
    || state.portalSession?.user?.permissions?.includes("cost_centers:write") === true;
}

function canReadCentralVacations() {
  return canReadCentralPersonnel() && (
    !state.portalStatus?.portalEnabled
    || state.portalSession?.user?.permissions?.includes("vacation:read") === true
  );
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
  const diagnosticsTechnicalAccess = !lanActive || permissions.includes("system:diagnostics:technical");
  const diagnosticsReadAccess = !lanActive || diagnosticsTechnicalAccess || permissions.includes("system:diagnostics:read");
  const backupWriteAccess = !lanActive || permissions.includes("backup:write");
  const backupConfigurationAccess = backupWriteAccess;
  const backupImportAccess = !serverActive && (!lanActive || ["developer", "it_admin"].includes(role));
  const usbProvisioningAccess = ["developer", "it_admin", "admin"].includes(role)
    && (!lanActive || permissions.includes("usb:provision"));
  const integrationsEnabled = features.integrations !== false;
  const integrationReadAccess = integrationsEnabled && (!lanActive || permissions.includes("integrations:read"));
  const personnelImportAccess = integrationsEnabled && (!lanActive || permissions.includes("employees:import"));
  const payrollExportAccess = integrationsEnabled && (!lanActive || permissions.includes("payroll:export"));
  const integrationProfileWriteAccess = integrationsEnabled && (!lanActive || permissions.includes("integrations:profiles:write"));
  const connectionReadAccess = integrationsEnabled && (!lanActive || permissions.includes("integrations:connections:read"));
  const connectionWriteAccess = integrationsEnabled && (!lanActive || permissions.includes("integrations:connections:write"));
  const credentialWriteAccess = integrationsEnabled && (!lanActive || permissions.includes("integrations:credentials:write"));
  const payrollDeliverAccess = integrationsEnabled && (!lanActive || permissions.includes("payroll:deliver"));
  const integrationAccess = integrationReadAccess || personnelImportAccess || payrollExportAccess || integrationProfileWriteAccess
    || connectionReadAccess || connectionWriteAccess || credentialWriteAccess || payrollDeliverAccess;
  const centralPersonnelReadAccess = canReadCentralPersonnel();
  const centralPersonnelWriteAccess = canWriteCentralPersonnel();
  const costCenterReadAccess = canReadCostCenters();
  const costCenterWriteAccess = canWriteCostCenters();
  const centralVacationReadAccess = canReadCentralVacations() && features.vacation !== false;
  elements.personnelAdministrationNavButton?.classList.toggle("hidden", !centralPersonnelReadAccess);
  document.querySelectorAll('[data-view="personnel"]').forEach((button) => button.classList.toggle("hidden", !employeeReadAccess));
  document.querySelectorAll('[data-view="vacations"]').forEach((button) => button.classList.toggle("hidden", features.vacation === false));
  elements.requestsNavButton?.classList.toggle("hidden", features.requests === false);
  elements.timeTrackingNavButton?.classList.toggle("hidden", !timeReadAccess || features.timeTracking === false);
  elements.rightsDashboardNavButton?.classList.toggle("hidden", !rightsAccess);
  const anySettingsAccess = settingsAccess || scopeAccess || rightsAccess || brandingAccess || positionWriteAccess || operationModeAccess || wifiSettingsAccess || usbProvisioningAccess || integrationAccess || diagnosticsReadAccess || diagnosticsTechnicalAccess || backupWriteAccess;
  document.querySelectorAll('[data-view="settings"]').forEach((button) => button.classList.toggle("hidden", !anySettingsAccess));
  const settingsTabs = {
    general: settingsAccess || operationModeAccess,
    branding: brandingAccess,
    pdf: settingsAccess,
    personnel: settingsAccess || positionWriteAccess || wifiSettingsAccess,
    vacation: features.vacation !== false && (settingsAccess || globalAdministration),
    timeTracking: settingsAccess || (wifiSettingsAccess && features.wifiSuggestions !== false && features.timeTracking !== false),
    integrations: integrationAccess,
    access: (scopeAccess || permissions.includes("users:write") || globalAdministration)
      && (features.employeePortal !== false || features.requests !== false || features.sicknessAmu !== false),
    rights: rightsAccess,
    backup: diagnosticsReadAccess || diagnosticsTechnicalAccess || backupWriteAccess,
    usbProvisioning: usbProvisioningAccess,
  };
  document.querySelectorAll("[data-settings-tab]").forEach((button) => button.classList.toggle("hidden", !settingsTabs[button.dataset.settingsTab]));
  const timeTrackingTabActive = document.querySelector('[data-settings-tab="timeTracking"]')?.classList.contains("active");
  const integrationTabActive = document.querySelector('[data-settings-tab="integrations"]')?.classList.contains("active");
  const usbTabActive = document.querySelector('[data-settings-tab="usbProvisioning"]')?.classList.contains("active");
  const backupTabActive = document.querySelector('[data-settings-tab="backup"]')?.classList.contains("active");
  elements.saveSettingsButton?.classList.toggle("hidden", (!settingsAccess && !backupTabActive) || integrationTabActive || usbTabActive || (timeTrackingTabActive && !settingsAccess) || (backupTabActive && !backupConfigurationAccess));
  elements.saveOperationModeButton?.classList.toggle("hidden", !operationModeAccess || settingsAccess);
  const privilegedServerRole = ["developer", "it_admin", "admin"].includes(role);
  const canExit = serverActive
    ? privilegedServerRole && permissions.includes("system:write")
    : !lanActive || permissions.includes("system:write");
  elements.systemExitButton?.classList.toggle("hidden", !canExit);
  if (elements.systemExitButton) elements.systemExitButton.querySelector("span").textContent = serverActive ? "Server beenden" : "Beenden";
  elements.updateCheckButton?.classList.toggle("hidden", lanActive && !permissions.includes("update:write"));
  document.querySelector('[data-personnel-tab="locations"]')?.classList.toggle("hidden", !locationWriteAccess);
  document.querySelector("#addEmployeeButton")?.classList.toggle("hidden", !(employeeWriteAccess && centralPersonnelWriteAccess));
  elements.addCentralEmployeeButton?.classList.toggle("hidden", !centralPersonnelWriteAccess);
  document.querySelector('[data-personnel-administration-tab="costCenters"]')?.classList.toggle("hidden", !costCenterReadAccess);
  elements.centralVacationsTab?.classList.toggle("hidden", !centralVacationReadAccess);
  elements.addCostCenterButton?.classList.toggle("hidden", !costCenterWriteAccess);
  elements.addLocationButton?.classList.toggle("hidden", !(locationBaseWriteAccess && costCenterWriteAccess));
  elements.addDepartmentButton?.classList.toggle("hidden", !departmentWriteAccess);
  elements.locationFormCard?.classList.toggle("hidden", !locationBaseWriteAccess);
  elements.departmentFormCard?.classList.toggle("hidden", !departmentWriteAccess);
  elements.locationCostCenterField?.classList.toggle("hidden", !costCenterWriteAccess);
  elements.locationCostCenterReadonly?.classList.toggle("hidden", costCenterWriteAccess);
  if (elements.locationCostCenter) elements.locationCostCenter.disabled = !costCenterWriteAccess;
  elements.positionSettingsCard?.classList.toggle("hidden", !positionWriteAccess);
  elements.personnelViewSettingsCard?.classList.toggle("hidden", !settingsAccess);
  elements.trustLevelSettingsCard?.classList.toggle("hidden", !wifiSettingsAccess || !globalAdministration);
  elements.viewBehaviorSettingsCard?.classList.toggle("hidden", !globalAdministration);
  elements.wifiSettingsCard?.classList.toggle("hidden", !wifiSettingsAccess || features.wifiSuggestions === false || features.timeTracking === false);
  elements.employeeImportCard?.classList.toggle("hidden", !personnelImportAccess);
  elements.importProfileCard?.classList.toggle("hidden", !(integrationReadAccess || personnelImportAccess));
  elements.payrollExportCard?.classList.toggle("hidden", !payrollExportAccess);
  elements.exportProfileCard?.classList.toggle("hidden", !(integrationReadAccess || payrollExportAccess));
  elements.integrationHistoryCard?.classList.toggle("hidden", !integrationReadAccess);
  elements.integrationInformationCard?.classList.toggle("hidden", !integrationAccess);
  elements.integrationContractsCard?.classList.toggle("hidden", !integrationReadAccess);
  elements.integrationConnectionsCard?.classList.toggle("hidden", !(connectionReadAccess || connectionWriteAccess));
  elements.addIntegrationConnectionButton?.classList.toggle("hidden", !connectionWriteAccess);
  elements.integrationDeliveryHistory?.closest("details")?.classList.toggle("hidden", !integrationReadAccess);
  const sqlSourceOption = elements.personnelImportSourceType?.querySelector('option[value="sql"]');
  if (sqlSourceOption) { sqlSourceOption.hidden = !connectionReadAccess; sqlSourceOption.disabled = !connectionReadAccess; }
  if (!connectionReadAccess && elements.personnelImportSourceType?.value === "sql") elements.personnelImportSourceType.value = "file";
  updatePersonnelImportSourceFields();
  elements.payrollApiTargetField?.classList.toggle("hidden", !(payrollDeliverAccess && connectionReadAccess));
  elements.payrollDeliverButton?.classList.toggle("hidden", !(payrollDeliverAccess && connectionReadAccess));
  if (elements.savePersonnelImportProfileButton) elements.savePersonnelImportProfileButton.disabled = !integrationProfileWriteAccess;
  if (elements.savePayrollProfileButton) elements.savePayrollProfileButton.disabled = !integrationProfileWriteAccess;
  elements.employeeTimeConfirmationLevelField?.classList.toggle("hidden", !wifiSettingsAccess);
  elements.workflowSettingsCard?.classList.toggle("hidden", lanActive && !permissions.includes("hr:settings"));
  elements.amuSettingsCard?.classList.toggle("hidden", lanActive && !permissions.includes("hr:settings"));
  if (features.sicknessAmu === false) elements.amuSettingsCard?.classList.add("hidden");
  elements.greetingSettingsCard?.classList.toggle("hidden", !greetingSettingsAccess || features.employeePortal === false);
  elements.serverDiagnosticsCard?.classList.toggle("hidden", !(diagnosticsReadAccess || diagnosticsTechnicalAccess));
  elements.refreshServerDiagnosticsButton?.classList.toggle("hidden", !(diagnosticsReadAccess || diagnosticsTechnicalAccess));
  elements.databaseBackupSettingsCard?.classList.toggle("hidden", !backupWriteAccess);
  elements.backupRestoreGuidanceCard?.classList.toggle("hidden", !(serverActive && diagnosticsTechnicalAccess));
  document.querySelector("#backupImportCard")?.classList.toggle("hidden", !backupImportAccess);
  [document.querySelector("#externalBackupEnabled"), document.querySelector("#backupDirectory"), document.querySelector("#backupIntervalHours")]
    .forEach((input) => { if (input) input.disabled = !backupConfigurationAccess; });
  const createBackupButton = document.querySelector("#createBackupButton");
  if (createBackupButton) createBackupButton.disabled = !backupWriteAccess;
  elements.delegationSettingsCard?.classList.toggle("hidden", !settingsAccess);
  elements.generalSettings?.querySelectorAll(".settings-card:not(.operation-mode-card)").forEach((card) => card.classList.toggle("hidden", !settingsAccess));
  if (globalAdministration) elements.viewBehaviorSettingsCard?.classList.remove("hidden");
  [elements.localModeOption, elements.serverModeOption, elements.publicServerModeOption].forEach((button) => { if (button) button.disabled = !operationModeAccess; });
  if (!locationWriteAccess && state.personnelTab === "locations") setPersonnelTab("employees");
  if (!costCenterReadAccess && state.personnelAdministrationTab === "costCenters") setPersonnelAdministrationTab("employees");
  if (!centralVacationReadAccess && state.personnelAdministrationTab === "vacations") setPersonnelAdministrationTab("employees");
  if (!centralPersonnelReadAccess && state.currentView === "personnelAdministration") setView("planning");
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
    await Promise.all([loadAll(), loadSystemInfo(), loadManagementBrandingPreference(), loadUiPreferences()]);
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
    await Promise.all([loadAll(), loadSystemInfo(), loadManagementBrandingPreference(), loadUiPreferences()]);
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
  if (state.portalStatus?.adminSetupAvailable !== true) {
    showToast("Die Admin-Ersteinrichtung ist nur im lokalen Einrichtungsmodus verfügbar.", true);
    return;
  }
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
    restoreRememberedOverallContext(state.currentView, state.locations);
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
  renderPersonnelAdministration();
  renderEmployees();
  renderLocations();
  renderPositions();
  renderSettings();
}

function navigationGroups() {
  return {
    filialManagement: { toggle: elements.filialManagementToggle, children: elements.filialManagementNavChildren },
    planning: { toggle: document.querySelector('[data-nav-toggle="planning"]'), children: elements.planningNavChildren },
    vacations: { toggle: document.querySelector('[data-nav-toggle="vacations"]'), children: elements.vacationNavChildren },
  };
}

function setNavigationCurrent(element, current) {
  if (!element) return;
  if (current) element.setAttribute("aria-current", "page");
  else element.removeAttribute("aria-current");
}

function applyNavigationGroupState(key, visible = true) {
  const group = navigationGroups()[key];
  if (!group?.toggle || !group.children) return false;
  const open = localStorage.getItem(`grabenplaner-nav-${key}`) !== "closed";
  group.children.classList.toggle("hidden", !visible || !open);
  group.toggle.classList.toggle("hidden", !visible);
  group.toggle.classList.toggle("expanded", open);
  group.toggle.setAttribute("aria-expanded", String(open));
  return open;
}

function renderContextNavigation() {
  const locations = activeLocations();
  const departmentOnly = state.portalSession?.user?.role === "department_manager";
  const filialViewActive = ["personnel", "planning", "vacations"].includes(state.currentView);
  elements.filialManagementNav?.classList.toggle("contains-active", filialViewActive);
  applyNavigationGroupState("filialManagement", true);
  setNavigationCurrent(elements.filialTeamsNavButton, state.currentView === "personnel");
  setNavigationCurrent(elements.planningNavButton, state.currentView === "planning");
  setNavigationCurrent(elements.vacationsNavButton, state.currentView === "vacations");
  const planningContexts = locations.flatMap((location) => departmentOnly
    ? (location.departments || []).map((department) => ({ locationId: location.id, departmentId: String(department.id), label: `${location.name} · ${department.name}` }))
    : [{ locationId: location.id, departmentId: "", label: `${location.name} · Gesamtplan` }]);
  const showPlanningChildren = planningContexts.length > 1;
  applyNavigationGroupState("planning", showPlanningChildren);
  elements.planningNavChildren.innerHTML = showPlanningChildren ? planningContexts.map((item) => `
    <button type="button" class="nav-child ${state.currentView === "planning" && item.locationId === state.locationId && String(item.departmentId || "") === String(state.departmentId || "") ? "active" : ""}" ${state.currentView === "planning" && item.locationId === state.locationId && String(item.departmentId || "") === String(state.departmentId || "") ? 'aria-current="page"' : ""} data-context-view="planning" data-location-id="${escapeHtml(item.locationId)}" data-department-id="${escapeHtml(item.departmentId)}">${escapeHtml(item.label)}</button>
  `).join("") : "";

  const showVacationChildren = locations.length > 1;
  applyNavigationGroupState("vacations", showVacationChildren);
  elements.vacationNavChildren.innerHTML = showVacationChildren ? locations.map((location) => `
    <button type="button" class="nav-child ${state.currentView === "vacations" && location.id === state.locationId ? "active" : ""}" ${state.currentView === "vacations" && location.id === state.locationId ? 'aria-current="page"' : ""} data-context-view="vacations" data-location-id="${escapeHtml(location.id)}" data-department-id="${departmentOnly ? escapeHtml(String(location.departments?.[0]?.id || "")) : ""}">${escapeHtml(location.name)}</button>
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
            return `<button class="shift-bar" type="button" data-shift-id="${shift.id}" style="top:${top}%;height:${height}%;--employee-color:${employee.color};--employee-contrast:${contrastColor(employee.color)}" title="${shift.start_time}–${shift.end_time} · ${formatHours(shift.counted_minutes)}${departmentLabel ? ` · ${escapeHtml(departmentLabel)}` : ""}" aria-label="${escapeHtml(employee.nickname)} ${shift.start_time} bis ${shift.end_time}">${departmentLabel ? `<span>${escapeHtml(departmentLabel)}</span>` : ""}</button>`;
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
    state.centralVacationLoadedYear = null;
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
    state.centralVacationLoadedYear = null;
    state.editingVacationEntitlements = false;
    showToast("Jahresurlaub wurde gespeichert.");
    renderVacations();
  } catch (error) { showToast(error.message, true); }
}

async function deleteVacation(groupId) {
  if (!groupId || !confirm("Diesen Urlaubseintrag wirklich löschen?")) return;
  try {
    await api(`/api/vacations/${encodeURIComponent(groupId)}`, { method: "DELETE" });
    state.centralVacationLoadedYear = null;
    showToast("Urlaubseintrag wurde gelöscht.");
    await loadAll();
  } catch (error) { showToast(error.message, true); }
}

function operationModeLabel(mode) {
  return mode === "server" ? "HTTPS-Server" : mode === "lan" ? "LAN-Host" : "Lokal";
}

function diagnosticTimestamp(value) {
  if (!value) return "noch ausständig";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "unbekannt";
  return new Intl.DateTimeFormat("de-AT", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function diagnosticAge(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours)) return "";
  if (hours < 1) return " · vor weniger als 1 h";
  if (hours < 48) return ` · vor ${Math.round(hours)} h`;
  return ` · vor ${Math.round(hours / 24)} Tagen`;
}

function renderOffsiteBackupDiagnostics(offsite) {
  if (!offsite?.applicable) return "";
  const configured = Boolean(offsite?.configured);
  const state = configured ? String(offsite?.state || "warning") : "unconfigured";
  const stateLabel = state === "ok" ? "Geschützt" : state === "error" ? "Fehler" : configured ? "Prüfen" : "Nicht eingerichtet";
  const summary = String(offsite?.summary || (configured
    ? (state === "ok"
      ? "Die verschlüsselte externe Sicherung ist aktuell."
      : "Die externe Sicherung oder eine Wiederherstellungsprüfung benötigt Aufmerksamkeit. Der Grabenplaner bleibt erreichbar.")
    : "Für diesen Server ist noch kein verschlüsseltes Offsite-Backup eingerichtet."));
  const retention = offsite?.retention || {};
  const unresolved = offsite?.unresolvedFailures || {};
  const unresolvedLabels = [
    unresolved.backup ? "tägliche Sicherung" : "",
    unresolved.fullCheck ? "Monatsprüfung" : "",
    unresolved.restoreTest ? "Test-Wiederherstellung" : "",
  ].filter(Boolean);
  const failure = offsite?.lastErrorCode
    ? `${offsite.lastErrorCode} · ${diagnosticTimestamp(offsite?.lastFailureAt)}`
    : unresolvedLabels.length ? `Offen: ${unresolvedLabels.join(", ")}` : "";
  const snapshotDetail = offsite?.lastSnapshotId ? ` · ${escapeHtml(offsite.lastSnapshotId)}` : "";
  return `
    <section class="offsite-diagnostics ${state === "ok" ? "ok" : "warning"}">
      <div class="offsite-diagnostics-heading"><div><span class="eyebrow">Verschlüsselte externe Sicherung</span><strong>Offsite-Backup</strong><small>${escapeHtml(summary)}</small></div><span class="status-badge ${state === "ok" ? "active" : "inactive"}">${escapeHtml(stateLabel)}</span></div>
      <div class="diagnostic-grid offsite-diagnostic-grid">
        <span><small>Letzter Snapshot</small><strong>${escapeHtml(diagnosticTimestamp(offsite?.lastSuccessAt))}${escapeHtml(diagnosticAge(offsite?.agesHours?.backup))}${snapshotDetail}</strong></span>
        <span><small>Repository-Prüfung</small><strong>${escapeHtml(diagnosticTimestamp(offsite?.lastRepositoryCheckAt))}${escapeHtml(diagnosticAge(offsite?.agesHours?.repositoryCheck))}</strong></span>
        <span><small>Vollständiger Monatscheck</small><strong>${escapeHtml(diagnosticTimestamp(offsite?.lastFullCheckAt))}${escapeHtml(diagnosticAge(offsite?.agesHours?.fullCheck))}</strong></span>
        <span><small>Isolierter Test-Restore</small><strong>${escapeHtml(diagnosticTimestamp(offsite?.lastRestoreTestAt))}${escapeHtml(diagnosticAge(offsite?.agesHours?.restoreTest))}</strong></span>
        <span><small>Letzter Versuch</small><strong>${escapeHtml(diagnosticTimestamp(offsite?.lastAttemptAt))}${escapeHtml(diagnosticAge(offsite?.agesHours?.attempt))}</strong></span>
        <span><small>Aufbewahrung</small><strong>${Number(retention.daily || 14)} täglich · ${Number(retention.weekly || 8)} wöchentlich · ${Number(retention.monthly || 12)} monatlich</strong></span>
      </div>
      ${failure ? `<p class="offsite-diagnostic-error"><strong>Letzter Fehler:</strong> ${escapeHtml(failure)}</p>` : ""}
    </section>`;
}

const serverMonitorCheckLabels = {
  appService: "App-Dienst",
  proxyService: "HTTPS-Proxy",
  live: "Live-Prüfung",
  ready: "Ready-Prüfung",
  publicReady: "Öffentliche Ready-Prüfung",
  hsts: "HSTS",
  contentSecurityPolicy: "Content-Security-Policy",
  contentTypeOptions: "Content-Type-Schutz",
  referrerPolicy: "Referrer-Policy",
  tlsCertificate: "TLS-Zertifikat",
  sqlite: "SQLite",
  backupFresh: "Sicherungsalter",
  backupIntegrity: "Sicherungsintegrität",
  amuScanner: "AUM-Virenscanner",
  caddyConfiguration: "Caddy-Konfiguration",
  offsite: "Offsite-Sicherung",
  diskSpace: "Freier Speicher",
  monitorTimer: "Monitor-Zeitplan",
  monitorStatusProtection: "Schutz der Statusdatei",
};

const hostSecurityCheckLabels = {
  ssh: "SSH-Schlüsselzugang",
  firewall: "UFW-Firewall",
  publicPorts: "Öffentliche Ports",
  automaticUpdates: "Sicherheitsaktualisierungen",
  sysctl: "Kernel-Schutzwerte",
  journald: "Systemprotokolle",
  accountProtection: "Dienstkonten",
  secretFiles: "Geheimnisdateien",
  failedUnits: "Systemdienste",
  timeSync: "Zeitsynchronisierung",
};

function renderGlobalServerAlert(status) {
  if (!elements.serverAlertBanner) return;
  const alerts = Array.isArray(status?.alerts) ? [...status.alerts] : [];
  const priority = { critical: 3, warning: 2, info: 1 };
  alerts.sort((left, right) => (priority[right.severity] || 0) - (priority[left.severity] || 0));
  const alert = alerts[0];
  elements.serverAlertBanner.classList.toggle("hidden", !alert);
  elements.serverAlertBanner.classList.toggle("critical", alert?.severity === "critical");
  elements.serverAlertBanner.classList.toggle("warning", alert?.severity !== "critical");
  if (!alert) return;
  elements.serverAlertTitle.textContent = alert.title || "Serverzustand prüfen";
  elements.serverAlertMessage.textContent = `${alert.message || "Eine technische Warnung benötigt Aufmerksamkeit."}${alerts.length > 1 ? ` · ${alerts.length - 1} weitere Meldung(en)` : ""}`;
}

function backupPointText(point) {
  if (!point?.available) return "noch kein bestätigter Sicherungsstand";
  if (point.timestampValid === false) return "Zeitstempel unplausibel · bitte prüfen";
  return `${diagnosticTimestamp(point.createdAt)}${diagnosticAge(point.ageHours)}${point.verified ? " · geprüft" : ""}`;
}

function renderMonitorDiagnostics(monitor) {
  if (!monitor?.configured) return "";
  const failed = Array.isArray(monitor.failedChecks) ? monitor.failedChecks : [];
  const failedText = failed.length
    ? failed.map((id) => serverMonitorCheckLabels[id] || id).join(", ")
    : "keine offenen Prüfpunkte";
  const stateLabel = monitor.state === "ok" ? "Erfolgreich" : monitor.state === "error" ? "Fehler" : "Prüfen";
  const recovery = monitor.recovery || {};
  const recoveryText = recovery.successful ? "automatischer Wiederanlauf erfolgreich"
    : recovery.suppressed ? "Wiederanlauf aus Sicherheitsgründen unterdrückt"
      : recovery.attempted ? "Wiederanlauf versucht" : "kein Wiederanlauf erforderlich";
  return `
    <section class="monitor-diagnostics ${monitor.state === "ok" ? "ok" : "warning"}">
      <div class="offsite-diagnostics-heading"><div><span class="eyebrow">Automatische Betriebsüberwachung</span><strong>Server-Monitor</strong><small>${escapeHtml(failedText)}</small></div><span class="status-badge ${monitor.state === "ok" ? "active" : "inactive"}">${escapeHtml(stateLabel)}</span></div>
      <div class="diagnostic-grid">
        <span><small>Letzter vollständiger Lauf</small><strong>${escapeHtml(diagnosticTimestamp(monitor.generatedAt))}${escapeHtml(diagnosticAge(monitor.ageHours))}</strong></span>
        <span><small>Live-Fehler in Folge</small><strong>${Number(monitor.consecutiveLiveFailures || 0)}</strong></span>
        <span><small>Letzter Neustart</small><strong>${escapeHtml(diagnosticTimestamp(monitor.lastRestartAt))}</strong></span>
        <span><small>Wiederanlauf</small><strong>${escapeHtml(recoveryText)}</strong></span>
      </div>
      ${monitor.lastErrorCode ? `<p class="offsite-diagnostic-error"><strong>Fehlercode:</strong> ${escapeHtml(monitor.lastErrorCode)}</p>` : ""}
    </section>`;
}

function renderHostSecurityDiagnostics(hostSecurity) {
  if (!hostSecurity?.configured && !hostSecurity?.statusAvailable) return "";
  const failed = Array.isArray(hostSecurity.failedChecks) ? hostSecurity.failedChecks : [];
  const failedText = failed.length
    ? failed.map((id) => hostSecurityCheckLabels[id] || id).join(", ")
    : "keine offenen Prüfpunkte";
  const stateLabel = !hostSecurity.configured ? "Nicht aktiviert"
    : hostSecurity.state === "ok" ? "Geschützt" : hostSecurity.state === "error" ? "Fehler" : "Prüfen";
  const transactionText = hostSecurity.pendingConfirmation
    ? "Bestätigung aus zweiter SSH-Sitzung ausständig"
    : "keine offene Sicherheitstransaktion";
  const rebootText = hostSecurity.rebootRequired ? "im Wartungsfenster erforderlich" : "derzeit nicht erforderlich";
  return `
    <section class="monitor-diagnostics ${hostSecurity.state === "ok" || !hostSecurity.configured ? "ok" : "warning"}">
      <div class="offsite-diagnostics-heading"><div><span class="eyebrow">Ubuntu-Host</span><strong>Host-Sicherheit</strong><small>${escapeHtml(failedText)}</small></div><span class="status-badge ${hostSecurity.state === "ok" ? "active" : "inactive"}">${escapeHtml(stateLabel)}</span></div>
      <div class="diagnostic-grid">
        <span><small>Letzte Prüfung</small><strong>${escapeHtml(diagnosticTimestamp(hostSecurity.checkedAt))}${escapeHtml(diagnosticAge(hostSecurity.ageHours))}</strong></span>
        <span><small>Sicherheitstransaktion</small><strong>${escapeHtml(transactionText)}</strong></span>
        <span><small>Neustart</small><strong>${escapeHtml(rebootText)}</strong></span>
        <span><small>Statusdatei</small><strong>${hostSecurity.statusAvailable ? "geschützt verfügbar" : "nicht verfügbar"}</strong></span>
      </div>
      ${hostSecurity.lastErrorCode ? `<p class="offsite-diagnostic-error"><strong>Fehlercode:</strong> ${escapeHtml(hostSecurity.lastErrorCode)}</p>` : ""}
    </section>`;
}

function renderServerDiagnostics(status, technical = null) {
  if (!elements.serverDiagnostics || !status) return;
  const alerts = Array.isArray(status.alerts) ? status.alerts : [];
  const alertMarkup = alerts.length
    ? `<div class="diagnostic-alerts">${alerts.map((alert) => `<article class="${escapeHtml(alert.severity || "warning")}"><strong>${escapeHtml(alert.title || "Serverzustand prüfen")}</strong><span>${escapeHtml(alert.message || "")}</span></article>`).join("")}</div>`
    : '<p class="diagnostic-all-clear">Keine Warnungen in der aktuellen Betriebsübersicht.</p>';
  const offsite = status.backups?.offsite || {};
  const hostSecurity = status.hostSecurity || {};
  const recovery = status.recovery || {};
  const recoveryState = recovery.isolatedRestoreTestPending ? "warning" : "ok";
  const technicalChecks = Array.isArray(technical?.productionChecks) ? technical.productionChecks : [];
  const technicalMarkup = technical ? `
    <details class="technical-diagnostics">
      <summary>Technische Details anzeigen</summary>
      <div class="diagnostic-grid">
        <span><small>HTTPS-Pflicht</small><strong>${technical.httpsRequired ? "aktiv" : "nur Servermodus"}</strong></span>
        <span><small>Passwortminimum</small><strong>${Number(technical.passwordMinLength || 6)} Zeichen</strong></span>
        <span><small>SQLite</small><strong>${escapeHtml(technical.database?.journalMode || "–")} · ${Number(technical.database?.busyTimeoutMs || 0)} ms</strong></span>
        <span><small>Integrität</small><strong>${escapeHtml(technical.database?.integrity || "unbekannt")}</strong></span>
        <span><small>Migration</small><strong>${escapeHtml(technical.database?.migration?.id || "–")}</strong></span>
        <span><small>Instanzschutz</small><strong>${technical.instanceLock?.held ? "aktiv" : technical.instanceLock?.enabled ? "beim Serverstart" : "nicht nötig"}</strong></span>
        <span><small>Aktive Sitzungen</small><strong>${Number(technical.security?.activeSessions || 0)}</strong></span>
        <span><small>AUM-Speicher</small><strong>${technical.storage?.amu?.ok ? "verschlüsselt bereit" : "nicht bereit"}</strong></span>
      </div>
      <div class="pilot-checklist"><strong>Technische Serverprüfung</strong>${technicalChecks.map((check) => `<span class="${check.ok ? "ok" : "warning"}"><i>${check.ok ? "✓" : "!"}</i><b>${escapeHtml(check.label)}</b><small>${escapeHtml(check.detail || "")}</small></span>`).join("")}</div>
    </details>` : "";
  elements.serverDiagnostics.innerHTML = `
    <div class="diagnostic-readiness-grid">
      <article class="${status.live?.ok ? "ok" : "warning"}"><small>Live</small><strong>${status.live?.ok ? "Prozess erreichbar" : "Nicht erreichbar"}</strong><span>Die Anwendung beantwortet Anfragen.</span></article>
      <article class="${status.ready?.ok ? "ok" : "warning"}"><small>Ready</small><strong>${status.ready?.ok ? "Betriebsbereit" : "Nicht betriebsbereit"}</strong><span>${escapeHtml(operationModeLabel(status.mode))}${status.publicUrl ? ` · ${escapeHtml(status.publicUrl)}` : ""}</span></article>
    </div>
    <div class="diagnostic-grid backup-status-grid">
      <span><small>Interne Sicherung</small><strong>${escapeHtml(backupPointText(status.backups?.internal))}</strong></span>
      <span><small>Getrennte lokale Sicherung</small><strong>${escapeHtml(status.backups?.external?.enabled ? backupPointText(status.backups.external) : "deaktiviert")}</strong></span>
      <span><small>Externes Sicherungsziel</small><strong>${status.backups?.external?.enabled ? (status.backups.external.writable ? "beschreibbar" : "nicht beschreibbar") : "nicht aktiv"}</strong></span>
      <span><small>Letzte Statusprüfung</small><strong>${escapeHtml(diagnosticTimestamp(status.checkedAt))}</strong></span>
    </div>
    ${renderOffsiteBackupDiagnostics(offsite)}
    ${renderMonitorDiagnostics(status.monitor)}
    ${renderHostSecurityDiagnostics(hostSecurity)}
    <section class="recovery-diagnostics ${recoveryState}">
      <div><span class="eyebrow">Wiederherstellungsnachweis</span><strong>Isolierter Test-Restore</strong><small>${recovery.isolatedRestoreTestPending ? "Noch ausständig, überfällig oder zuletzt fehlgeschlagen." : "Der letzte isolierte Wiederherstellungstest ist bestätigt."}</small></div>
      <span><strong>${escapeHtml(diagnosticTimestamp(recovery.isolatedRestoreTestAt))}${escapeHtml(diagnosticAge(recovery.isolatedRestoreTestAgeHours))}</strong><small>Produktive Wiederherstellungen bleiben ein beaufsichtigter Wartungsvorgang.</small></span>
    </section>
    ${alertMarkup}
    ${technicalMarkup}`;
  renderGlobalServerAlert(status);
}

async function refreshServerDiagnostics() {
  try {
    const permissions = state.portalSession?.user?.permissions || [];
    const localAccess = state.portalStatus?.portalEnabled !== true;
    const technicalAccess = localAccess || permissions.includes("system:diagnostics:technical");
    const status = await api("/api/server-status");
    const technical = technicalAccess ? await api("/api/server-diagnostics") : null;
    state.serverStatus = status;
    state.serverDiagnostics = technical;
    renderServerDiagnostics(status, technical);
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
    if (elements.appBackupDirectoryText) elements.appBackupDirectoryText.textContent = info.appBackupDirectory || "geschützter interner Sicherungsbereich";
    const backupCreatedAt = info.lastBackup?.createdAt || info.lastBackup?.externalBackup?.createdAt || info.lastBackup?.appBackup?.createdAt;
    elements.systemData.innerHTML = `
      <span><strong>Serverzeit</strong> ${escapeHtml(info.serverTime)} Uhr</span>
      <span><strong>App</strong> ${escapeHtml(appName)} ${escapeHtml(info.appVersionLabel)}</span>
      <span><strong>Betriebsmodus</strong> ${escapeHtml(operationModeLabel(info.portal?.operationMode))}</span>
      <span><strong>Node.js</strong> ${escapeHtml(info.nodeVersion)}</span>
      <span><strong>SQLite</strong> ${escapeHtml(info.sqliteVersion)}</span>
      <span><strong>System</strong> ${escapeHtml(info.platform)}</span>
      <span><strong>Datenbank</strong> ${escapeHtml(info.database)}</span>
      <span><strong>Interne Sicherung</strong> ${escapeHtml(info.appBackupDirectory || "geschützter App-Datenbereich")}</span>
      <span><strong>Lokales Sicherungsziel</strong> ${info.externalBackupEnabled ? escapeHtml(info.backupDirectory || "konfiguriert") : "deaktiviert"}</span>
      <span><strong>Letztes Backup</strong> ${backupCreatedAt ? escapeHtml(new Intl.DateTimeFormat("de-AT", { dateStyle: "short", timeStyle: "short" }).format(new Date(backupCreatedAt))) : "noch ausständig"}</span>
      <span><strong>Laufzeit</strong> ${uptimeHours} h ${uptimeMinutes} min</span>`;
    state.serverStatus = info.serverStatus || null;
    state.serverDiagnostics = info.serverDiagnostics || null;
    if (info.serverStatus) renderServerDiagnostics(info.serverStatus, info.serverDiagnostics || null);
    else renderGlobalServerAlert(null);
  } catch {
    elements.systemData.textContent = "Technische Daten konnten nicht geladen werden.";
  }
}

function formatOptionDates(option) {
  return option.date_from === option.date_to
    ? formatDate(option.date_from, { day: "2-digit", month: "2-digit" })
    : `${formatDate(option.date_from, { day: "2-digit", month: "2-digit" })}–${formatDate(option.date_to, { day: "2-digit", month: "2-digit" })}`;
}

function personnelRecordAvailableInUi() {
  if (!state.portalStatus?.portalEnabled) return true;
  const capability = state.portalSession?.user?.personnelRecordAccess?.available;
  if (typeof capability === "boolean") return capability;
  return state.portalSession?.user?.permissions?.some((permission) => [
    "personnel:sensitive:read", "personnel:sensitive:write", "personnel:phone:read", "personnel:phone:write", "amu:metadata:read",
  ].includes(permission)) === true;
}

function apiList(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function normalizedActive(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  return ![false, 0, "0"].includes(value);
}

function normalizeCostCenter(item = {}) {
  return {
    ...item,
    id: item.id ?? item.cost_center_id ?? item.costCenterId ?? item.code ?? "",
    code: String(item.code ?? item.cost_center_code ?? item.costCenterCode ?? ""),
    name: String(item.name ?? item.cost_center_name ?? item.costCenterName ?? ""),
    type: String(item.type ?? item.cost_center_type ?? item.costCenterType ?? "other"),
    description: String(item.description ?? ""),
    active: normalizedActive(item.active),
    employee_count: Number(item.employee_count ?? item.employeeCount ?? 0),
    location_count: Number(item.location_count ?? item.locationCount ?? 0),
  };
}

function normalizePersonnelDirectoryEmployee(item = {}) {
  const personnelNumber = String(item.personnel_number ?? item.personnelNumber ?? item.employee_number ?? item.employeeNumber ?? "");
  const scoped = state.allEmployees.find((employee) => String(employee.personnel_number) === personnelNumber) || {};
  const merged = { ...scoped, ...item };
  return {
    ...merged,
    personnel_number: personnelNumber,
    full_name: String(merged.full_name ?? merged.fullName ?? ""),
    nickname: String(merged.nickname ?? ""),
    position_name: String(merged.position_name ?? merged.positionName ?? ""),
    position_id: merged.position_id ?? merged.positionId ?? "",
    cost_center_id: merged.cost_center_id ?? merged.costCenterId ?? "",
    cost_center_code: String(merged.cost_center_code ?? merged.costCenterCode ?? ""),
    cost_center_name: String(merged.cost_center_name ?? merged.costCenterName ?? ""),
    cost_center_type: String(merged.cost_center_type ?? merged.costCenterType ?? ""),
    home_location_id: merged.home_location_id ?? merged.homeLocationId ?? "",
    home_location_name: String(merged.home_location_name ?? merged.homeLocationName ?? ""),
    preferred_department_id: merged.preferred_department_id ?? merged.preferredDepartmentId ?? "",
    preferred_department_name: String(merged.preferred_department_name ?? merged.preferredDepartmentName ?? ""),
    contracted_hours: Number(merged.contracted_hours ?? merged.contractedHours ?? 0),
    target_workdays_per_week: Number(merged.target_workdays_per_week ?? merged.targetWorkdaysPerWeek ?? 5),
    active: normalizedActive(merged.active),
  };
}

function costCenterTypeLabel(type) {
  return ({ branch: "Filiale", administration: "Verwaltung", production: "Produktion", other: "Sonstige" })[type] || "Sonstige";
}

async function loadPersonnelAdministration({ force = false } = {}) {
  if (!canReadCentralPersonnel() || state.personnelAdministrationLoading) return;
  if (state.personnelAdministrationLoaded && !force) {
    renderPersonnelAdministration();
    return;
  }
  state.personnelAdministrationLoading = true;
  if (elements.personnelDirectoryBody) elements.personnelDirectoryBody.innerHTML = '<tr><td colspan="8">Personalstammdaten werden geladen.</td></tr>';
  try {
    const [directoryPayload, costCenterPayload] = await Promise.all([
      api("/api/personnel-directory"),
      canReadCostCenters()
        ? api("/api/cost-centers?includeInactive=1").catch((error) => {
          if ([403, 404].includes(error.status)) return [];
          throw error;
        })
        : Promise.resolve([]),
    ]);
    state.personnelDirectory = apiList(directoryPayload, ["employees", "items", "personnel"])
      .map(normalizePersonnelDirectoryEmployee);
    state.costCenters = apiList(costCenterPayload, ["costCenters", "cost_centers", "items"])
      .map(normalizeCostCenter);
    state.personnelAdministrationLoaded = true;
    renderPersonnelAdministration();
  } catch (error) {
    if (elements.personnelDirectoryBody) elements.personnelDirectoryBody.innerHTML = `<tr><td colspan="8">${escapeHtml(error.message)}</td></tr>`;
    if (elements.costCenterList) elements.costCenterList.innerHTML = `<p class="settings-note">${escapeHtml(error.message)}</p>`;
    showToast(error.message, true);
  } finally {
    state.personnelAdministrationLoading = false;
  }
}

function filteredPersonnelDirectory() {
  const search = state.personnelDirectorySearch.trim().toLocaleLowerCase("de-AT");
  const costCenter = state.personnelDirectoryCostCenterFilter;
  const status = state.personnelDirectoryStatusFilter;
  return state.personnelDirectory.filter((employee) => {
    if (status === "active" && !employee.active) return false;
    if (status === "inactive" && employee.active) return false;
    if (status === "unassigned" && employee.cost_center_id) return false;
    if (costCenter && String(employee.cost_center_id) !== String(costCenter)) return false;
    if (!search) return true;
    return [employee.personnel_number, employee.full_name, employee.nickname, employee.position_name,
      employee.cost_center_code, employee.cost_center_name, employee.home_location_name, employee.preferred_department_name]
      .some((value) => String(value || "").toLocaleLowerCase("de-AT").includes(search));
  }).sort((left, right) => String(left.personnel_number).localeCompare(String(right.personnel_number), "de-AT", { numeric: true, sensitivity: "base" }));
}

function renderPersonnelAdministrationSummary() {
  if (!elements.personnelAdministrationSummary) return;
  const total = state.personnelDirectory.length;
  const active = state.personnelDirectory.filter((employee) => employee.active).length;
  const inactive = total - active;
  const unassigned = state.personnelDirectory.filter((employee) => !employee.cost_center_id).length;
  elements.personnelAdministrationSummary.innerHTML = [
    ["Beschäftigte", total, "gesamt"],
    ["Aktiv", active, "aktuelle Personalstämme"],
    ["Inaktiv", inactive, "historisch erhalten"],
    ["Ohne Kostenstelle", unassigned, unassigned ? "Zuordnung nachpflegen" : "vollständig zugeordnet"],
  ].map(([label, value, note], index) => `<article class="personnel-administration-stat ${index === 3 && value ? "warning" : ""}"><span>${escapeHtml(label)}</span><strong>${Number(value)}</strong><small>${escapeHtml(note)}</small></article>`).join("");
}

function renderPersonnelDirectory() {
  if (!elements.personnelDirectoryBody) return;
  const currentCostCenter = state.personnelDirectoryCostCenterFilter;
  elements.personnelDirectoryCostCenterFilter.innerHTML = `<option value="">Alle Kostenstellen</option>${state.costCenters
    .slice().sort((left, right) => left.code.localeCompare(right.code, "de-AT", { numeric: true }))
    .map((center) => `<option value="${escapeHtmlAttribute(String(center.id))}">${escapeHtml(`${center.code} · ${center.name}${center.active ? "" : " · inaktiv"}`)}</option>`).join("")}`;
  if ([...elements.personnelDirectoryCostCenterFilter.options].some((option) => option.value === String(currentCostCenter))) {
    elements.personnelDirectoryCostCenterFilter.value = String(currentCostCenter);
  } else {
    state.personnelDirectoryCostCenterFilter = "";
  }
  const rows = filteredPersonnelDirectory();
  const canEdit = canWriteCentralPersonnel();
  const canOpenRecord = personnelRecordAvailableInUi();
  elements.personnelDirectoryBody.innerHTML = rows.length ? rows.map((employee) => {
    const costCenter = employee.cost_center_id
      ? [employee.cost_center_code, employee.cost_center_name].filter(Boolean).join(" · ") || "Zugeordnet"
      : "Nicht zugeordnet";
    const location = [employee.home_location_name || employee.home_location_id, employee.preferred_department_name].filter(Boolean).join(" · ") || "Keine Stammfiliale";
    const actions = [
      canEdit ? `<button type="button" class="edit-button" data-central-edit-employee="${escapeHtmlAttribute(employee.personnel_number)}">Stammdaten</button>` : "",
      canOpenRecord ? `<button type="button" class="edit-button" data-central-personnel-record="${escapeHtmlAttribute(employee.personnel_number)}">Personalakt</button>` : "",
    ].filter(Boolean).join("");
    return `<tr class="${employee.cost_center_id ? "" : "personnel-directory-unassigned"}">
      <td data-label="Personalnr."><strong>${escapeHtml(employee.personnel_number)}</strong></td>
      <td data-label="Name"><strong>${escapeHtml(employee.full_name || employee.nickname || "–")}</strong>${employee.nickname && employee.nickname !== employee.full_name ? `<small>${escapeHtml(employee.nickname)}</small>` : ""}</td>
      <td data-label="Position">${escapeHtml(employee.position_name || "–")}</td>
      <td data-label="Kostenstelle"><span class="status-badge ${employee.cost_center_id ? "" : "warning"}">${escapeHtml(costCenter)}</span></td>
      <td data-label="Filiale / Abteilung">${escapeHtml(location)}</td>
      <td data-label="Wochen-Soll">${escapeHtml(String(employee.contracted_hours).replace(".", ","))} h · ${Number(employee.target_workdays_per_week || 5)} T.</td>
      <td data-label="Status"><span class="status-badge ${employee.active ? "" : "inactive"}">${employee.active ? "Aktiv" : "Inaktiv"}</span></td>
      <td data-label="Aktionen"><span class="table-actions">${actions || "–"}</span></td>
    </tr>`;
  }).join("") : '<tr><td colspan="8" class="personnel-directory-empty">Keine passenden Mitarbeitenden gefunden.</td></tr>';
}

function renderCostCenters() {
  if (!elements.costCenterList) return;
  const canEdit = canWriteCostCenters();
  const centers = state.costCenters.slice().sort((left, right) => left.code.localeCompare(right.code, "de-AT", { numeric: true, sensitivity: "base" }));
  elements.costCenterList.innerHTML = centers.length ? centers.map((center) => `
    <article class="cost-center-card ${center.active ? "" : "inactive"}">
      <div class="cost-center-card-code"><strong>${escapeHtml(center.code || "–")}</strong><span class="status-badge ${center.active ? "" : "inactive"}">${center.active ? "Aktiv" : "Inaktiv"}</span></div>
      <div class="cost-center-card-copy"><span class="eyebrow">${escapeHtml(costCenterTypeLabel(center.type))}</span><h3>${escapeHtml(center.name || center.code || "Kostenstelle")}</h3>${center.description ? `<p>${escapeHtml(center.description)}</p>` : ""}</div>
      <div class="cost-center-card-counts"><span><strong>${Number(center.employee_count)}</strong> Beschäftigte</span><span><strong>${Number(center.location_count)}</strong> Filialen</span></div>
      ${canEdit ? `<button type="button" class="edit-button" data-edit-cost-center="${escapeHtmlAttribute(String(center.id))}">Bearbeiten</button>` : ""}
    </article>`).join("") : '<p class="settings-note">Noch keine Kostenstelle angelegt.</p>';
}

function normalizeCentralVacation(item = {}) {
  return {
    ...item,
    group_id: String(item.group_id ?? item.groupId ?? item.id ?? ""),
    employee_number: String(item.employee_number ?? item.employeeNumber ?? ""),
    full_name: String(item.full_name ?? item.fullName ?? ""),
    nickname: String(item.nickname ?? ""),
    date_from: String(item.date_from ?? item.dateFrom ?? ""),
    date_to: String(item.date_to ?? item.dateTo ?? ""),
    days: Number(item.days ?? item.vacation_days ?? item.vacationDays ?? NaN),
    cost_center_id: String(item.cost_center_id ?? item.costCenterId ?? ""),
    cost_center_code: String(item.cost_center_code ?? item.costCenterCode ?? ""),
    cost_center_name: String(item.cost_center_name ?? item.costCenterName ?? ""),
    home_location_id: String(item.home_location_id ?? item.homeLocationId ?? ""),
    home_location_name: String(item.home_location_name ?? item.homeLocationName ?? ""),
    preferred_department_name: String(item.preferred_department_name ?? item.preferredDepartmentName ?? ""),
    source: String(item.source ?? item.origin ?? "direct"),
  };
}

function centralVacationSourceLabel(source) {
  return ({ request: "Genehmigter Antrag", approved_request: "Genehmigter Antrag", direct: "Direkt erfasst", import: "Import" })[source]
    || "Erfasst";
}

async function loadCentralVacations({ force = false } = {}) {
  if (!canReadCentralVacations() || state.centralVacationLoading) return;
  const year = Number(state.centralVacationYear || new Date().getFullYear());
  if (!force && state.centralVacationLoadedYear === year) {
    renderCentralVacations();
    return;
  }
  state.centralVacationLoading = true;
  if (elements.centralVacationList) elements.centralVacationList.innerHTML = '<tr><td colspan="7">Unternehmensweite Urlaubsdaten werden geladen.</td></tr>';
  try {
    const payload = await api(`/api/personnel-vacations?year=${encodeURIComponent(year)}`);
    state.centralVacations = apiList(payload, ["vacations", "items", "entries"]).map(normalizeCentralVacation);
    state.centralVacationYear = Number(payload?.year || year);
    state.centralVacationLoadedYear = state.centralVacationYear;
    renderCentralVacations();
  } catch (error) {
    if (elements.centralVacationList) elements.centralVacationList.innerHTML = `<tr><td colspan="7">${escapeHtml(error.message)}</td></tr>`;
    showToast(error.message, true);
  } finally {
    state.centralVacationLoading = false;
  }
}

function filteredCentralVacations() {
  const search = state.centralVacationSearch.trim().toLocaleLowerCase("de-AT");
  const costCenterId = String(state.centralVacationCostCenterFilter || "");
  return state.centralVacations.filter((vacation) => {
    if (costCenterId && vacation.cost_center_id !== costCenterId) return false;
    if (!search) return true;
    return [vacation.employee_number, vacation.full_name, vacation.nickname, vacation.cost_center_code,
      vacation.cost_center_name, vacation.home_location_id, vacation.home_location_name, vacation.preferred_department_name]
      .some((value) => String(value || "").toLocaleLowerCase("de-AT").includes(search));
  }).sort((left, right) => left.date_from.localeCompare(right.date_from)
    || left.employee_number.localeCompare(right.employee_number, "de-AT", { numeric: true, sensitivity: "base" }));
}

function renderCentralVacationSummary() {
  if (!elements.centralVacationSummary) return;
  const today = toIsoDate(new Date());
  const active = state.centralVacations.filter((vacation) => vacation.date_from <= today && vacation.date_to >= today).length;
  const upcoming = state.centralVacations.filter((vacation) => vacation.date_from > today).length;
  const employees = new Set(state.centralVacations.map((vacation) => vacation.employee_number).filter(Boolean)).size;
  const costCenters = new Set(state.centralVacations.map((vacation) => vacation.cost_center_id).filter(Boolean)).size;
  elements.centralVacationSummary.innerHTML = [
    ["Urlaubseinträge", state.centralVacations.length, `im Jahr ${state.centralVacationYear}`],
    ["Beschäftigte", employees, "mit Urlaubseintrag"],
    ["Heute abwesend", active, "genehmigte Urlaube"],
    ["Kommend", upcoming, `${costCenters} Kostenstelle${costCenters === 1 ? "" : "n"}`],
  ].map(([label, value, note]) => `<article class="personnel-administration-stat"><span>${escapeHtml(label)}</span><strong>${Number(value)}</strong><small>${escapeHtml(note)}</small></article>`).join("");
}

function renderCentralVacations() {
  if (!elements.centralVacationList || !canReadCentralVacations()) return;
  if (elements.centralVacationYear) elements.centralVacationYear.value = state.centralVacationYear;
  const currentCostCenter = String(state.centralVacationCostCenterFilter || "");
  const centersById = new Map(state.costCenters.map((center) => [String(center.id), center]));
  for (const vacation of state.centralVacations) {
    if (vacation.cost_center_id && !centersById.has(vacation.cost_center_id)) {
      centersById.set(vacation.cost_center_id, {
        id: vacation.cost_center_id,
        code: vacation.cost_center_code,
        name: vacation.cost_center_name,
        active: true,
      });
    }
  }
  elements.centralVacationCostCenterFilter.innerHTML = `<option value="">Alle Kostenstellen</option>${[...centersById.values()]
    .sort((left, right) => String(left.code || left.name).localeCompare(String(right.code || right.name), "de-AT", { numeric: true }))
    .map((center) => `<option value="${escapeHtmlAttribute(String(center.id))}">${escapeHtml([center.code, center.name].filter(Boolean).join(" · ") || "Kostenstelle")}</option>`).join("")}`;
  if ([...elements.centralVacationCostCenterFilter.options].some((option) => option.value === currentCostCenter)) {
    elements.centralVacationCostCenterFilter.value = currentCostCenter;
  } else {
    state.centralVacationCostCenterFilter = "";
  }
  renderCentralVacationSummary();
  const rows = filteredCentralVacations();
  elements.centralVacationList.innerHTML = rows.length ? rows.map((vacation) => {
    const personName = vacation.full_name || vacation.nickname || "–";
    const costCenter = [vacation.cost_center_code, vacation.cost_center_name].filter(Boolean).join(" · ") || "Nicht zugeordnet";
    const location = [vacation.home_location_name || vacation.home_location_id, vacation.preferred_department_name].filter(Boolean).join(" · ") || "Keine Stammfiliale";
    const period = vacation.date_from === vacation.date_to
      ? formatDate(vacation.date_from)
      : `${formatDate(vacation.date_from)} – ${formatDate(vacation.date_to)}`;
    return `<tr>
      <td data-label="Zeitraum"><strong>${escapeHtml(period)}</strong></td>
      <td data-label="Personalnr.">${escapeHtml(vacation.employee_number || "–")}</td>
      <td data-label="Name"><strong>${escapeHtml(personName)}</strong>${vacation.nickname && vacation.nickname !== personName ? `<small>${escapeHtml(vacation.nickname)}</small>` : ""}</td>
      <td data-label="Kostenstelle"><span class="status-badge ${vacation.cost_center_id ? "" : "warning"}">${escapeHtml(costCenter)}</span></td>
      <td data-label="Filiale / Abteilung">${escapeHtml(location)}</td>
      <td data-label="Tage">${Number.isFinite(vacation.days) ? escapeHtml(formatDaysLong(vacation.days)) : "–"}</td>
      <td data-label="Quelle">${escapeHtml(centralVacationSourceLabel(vacation.source))}</td>
    </tr>`;
  }).join("") : '<tr><td colspan="7" class="personnel-directory-empty">Keine passenden Urlaubseinträge gefunden.</td></tr>';
}

function renderPersonnelAdministration() {
  if (!canReadCentralPersonnel()) return;
  renderPersonnelAdministrationSummary();
  renderPersonnelDirectory();
  renderCostCenters();
  if (state.centralVacationLoadedYear !== null) renderCentralVacations();
}

function setPersonnelAdministrationTab(tab) {
  const normalized = tab === "costCenters" && canReadCostCenters()
    ? "costCenters"
    : tab === "vacations" && canReadCentralVacations() ? "vacations" : "employees";
  state.personnelAdministrationTab = normalized;
  document.querySelectorAll("[data-personnel-administration-tab]").forEach((button) => {
    const active = button.dataset.personnelAdministrationTab === normalized;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  elements.personnelDirectorySection?.classList.toggle("active", normalized === "employees");
  elements.costCenterSection?.classList.toggle("active", normalized === "costCenters");
  elements.centralVacationSection?.classList.toggle("active", normalized === "vacations");
  if (normalized === "vacations") loadCentralVacations().catch((error) => showToast(error.message, true));
}

function openCostCenterModal(costCenter = null) {
  if (!canWriteCostCenters() || !elements.costCenterModal) return;
  state.editingCostCenterId = costCenter?.id ?? null;
  elements.costCenterForm.reset();
  elements.costCenterId.value = costCenter?.id ?? "";
  elements.costCenterCode.value = costCenter?.code || "";
  elements.costCenterCode.disabled = Boolean(costCenter);
  elements.costCenterName.value = costCenter?.name || "";
  elements.costCenterType.value = costCenter?.type || "other";
  elements.costCenterDescription.value = costCenter?.description || "";
  elements.costCenterActive.checked = costCenter?.active ?? true;
  elements.costCenterModalTitle.textContent = costCenter ? "Kostenstelle bearbeiten" : "Kostenstelle anlegen";
  elements.costCenterSubmitButton.textContent = costCenter ? "Kostenstelle speichern" : "Kostenstelle anlegen";
  elements.deactivateCostCenterButton.classList.toggle("hidden", !costCenter?.active);
  elements.costCenterModal.showModal();
}

async function saveCostCenter(event) {
  event.preventDefault();
  if (!canWriteCostCenters()) return;
  const id = state.editingCostCenterId;
  const body = {
    code: elements.costCenterCode.value.trim(),
    name: elements.costCenterName.value.trim(),
    type: elements.costCenterType.value,
    description: elements.costCenterDescription.value.trim(),
    active: elements.costCenterActive.checked,
  };
  elements.costCenterSubmitButton.disabled = true;
  try {
    await api(id === null ? "/api/cost-centers" : `/api/cost-centers/${encodeURIComponent(id)}`, {
      method: id === null ? "POST" : "PUT",
      body: JSON.stringify(body),
    });
    elements.costCenterModal.close();
    state.personnelAdministrationLoaded = false;
    await loadPersonnelAdministration({ force: true });
    showToast(id === null ? "Kostenstelle wurde angelegt." : "Kostenstelle wurde gespeichert.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.costCenterSubmitButton.disabled = false;
  }
}

async function deactivateCostCenter() {
  const id = state.editingCostCenterId;
  if (id === null || !canWriteCostCenters() || !confirm("Diese Kostenstelle deaktivieren? Bestehende Zuordnungen und historische Daten bleiben erhalten.")) return;
  elements.deactivateCostCenterButton.disabled = true;
  try {
    await api(`/api/cost-centers/${encodeURIComponent(id)}`, { method: "DELETE" });
    elements.costCenterModal.close();
    state.personnelAdministrationLoaded = false;
    await loadPersonnelAdministration({ force: true });
    showToast("Kostenstelle wurde deaktiviert.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.deactivateCostCenterButton.disabled = false;
  }
}

function renderEmployees() {
  const showInactive = state.data?.settings?.show_inactive_personnel !== "0";
  const employees = showInactive ? state.allEmployees : state.allEmployees.filter((employee) => employee.active);
  const canEditFull = !state.portalStatus?.portalEnabled || state.portalSession?.user?.permissions?.includes("employees:write");
  const canEditDisplay = canEditFull || state.portalSession?.user?.permissions?.includes("employees:display:write");
  const canReadPersonnelRecord = personnelRecordAvailableInUi();
  elements.employeeTableBody.innerHTML = employees.map((employee) => `
    <tr>
      <td><span class="employee-color" style="background:${employee.color}"></span></td>
      <td><strong>${escapeHtml(employee.personnel_number)}</strong></td>
      <td>${escapeHtml(employee.full_name)}</td>
      <td>${escapeHtml(employee.nickname)}</td>
      <td>${escapeHtml(employee.position_name || "Verkaufsmitarbeiter")}</td>
      <td>${escapeHtml(employee.home_location_name || employee.home_location_id || "–")}</td>
      <td>${escapeHtml(employee.preferred_department_name || "–")}</td>
      <td>${String(employee.contracted_hours).replace(".", ",")} h · ${Number(employee.target_workdays_per_week || 5)} T.</td>
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
        <div><strong>${escapeHtml(location.id)} · ${escapeHtml(location.name)}</strong><small>${location.active ? "Aktiv" : "Inaktiv"} · ${departments.length} Abteilung(en) · Mindestbesetzung Filiale: ${Number(location.min_staff || 0)} · Zeiterfassung ${location.time_tracking_enabled ? "aktiv" : "aus"}</small><small>Kostenstelle: ${escapeHtml([location.cost_center_code ?? location.costCenterCode, location.cost_center_name ?? location.costCenterName].filter(Boolean).join(" · ") || "noch nicht zugeordnet")} · ${escapeHtml(openingSummary)}</small></div>
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
    elements.workflowSettingsHint.textContent = "Die Einstellung kann von Personalleitung oder höher geändert werden.";
  }
  document.querySelector("#breakRuleEnabled").checked = settings.break_rule_enabled === "1";
  document.querySelector("#breakAfterHours").value = Number(settings.break_after_minutes) / 60;
  document.querySelector("#breakDuration").value = settings.break_duration_minutes;
  document.querySelector("#saturdayBonusEnabled").checked = settings.saturday_bonus_enabled === "1";
  document.querySelector("#saturdayBonusFrom").value = settings.saturday_bonus_from;
  document.querySelector("#saturdayBonusFactor").value = settings.saturday_bonus_factor;
  document.querySelector("#showSunday").checked = settings.show_sunday === "1";
  elements.rememberLastScheduleOverallPlan.checked = settings.remember_last_schedule_overall_plan !== "0";
  elements.rememberLastVacationOverallPlan.checked = settings.remember_last_vacation_overall_plan !== "0";
  applyDashboardFontSize(state.dashboardFontSize);
  localStorage.setItem(rememberContextCacheKey("planning"), elements.rememberLastScheduleOverallPlan.checked ? "1" : "0");
  localStorage.setItem(rememberContextCacheKey("vacations"), elements.rememberLastVacationOverallPlan.checked ? "1" : "0");
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
    elements.adminSetupButton.classList.toggle("hidden", !state.portalStatus?.adminSetupAvailable);
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
    const personnelLevels = Object.values(user.personnelFieldAccess || {});
    const personnelSummary = ["manager", "department_manager"].includes(user.role) && personnelLevels.length
      ? `<small>Personalakt effektiv · ${personnelLevels.filter((level) => level === "read").length} lesen · ${personnelLevels.filter((level) => level === "write").length} bearbeiten</small>` : "";
    const location = state.locations.find((item) => item.id === user.homeLocationId);
    const status = !user.configured ? "Portal-Zugang noch nicht eingerichtet" : !user.active ? "Portal-Zugang inaktiv" : user.manageable ? "Zusatzrechte können bearbeitet werden" : "Rechte nur zur Ansicht";
    return `<article class="rights-user-card" data-rights-user="${escapeHtml(user.employeeNumber)}">
      <div class="rights-user-heading"><div><strong>${escapeHtml(user.employeeNumber)} · ${escapeHtml(user.nickname || user.fullName)}</strong><small>${escapeHtml(user.roleName || user.role)} · ${escapeHtml(location?.name || user.homeLocationId || "Kein Standort")} · ${additionalCount} Zusatzrecht${additionalCount === 1 ? "" : "e"}</small>${personnelSummary}<small>${escapeHtml(status)}</small></div><button class="secondary-button" type="button" data-edit-user-rights>${user.manageable ? "Rechte bearbeiten" : "Rechte ansehen"}</button></div>
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
      const roleEligible = !Array.isArray(permission.eligibleRoles) || permission.eligibleRoles.includes(user.role);
      const editable = Boolean(user.manageable && permission.editable && roleEligible && !baseRight);
      const lockedRight = !user.manageable || !permission.editable || !roleEligible;
      const warningLevel = permission.warningLevel || "normal";
      const statusText = baseRight
        ? "Grundrecht der Rolle"
        : additionalRight
          ? lockedRight ? "Individuell vergeben · nur zur Ansicht" : "Individuell vergeben"
          : !roleEligible
            ? "Nur für Personalleitung und höhere geschützte Rollen"
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

function personnelFieldLevelLabel(level, payload = state.personnelFieldRights || {}) {
  return (payload.accessLevels || []).find((entry) => entry.id === level)?.label
    || ({ hidden: "Verborgen", read: "Nur lesen", write: "Bearbeiten" }[level] || level);
}

function personnelFieldGroupSummary(groupElement) {
  if (!groupElement) return;
  const counts = { hidden: 0, read: 0, write: 0 };
  groupElement.querySelectorAll("select[data-personnel-field-right]").forEach((select) => {
    counts[select.value] = Number(counts[select.value] || 0) + 1;
  });
  const summary = groupElement.querySelector("[data-personnel-field-group-summary]");
  if (summary) summary.textContent = `${counts.hidden} verborgen · ${counts.read} lesen · ${counts.write} bearbeiten`;
}

function renderPersonnelFieldRights() {
  if (!elements.personnelFieldRightsMatrix || !elements.personnelFieldRightsRole) return;
  const payload = state.personnelFieldRights || {};
  const roles = Array.isArray(payload.roles) ? payload.roles : [];
  const fields = Array.isArray(payload.fields) ? payload.fields : [];
  const accessLevels = Array.isArray(payload.accessLevels) && payload.accessLevels.length
    ? payload.accessLevels : [{ id: "hidden", label: "Verborgen" }, { id: "read", label: "Nur lesen" }, { id: "write", label: "Bearbeiten" }];
  if (!roles.some((role) => role.id === state.selectedPersonnelFieldRightsRole)) {
    state.selectedPersonnelFieldRightsRole = roles[0]?.id || "manager";
  }
  elements.personnelFieldRightsRole.innerHTML = roles.map((role) => `<option value="${escapeHtmlAttribute(role.id)}" ${role.id === state.selectedPersonnelFieldRightsRole ? "selected" : ""}>${escapeHtml(role.label || role.id)}${state.personnelFieldRightsDirtyRoles.has(role.id) ? " · nicht gespeichert" : ""}</option>`).join("");
  elements.personnelFieldRightsRole.disabled = roles.length < 2;
  const roleMatrix = state.personnelFieldRightsDrafts[state.selectedPersonnelFieldRightsRole]
    || payload.matrix?.[state.selectedPersonnelFieldRightsRole] || {};
  const groups = new Map();
  for (const field of fields) {
    const group = field.group || "Weitere Daten";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(field);
  }
  elements.personnelFieldRightsMatrix.innerHTML = groups.size ? [...groups.entries()].map(([group, groupFields], groupIndex) => `
    <details class="personnel-field-rights-group" ${groupIndex === 0 ? "open" : ""}>
      <summary><span><strong>${escapeHtml(group)}</strong><small data-personnel-field-group-summary></small></span><span aria-hidden="true">›</span></summary>
      <div class="personnel-field-rights-list">${groupFields.map((field) => {
        const currentLevel = ["hidden", "read", "write"].includes(roleMatrix[field.key]) ? roleMatrix[field.key] : "hidden";
        return `<label class="personnel-field-right-row" data-field-access-level="${escapeHtmlAttribute(currentLevel)}"><span class="personnel-field-right-name"><strong>${escapeHtml(field.label || field.key)}</strong>${field.sensitive ? '<small>Besonders geschützt</small>' : ""}</span><select data-personnel-field-right="${escapeHtmlAttribute(field.key)}" aria-label="${escapeHtmlAttribute(`Zugriff auf ${field.label || field.key}`)}" ${payload.canChange === false ? "disabled" : ""}>${accessLevels.map((level) => `<option value="${escapeHtmlAttribute(level.id)}" ${level.id === currentLevel ? "selected" : ""}>${escapeHtml(level.label || personnelFieldLevelLabel(level.id, payload))}</option>`).join("")}</select></label>`;
      }).join("")}</div>
    </details>`).join("") : '<p class="settings-note">Es sind noch keine Personalakt-Felder konfiguriert.</p>';
  elements.personnelFieldRightsMatrix.querySelectorAll(".personnel-field-rights-group").forEach(personnelFieldGroupSummary);
  elements.savePersonnelFieldRightsButton.disabled = payload.canChange === false || !fields.length;
  const roleLabel = roles.find((role) => role.id === state.selectedPersonnelFieldRightsRole)?.label || "diese Leitungsebene";
  elements.personnelFieldRightsHint.textContent = state.personnelFieldRightsDirtyRoles.has(state.selectedPersonnelFieldRightsRole)
    ? `Ungespeicherte Änderungen für ${roleLabel}. Andere Leitungsebenen können trotzdem angesehen werden.`
    : payload.canChange === false
    ? "Die Personalakt-Feldrechte können mit diesem Zugang nur angesehen werden."
    : `Änderungen gelten für alle Zugänge der Rolle ${roleLabel} und werden serverseitig durchgesetzt.`;
}

async function loadRightsManagement() {
  if (!elements.rightsSettings) return;
  try {
    const [rights, mobile, personnelFieldRights] = await Promise.all([
      api("/api/portal/v1/rights"),
      api("/api/portal/v1/mobile-layout"),
      api("/api/portal/v1/personnel-field-rights"),
    ]);
    state.rightsManagement = rights;
    state.mobileLeadershipSettings = mobile;
    state.personnelFieldRights = personnelFieldRights;
    state.personnelFieldRightsDirtyRoles.clear();
    state.personnelFieldRightsDrafts = {};
    renderRightsManagement();
    renderMobileLeadershipSettings();
    renderPersonnelFieldRights();
  } catch (error) {
    elements.rightsManagementHint.textContent = error.status === 403 ? "Rechtemanagement ist nur für Developer, IT-Admin, Admin und Personalleitung verfügbar." : error.message;
    elements.rightsUserList.innerHTML = "";
    elements.mobileLeadershipModuleSettings.innerHTML = "";
    elements.personnelFieldRightsMatrix.innerHTML = "";
  }
}

async function savePersonnelFieldRights() {
  const role = state.selectedPersonnelFieldRightsRole;
  const fields = Object.fromEntries([...elements.personnelFieldRightsMatrix.querySelectorAll("select[data-personnel-field-right]")]
    .map((select) => [select.dataset.personnelFieldRight, select.value]));
  const expectedCount = state.personnelFieldRights?.fields?.length || 0;
  if (!role || Object.keys(fields).length !== expectedCount) return showToast("Die Feldrechte konnten nicht vollständig gelesen werden.", true);
  elements.savePersonnelFieldRightsButton.disabled = true;
  try {
    state.personnelFieldRights = await api(`/api/portal/v1/personnel-field-rights/${encodeURIComponent(role)}`, {
      method: "PUT",
      body: JSON.stringify({ fields }),
    });
    state.personnelFieldRightsDirtyRoles.delete(role);
    delete state.personnelFieldRightsDrafts[role];
    renderPersonnelFieldRights();
    const roleLabel = state.personnelFieldRights.roles?.find((entry) => entry.id === role)?.label || role;
    showToast(`Personalakt-Feldrechte für ${roleLabel} wurden gespeichert.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    if (elements.savePersonnelFieldRightsButton) elements.savePersonnelFieldRightsButton.disabled = state.personnelFieldRights?.canChange === false;
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

const UI_APPEARANCE_VIEWS = Object.freeze([
  "planning",
  "requests",
  "timeTracking",
  "vacations",
  "personnelAdministration",
  "personnel",
  "rightsDashboard",
  "settings",
]);

function uiPreferenceActorKey() {
  return state.portalSession?.user?.employeeNumber || "local";
}

function pageThemeStorageKey(view) {
  return `grabenplaner:page-theme:${uiPreferenceActorKey()}:${view}`;
}

function dashboardFontSizeStorageKey() {
  return `grabenplaner:dashboard-font-size:${uiPreferenceActorKey()}`;
}

function pageViewElement(view) {
  return ({
    planning: elements.planningView,
    requests: elements.requestsView,
    timeTracking: elements.timeTrackingView,
    vacations: elements.vacationsView,
    personnelAdministration: elements.personnelAdministrationView,
    personnel: elements.personnelView,
    rightsDashboard: elements.rightsDashboardView,
    settings: elements.settingsView,
  })[view] || null;
}

function applyActivePageAppearance() {
  const theme = state.pageThemes[state.currentView] === "dark" ? "dark" : "light";
  document.documentElement.dataset.activePageTheme = theme;
  document.documentElement.dataset.activeView = state.currentView;
  document.querySelector(".main-content")?.setAttribute("data-active-page-theme", theme);
}

function applyPageTheme(view, theme) {
  if (!UI_APPEARANCE_VIEWS.includes(view)) return;
  const normalized = theme === "dark" ? "dark" : "light";
  state.pageThemes[view] = normalized;
  const viewElement = pageViewElement(view);
  viewElement?.setAttribute("data-page-theme", normalized);
  if (view === "rightsDashboard") {
    state.rightsDashboardTheme = normalized;
    viewElement?.setAttribute("data-dashboard-theme", normalized);
  }
  viewElement?.querySelectorAll("button[data-page-theme-choice]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.pageThemeChoice === normalized));
  });
  if (state.currentView === view) applyActivePageAppearance();
}

function applyDashboardFontSize(value) {
  const normalized = ["compact", "standard", "large"].includes(value) ? value : "standard";
  state.dashboardFontSize = normalized;
  elements.rightsDashboardView?.setAttribute("data-dashboard-font-size", normalized);
  if (elements.dashboardFontSize) elements.dashboardFontSize.value = normalized;
}

async function loadUiPreferences() {
  let preferences = null;
  try {
    preferences = await api("/api/portal/v1/ui-preferences");
  } catch (error) {
    if (![401, 403, 404].includes(error.status)) throw error;
  }
  const localOnly = (preferences?.actor || uiPreferenceActorKey()) === "local";
  for (const view of UI_APPEARANCE_VIEWS) {
    const stored = localOnly ? localStorage.getItem(pageThemeStorageKey(view)) : "";
    applyPageTheme(view, stored || preferences?.pageThemes?.[view] || "light");
  }
  const storedFontSize = localOnly ? localStorage.getItem(dashboardFontSizeStorageKey()) : "";
  applyDashboardFontSize(storedFontSize || preferences?.dashboardFontSize || "standard");
  applyActivePageAppearance();
}

async function savePageTheme(view, theme) {
  if (!UI_APPEARANCE_VIEWS.includes(view)) return;
  const previous = state.pageThemes[view] || "light";
  const normalized = theme === "dark" ? "dark" : "light";
  applyPageTheme(view, normalized);
  localStorage.setItem(pageThemeStorageKey(view), normalized);
  try {
    const result = await api("/api/portal/v1/ui-preferences", {
      method: "PUT",
      body: JSON.stringify({ pageThemes: { [view]: normalized } }),
    });
    applyPageTheme(view, result.pageThemes?.[view] || normalized);
  } catch (error) {
    applyPageTheme(view, previous);
    localStorage.setItem(pageThemeStorageKey(view), previous);
    showToast(error.message, true);
  }
}

async function saveDashboardFontSize(value, { silent = false } = {}) {
  const previous = state.dashboardFontSize;
  const normalized = ["compact", "standard", "large"].includes(value) ? value : "standard";
  applyDashboardFontSize(normalized);
  localStorage.setItem(dashboardFontSizeStorageKey(), normalized);
  try {
    const result = await api("/api/portal/v1/ui-preferences", {
      method: "PUT",
      body: JSON.stringify({ dashboardFontSize: normalized }),
    });
    applyDashboardFontSize(result.dashboardFontSize || normalized);
    if (!silent) showToast("Die Dashboard-Schriftgröße wurde gespeichert.");
  } catch (error) {
    applyDashboardFontSize(previous);
    localStorage.setItem(dashboardFontSizeStorageKey(), previous);
    if (!silent) showToast(error.message, true);
    throw error;
  }
}

function rightsDashboardThemeStorageKey() {
  return pageThemeStorageKey("rightsDashboard");
}

function applyRightsDashboardTheme(theme) {
  applyPageTheme("rightsDashboard", theme);
}

async function saveRightsDashboardTheme(theme) {
  await savePageTheme("rightsDashboard", theme);
}

function populateRightsDashboardDepartments() {
  if (!elements.rightsDashboardDepartmentFilter || !state.rightsDashboard) return;
  const current = elements.rightsDashboardDepartmentFilter.value;
  const locationId = elements.rightsDashboardLocationFilter?.value || "";
  const departments = state.rightsDashboard.locations
    .filter((location) => !locationId || String(location.id) === locationId)
    .flatMap((location) => (location.departments || []).map((department) => ({
      ...department,
      locationName: location.name,
    })));
  elements.rightsDashboardDepartmentFilter.innerHTML = `<option value="">Alle Abteilungen</option>${departments.map((department) => (
    `<option value="${escapeHtml(String(department.id))}">${escapeHtml(locationId ? department.name : `${department.locationName} · ${department.name}`)}</option>`
  )).join("")}`;
  elements.rightsDashboardDepartmentFilter.value = departments.some((department) => String(department.id) === current) ? current : "";
}

function populateRightsDashboardFilters() {
  const dashboard = state.rightsDashboard;
  if (!dashboard) return;
  const role = elements.rightsDashboardRoleFilter?.value || "";
  const location = elements.rightsDashboardLocationFilter?.value || "";
  elements.rightsDashboardRoleFilter.innerHTML = `<option value="">Alle Rollen</option>${dashboard.roles.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}`;
  elements.rightsDashboardLocationFilter.innerHTML = `<option value="">Alle Standorte</option>${dashboard.locations.filter((item) => item.active).map((item) => `<option value="${escapeHtml(String(item.id))}">${escapeHtml(`${item.id} · ${item.name}`)}</option>`).join("")}`;
  elements.rightsDashboardRoleFilter.value = dashboard.roles.some((item) => item.id === role) ? role : "";
  elements.rightsDashboardLocationFilter.value = dashboard.locations.some((item) => String(item.id) === location) ? location : "";
  populateRightsDashboardDepartments();
}

function rightsDashboardPermissionMatches(permission, search) {
  if (!search) return true;
  return [permission.id, permission.label, permission.description, permission.group, permission.originLabel, permission.coverage?.label]
    .some((value) => String(value || "").toLocaleLowerCase("de-AT").includes(search));
}

function rightsDashboardIdentityMatches(user, search) {
  if (!search) return true;
  return [user.employeeNumber, user.fullName, user.nickname, user.roleName, user.scope.label]
    .some((value) => String(value || "").toLocaleLowerCase("de-AT").includes(search));
}

function rightsDashboardPersonnelFieldContext(user) {
  if (!["manager", "department_manager"].includes(user?.role) || !state.personnelFieldRights) return null;
  const matrix = user.personnelFieldAccess && !Array.isArray(user.personnelFieldAccess)
    && typeof user.personnelFieldAccess === "object" ? user.personnelFieldAccess : null;
  return matrix ? { payload: state.personnelFieldRights, matrix } : null;
}

function rightsDashboardVisiblePersonnelFields(user) {
  const context = rightsDashboardPersonnelFieldContext(user);
  if (!context) return [];
  const origin = elements.rightsDashboardOriginFilter?.value || "";
  if (origin === "delegated") return [];
  const search = String(elements.rightsDashboardSearch?.value || "").trim().toLocaleLowerCase("de-AT");
  const identityMatch = rightsDashboardIdentityMatches(user, search);
  return (context.payload.fields || []).filter((field) => {
    const level = context.matrix[field.key];
    if (!["read", "write"].includes(level)) return false;
    if (!search || identityMatch) return true;
    return [field.key, field.label, field.group, personnelFieldLevelLabel(level, context.payload), "Personalakt", "Feldzugriff", "Effektiv"]
      .some((value) => String(value || "").toLocaleLowerCase("de-AT").includes(search));
  });
}

function rightsDashboardFilteredUsers() {
  const dashboard = state.rightsDashboard;
  if (!dashboard) return [];
  const search = String(elements.rightsDashboardSearch?.value || "").trim().toLocaleLowerCase("de-AT");
  const role = elements.rightsDashboardRoleFilter?.value || "";
  const locationId = elements.rightsDashboardLocationFilter?.value || "";
  const departmentId = elements.rightsDashboardDepartmentFilter?.value || "";
  const origin = elements.rightsDashboardOriginFilter?.value || "";
  return dashboard.users.filter((user) => {
    if (role && user.role !== role) return false;
    if (locationId && user.scope.type !== "global" && !(user.scope.entries || []).some((scope) => String(scope.locationId) === locationId)) return false;
    if (departmentId && user.scope.type !== "global" && !(user.scope.entries || []).some((scope) => String(scope.departmentId || "") === departmentId)) return false;
    const visiblePersonnelFields = rightsDashboardVisiblePersonnelFields(user);
    if (origin === "role" && !user.permissions.some((permission) => permission.origin === "role") && !visiblePersonnelFields.length) return false;
    if (origin === "delegated" && !user.permissions.some((permission) => permission.origin === "delegated")) return false;
    if (origin === "restricted" && !user.permissions.some((permission) => permission.coverage?.restricted) && !visiblePersonnelFields.length) return false;
    if (!search) return true;
    return rightsDashboardIdentityMatches(user, search)
      || user.permissions.some((permission) => rightsDashboardPermissionMatches(permission, search))
      || visiblePersonnelFields.length > 0;
  });
}

function rightsDashboardVisiblePermissions(user) {
  const search = String(elements.rightsDashboardSearch?.value || "").trim().toLocaleLowerCase("de-AT");
  const origin = elements.rightsDashboardOriginFilter?.value || "";
  const identityMatch = rightsDashboardIdentityMatches(user, search);
  return user.permissions.filter((permission) => {
    if (origin === "role" && permission.origin !== "role") return false;
    if (origin === "delegated" && permission.origin !== "delegated") return false;
    if (origin === "restricted" && !permission.coverage?.restricted) return false;
    return !search || identityMatch || rightsDashboardPermissionMatches(permission, search);
  });
}

function renderRightsDashboardSummary() {
  if (!elements.rightsDashboardSummary || !state.rightsDashboard) return;
  const summary = state.rightsDashboard.summary;
  const cards = [
    ["Teammitglieder", summary.teamMembers, "aktive Stammdaten im Dashboard"],
    ["Aktive Zugänge", summary.activeAccesses, "mit eingerichtetem Portal-Zugang"],
    ["Zusatzrechte", summary.delegatedRights, "individuell ergänzte Berechtigungen"],
    ["Bereichsgebunden", summary.scopedRights, "auf Person, Filiale oder Abteilung begrenzt"],
  ];
  elements.rightsDashboardSummary.innerHTML = cards.map(([label, value, hint]) => `<article class="rights-dashboard-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong><small>${escapeHtml(hint)}</small></article>`).join("");
}

function renderRightsDashboardExplanation(user, permission) {
  if (!elements.rightsDashboardExplanation) return;
  if (!permission) {
    elements.rightsDashboardExplanation.innerHTML = "<strong>Recht anklicken</strong><p>Die Erklärung zeigt Herkunft, Geltungsbereich und aktuellen Status.</p>";
    return;
  }
  const status = permission.effective
    ? "Wirksam"
    : user.accessActive ? "Ohne wirksamen Bereich" : "Nicht wirksam, da der Zugang inaktiv oder nicht vollständig eingerichtet ist";
  elements.rightsDashboardExplanation.innerHTML = `
    <strong>${escapeHtml(permission.label)}</strong>
    <p>${escapeHtml(permission.description || "Für dieses technische Recht ist keine zusätzliche Beschreibung hinterlegt.")}</p>
    <dl>
      <dt>Herkunft</dt><dd>${escapeHtml(permission.originLabel)}</dd>
      <dt>Geltungsbereich</dt><dd>${escapeHtml(permission.coverage?.label || "Nicht festgelegt")}</dd>
      <dt>Status</dt><dd>${escapeHtml(status)}</dd>
      <dt>Technischer Schlüssel</dt><dd><code>${escapeHtml(permission.id)}</code></dd>
    </dl>`;
}

function renderPersonnelFieldRightsDashboard(user) {
  const context = rightsDashboardPersonnelFieldContext(user);
  if (!context) return "";
  const { payload, matrix } = context;
  const fields = rightsDashboardVisiblePersonnelFields(user);
  if (!fields.length) return "";
  const counts = { hidden: 0, read: 0, write: 0 };
  fields.forEach((field) => { counts[matrix[field.key]] += 1; });
  const roleLabel = payload.roles?.find((role) => role.id === user.role)?.label || user.roleName;
  const filtered = String(elements.rightsDashboardSearch?.value || "").trim() || elements.rightsDashboardOriginFilter?.value;
  const summary = filtered ? `${fields.length} Treffer · ${counts.read} lesen · ${counts.write} bearbeiten`
    : `${counts.read} lesen · ${counts.write} bearbeiten`;
  return `<section class="rights-dashboard-group personnel-field-dashboard-group"><h3>Personalakt-Feldzugriff</h3><p>Effektiv für ${escapeHtml(roleLabel)} · ${escapeHtml(summary)}</p><div class="personnel-field-dashboard-list">${fields.map((field) => `<article class="rights-dashboard-permission personnel-field-dashboard-access ${escapeHtmlAttribute(matrix[field.key])}"><span class="permission-origin"></span><span><strong>${escapeHtml(field.label || field.key)}</strong><small>Effektiv · ${escapeHtml(personnelFieldLevelLabel(matrix[field.key], payload))}</small></span></article>`).join("")}</div></section>`;
}

function renderRightsDashboardSelection(user) {
  const visiblePermissions = rightsDashboardVisiblePermissions(user);
  elements.rightsDashboardEmpty?.classList.add("hidden");
  elements.rightsDashboardSelection?.classList.remove("hidden");
  elements.rightsDashboardPersonTitle.textContent = `${user.employeeNumber} · ${user.fullName || user.nickname || "Teammitglied"}`;
  elements.rightsDashboardPersonSubtitle.textContent = `${user.roleName} · ${user.scope.label}`;
  elements.rightsDashboardAccessStatus.textContent = user.accessActive ? "Zugang aktiv" : user.configured ? "Zugang inaktiv" : "Kein Zugang";
  elements.rightsDashboardAccessStatus.classList.toggle("inactive", !user.accessActive);
  const scopeSource = user.scope.source === "assigned" ? "explizit zugewiesen" : user.scope.source === "home" ? "aus Stammdaten" : user.scope.source === "role" ? "durch globale Rolle" : "ohne Zuweisung";
  const nodes = [
    ["Person", user.fullName || user.nickname || "Teammitglied", `Personalnummer ${user.employeeNumber}`],
    ["Rolle", user.roleName, user.roleDescription || "Grundrechte aus der App-Rolle"],
    ["Bereich", user.scope.label, scopeSource],
    ["Wirksame Rechte", String(user.counts.effective), `${user.counts.role} Grundrechte · ${user.counts.delegated} Zusatzrechte`],
  ];
  elements.rightsDashboardPath.innerHTML = nodes.map(([label, value, hint]) => `<article class="rights-dashboard-node"><span>${escapeHtml(label)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong><small>${escapeHtml(hint)}</small></article>`).join("");

  const grouped = new Map();
  for (const permission of visiblePermissions) {
    if (!grouped.has(permission.group)) grouped.set(permission.group, []);
    grouped.get(permission.group).push(permission);
  }
  const personnelFieldMatrix = renderPersonnelFieldRightsDashboard(user);
  const permissionMatrix = grouped.size
    ? [...grouped.entries()].map(([group, permissions]) => `<section class="rights-dashboard-group"><h3>${escapeHtml(group)}</h3><div class="rights-dashboard-permission-grid">${permissions.map((permission) => {
      const selected = permission.id === state.rightsDashboardSelectedPermissionId;
      const classes = ["rights-dashboard-permission", permission.origin === "delegated" ? "delegated" : "", permission.coverage?.restricted ? "restricted" : "", permission.effective ? "" : "inactive", selected ? "selected" : ""].filter(Boolean).join(" ");
      return `<button type="button" class="${classes}" data-rights-dashboard-permission="${escapeHtml(permission.id)}" aria-pressed="${selected}"><span class="permission-origin"></span><span><strong>${escapeHtml(permission.label)}</strong><small>${escapeHtml(`${permission.origin === "delegated" ? "Zusatzrecht" : "Grundrecht"} · ${permission.coverage?.label || "ohne Bereich"}`)}</small></span></button>`;
    }).join("")}</div></section>`).join("")
    : personnelFieldMatrix ? "" : "<p class=\"settings-note\">Für diese Filterung sind keine Rechte sichtbar.</p>";
  elements.rightsDashboardMatrix.innerHTML = `${permissionMatrix}${personnelFieldMatrix}`;
  const selectedPermission = visiblePermissions.find((permission) => permission.id === state.rightsDashboardSelectedPermissionId) || null;
  if (!selectedPermission) state.rightsDashboardSelectedPermissionId = "";
  renderRightsDashboardExplanation(user, selectedPermission);
}

function renderRightsDashboard() {
  if (!state.rightsDashboard || !elements.rightsDashboardUserList) return;
  const users = rightsDashboardFilteredUsers();
  elements.rightsDashboardResultCount.textContent = String(users.length);
  if (!users.some((user) => user.employeeNumber === state.rightsDashboardSelectedEmployeeNumber)) {
    state.rightsDashboardSelectedEmployeeNumber = users[0]?.employeeNumber || "";
    state.rightsDashboardSelectedPermissionId = "";
  }
  elements.rightsDashboardUserList.innerHTML = users.length ? users.map((user) => {
    const selected = user.employeeNumber === state.rightsDashboardSelectedEmployeeNumber;
    return `<button type="button" class="rights-dashboard-user ${user.accessActive ? "" : "inactive"} ${selected ? "selected" : ""}" data-rights-dashboard-user="${escapeHtml(user.employeeNumber)}" aria-pressed="${selected}"><span class="rights-dashboard-user-mark">${escapeHtml(user.employeeNumber)}</span><span class="rights-dashboard-user-copy"><strong>${escapeHtml(user.fullName || user.nickname || "Teammitglied")}</strong><small>${escapeHtml(`${user.roleName} · ${user.scope.label}`)}</small></span><span class="rights-dashboard-user-count">${escapeHtml(String(user.counts.effective))}</span></button>`;
  }).join("") : "<p class=\"settings-note\">Keine Personen entsprechen der aktuellen Filterung.</p>";
  const selected = users.find((user) => user.employeeNumber === state.rightsDashboardSelectedEmployeeNumber);
  elements.rightsDashboardEmpty?.classList.toggle("hidden", Boolean(selected));
  elements.rightsDashboardSelection?.classList.toggle("hidden", !selected);
  if (selected) renderRightsDashboardSelection(selected);
}

function locationDashboardStorageKey() {
  return `grabenplaner:dashboard-location-order:${uiPreferenceActorKey()}`;
}

function locationDashboardOrderedLocations(payload = state.locationDashboard) {
  const locations = [...(payload?.locations || [])];
  let preferred = payload?.preferences?.locationOrder || [];
  if (payload?.actor?.employeeNumber === "local") {
    try {
      const stored = JSON.parse(localStorage.getItem(locationDashboardStorageKey()) || "[]");
      if (Array.isArray(stored)) preferred = stored;
    } catch {}
  }
  const validIds = new Set(locations.map((location) => String(location.id)));
  const order = [...new Set(preferred.map(String))].filter((locationId) => validIds.has(locationId));
  for (const location of locations) if (!order.includes(String(location.id))) order.push(String(location.id));
  const locationLookup = new Map(locations.map((location) => [String(location.id), location]));
  return order.map((locationId) => locationLookup.get(locationId)).filter(Boolean);
}

function locationDashboardStatus(location) {
  if (location.status === "closed") return { label: "Geschlossen", tone: "closed" };
  if (location.status === "critical") return { label: "Unter Mindestbesetzung", tone: "critical" };
  if (location.status === "attention") return { label: "Mindestbesetzung", tone: "attention" };
  return { label: "Besetzung im Plan", tone: "ok" };
}

function locationDashboardAbsenceTime(entry) {
  return entry.allDay || !entry.startTime || !entry.endTime ? "ganztägig" : `${entry.startTime}–${entry.endTime} Uhr`;
}

function renderLocationDashboard() {
  const dashboard = state.locationDashboard;
  if (!dashboard || !elements.locationDashboardGrid) return;
  const summaryCards = [
    ["Aktive Filialen", dashboard.summary.activeLocations, "in der Übersicht"],
    ["Eingeteilt", dashboard.summary.scheduledEmployees, `am ${formatDate(dashboard.date)}`],
    ["Abwesenheiten", dashboard.summary.absentEntries, "betriebliche Einträge"],
    ["Kritische Filialen", dashboard.summary.criticalLocations, "unter Mindestbesetzung"],
  ];
  elements.locationDashboardSummary.innerHTML = summaryCards.map(([label, value, hint]) => `<article class="rights-dashboard-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong><small>${escapeHtml(hint)}</small></article>`).join("");
  const allCount = (dashboard.categories || []).reduce((sum, category) => sum + Number(category.count || 0), 0);
  const filters = [{ id: "all", label: "Alle", count: allCount, tone: "all" }, ...(dashboard.categories || [])];
  if (!filters.some((filter) => filter.id === state.locationDashboardFilter)) state.locationDashboardFilter = "all";
  elements.locationDashboardFilters.innerHTML = filters.map((filter) => `<button type="button" class="location-dashboard-filter ${escapeHtml(filter.tone || filter.id)}" data-location-dashboard-filter="${escapeHtml(filter.id)}" aria-pressed="${state.locationDashboardFilter === filter.id}"><span>${escapeHtml(filter.label)}</span><strong>${escapeHtml(String(filter.count || 0))}</strong></button>`).join("");
  const locations = locationDashboardOrderedLocations(dashboard);
  dashboard.locations = locations;
  dashboard.preferences = { ...(dashboard.preferences || {}), locationOrder: locations.map((location) => String(location.id)) };
  elements.locationDashboardGrid.innerHTML = locations.length ? locations.map((location, index) => {
    const status = locationDashboardStatus(location);
    const absences = (location.absences || []).filter((entry) => state.locationDashboardFilter === "all" || entry.category === state.locationDashboardFilter);
    const departmentNames = (location.departments || []).map((department) => department.name);
    const staffingText = !location.open
      ? "Filiale an diesem Tag geschlossen"
      : location.minStaff > 0
      ? `${location.scheduledCount} eingeteilt · mindestens ${location.minStaff}`
      : `${location.scheduledCount} eingeteilt · keine Mindestzahl hinterlegt`;
    const absenceRows = absences.length ? absences.map((entry) => {
      const color = /^#[0-9a-f]{6}$/i.test(entry.color || "") ? entry.color : "#26785f";
      return `<li class="location-dashboard-absence ${escapeHtml(entry.category)}"><span class="location-dashboard-person-color" style="--employee-color:${color}"></span><span><strong>${escapeHtml(`${entry.employeeNumber} · ${entry.nickname}`)}</strong><small>${escapeHtml([entry.label, entry.departmentName, locationDashboardAbsenceTime(entry)].filter(Boolean).join(" · "))}</small></span></li>`;
    }).join("") : `<li class="location-dashboard-empty-row">${state.locationDashboardFilter === "all" ? "Keine Abwesenheit eingetragen." : "Keine passende Abwesenheit in dieser Filiale."}</li>`;
    return `<article class="location-dashboard-card ${escapeHtml(status.tone)}" draggable="true" data-location-dashboard-card="${escapeHtml(String(location.id))}">
      <header><button type="button" class="location-dashboard-drag-handle" aria-label="${escapeHtml(`${location.name} verschieben`)}" title="Filialkarte verschieben">⠿</button><div><span class="eyebrow">Filiale ${escapeHtml(String(location.id))}</span><h3>${escapeHtml(location.name)}</h3></div><span class="location-dashboard-status ${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span></header>
      <div class="location-dashboard-staffing"><strong>${escapeHtml(staffingText)}</strong><small>${escapeHtml(`${location.activeTeamCount} aktive Teammitglieder${departmentNames.length ? ` · ${departmentNames.join(", ")}` : ""}`)}</small></div>
      <div class="location-dashboard-counts">${(dashboard.categories || []).filter((category) => Number(location.counts?.[category.id] || 0) > 0).map((category) => `<span class="${escapeHtml(category.tone || category.id)}">${escapeHtml(category.label)} <strong>${escapeHtml(String(location.counts[category.id]))}</strong></span>`).join("") || "<span>Keine Abwesenheiten</span>"}</div>
      <ul class="location-dashboard-absence-list">${absenceRows}</ul>
      <footer><button type="button" class="location-dashboard-move" data-location-dashboard-move="-1" ${index === 0 ? "disabled" : ""} aria-label="${escapeHtml(`${location.name} nach vorne verschieben`)}">←</button><span>Position ${index + 1} von ${locations.length}</span><button type="button" class="location-dashboard-move" data-location-dashboard-move="1" ${index === locations.length - 1 ? "disabled" : ""} aria-label="${escapeHtml(`${location.name} nach hinten verschieben`)}">→</button></footer>
    </article>`;
  }).join("") : "<p class=\"settings-note\">Es sind keine aktiven Filialen vorhanden.</p>";
}

async function loadLocationDashboard() {
  if (!elements.locationDashboardGrid) return;
  const date = elements.locationDashboardDate?.value || toIsoDate(new Date());
  if (elements.locationDashboardDate && !elements.locationDashboardDate.value) elements.locationDashboardDate.value = date;
  elements.locationDashboardGrid.innerHTML = "<p class=\"settings-note\">Filialübersicht wird geladen.</p>";
  try {
    state.locationDashboard = await api(`/api/portal/v1/dashboards/locations?date=${encodeURIComponent(date)}`);
    if (elements.locationDashboardDate) elements.locationDashboardDate.value = state.locationDashboard.date;
    renderLocationDashboard();
  } catch (error) {
    state.locationDashboard = null;
    elements.locationDashboardGrid.innerHTML = `<p class="settings-note">${escapeHtml(error.status === 403 ? "Die Filialübersicht ist nur für Personalleitung, Admin, IT-Admin und Developer verfügbar." : error.message)}</p>`;
    if (elements.locationDashboardSummary) elements.locationDashboardSummary.innerHTML = "";
    if (elements.locationDashboardFilters) elements.locationDashboardFilters.innerHTML = "";
  }
}

async function saveLocationDashboardOrder(previousOrder = []) {
  const locationOrder = (state.locationDashboard?.locations || []).map((location) => String(location.id));
  localStorage.setItem(locationDashboardStorageKey(), JSON.stringify(locationOrder));
  try {
    const result = await api("/api/portal/v1/dashboards/locations/preferences", {
      method: "PUT",
      body: JSON.stringify({ locationOrder }),
    });
    if (state.locationDashboard) state.locationDashboard.preferences = { ...(state.locationDashboard.preferences || {}), locationOrder: result.locationOrder || locationOrder };
    showToast("Die Filialreihenfolge wurde gespeichert.");
  } catch (error) {
    if (state.locationDashboard && previousOrder.length) {
      const lookup = new Map(state.locationDashboard.locations.map((location) => [String(location.id), location]));
      state.locationDashboard.locations = previousOrder.map((locationId) => lookup.get(String(locationId))).filter(Boolean);
      state.locationDashboard.preferences = { ...(state.locationDashboard.preferences || {}), locationOrder: previousOrder };
      localStorage.setItem(locationDashboardStorageKey(), JSON.stringify(previousOrder));
      renderLocationDashboard();
    }
    showToast(error.message, true);
  }
}

function reorderLocationDashboardCard(locationId, targetIndex) {
  if (!state.locationDashboard) return;
  const locations = [...state.locationDashboard.locations];
  const fromIndex = locations.findIndex((location) => String(location.id) === String(locationId));
  if (fromIndex < 0) return;
  const boundedIndex = Math.max(0, Math.min(locations.length - 1, targetIndex));
  if (fromIndex === boundedIndex) return;
  const previousOrder = locations.map((location) => String(location.id));
  const [moved] = locations.splice(fromIndex, 1);
  locations.splice(boundedIndex, 0, moved);
  state.locationDashboard.locations = locations;
  state.locationDashboard.preferences = { ...(state.locationDashboard.preferences || {}), locationOrder: locations.map((location) => String(location.id)) };
  localStorage.setItem(locationDashboardStorageKey(), JSON.stringify(state.locationDashboard.preferences.locationOrder));
  renderLocationDashboard();
  saveLocationDashboardOrder(previousOrder);
}

function setRightsDashboardMode(mode) {
  const normalized = ["locations", "rights", "processes"].includes(mode) ? mode : "locations";
  state.rightsDashboardMode = normalized;
  document.querySelectorAll("[data-rights-dashboard-mode]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.rightsDashboardMode === normalized));
  });
  elements.rightsDashboardLocationsPanel?.classList.toggle("hidden", normalized !== "locations");
  elements.rightsDashboardRightsPanel?.classList.toggle("hidden", normalized !== "rights");
  elements.rightsDashboardProcessesPanel?.classList.toggle("hidden", normalized !== "processes");
  if (normalized === "processes") renderRightsProcessDashboard();
  if (normalized === "locations" && !state.locationDashboard) loadLocationDashboard();
}

function rightsProcessDashboard() {
  return state.rightsDashboard?.processDashboard || null;
}

function rightsProcessLocation() {
  const dashboard = rightsProcessDashboard();
  if (!dashboard) return null;
  return dashboard.locations.find((location) => String(location.id) === String(state.rightsProcessLocationId))
    || dashboard.locations[0]
    || null;
}

function populateRightsProcessLocations() {
  const dashboard = rightsProcessDashboard();
  if (!dashboard || !elements.rightsProcessLocation) return;
  const current = state.rightsProcessLocationId || elements.rightsProcessLocation.value;
  elements.rightsProcessLocation.innerHTML = dashboard.locations.length
    ? dashboard.locations.map((location) => `<option value="${escapeHtml(String(location.id))}">${escapeHtml(`${location.id} · ${location.name}`)}</option>`).join("")
    : "<option value=\"\">Kein aktiver Standort</option>";
  state.rightsProcessLocationId = dashboard.locations.some((location) => String(location.id) === String(current))
    ? String(current)
    : String(dashboard.locations[0]?.id || "");
  elements.rightsProcessLocation.value = state.rightsProcessLocationId;
}

function rightsProcessScenario(process) {
  const scenarios = process?.simulations || [];
  const requested = state.rightsProcessScenarioIds[process?.id] || "current";
  return scenarios.find((scenario) => scenario.id === requested) || scenarios[0] || { id: "current", label: "Aktuelle Konfiguration", description: "Aktuell gespeicherter Ablauf.", stepStates: {} };
}

function rightsProcessWithScenario(process) {
  if (!process) return null;
  const scenario = rightsProcessScenario(process);
  return {
    ...process,
    scenario,
    steps: (process.steps || []).map((step) => ({ ...step, state: scenario.stepStates?.[step.id] || step.state })),
  };
}

function populateRightsProcessScenarios(process) {
  if (!elements.rightsProcessScenario || !process) return;
  const scenarios = process.simulations?.length
    ? process.simulations
    : [{ id: "current", label: "Aktueller Ablauf", description: "Gespeicherte Prozessdefinition.", stepStates: {} }];
  const scenario = rightsProcessScenario(process);
  elements.rightsProcessScenario.innerHTML = scenarios.map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</option>`).join("");
  elements.rightsProcessScenario.value = scenario.id;
  state.rightsProcessScenarioIds[process.id] = scenario.id;
}

function rightsProcessStepState(process, step) {
  if (process.source === "custom" ? customProcessStatusValue(process) !== "active" : !process.enabled) return "inactive";
  if (step.stateRule === "timeTrackingEnabled") return rightsProcessLocation()?.timeTrackingEnabled ? "active" : "inactive";
  return step.state || "active";
}

function rightsProcessStateLabel(stateValue) {
  return ({ active: "Aktiv", conditional: "Bedingt", bypassed: "Übersprungen", inactive: "Deaktiviert" })[stateValue] || "Aktiv";
}

function rightsProcessRuleValue(rule) {
  const location = rightsProcessLocation();
  if (!rule.locationRule) return rule.value;
  if (!location) return "Kein Standort";
  if (rule.locationRule === "tracking") return location.timeTrackingEnabled ? "Aktiv" : "Deaktiviert";
  if (rule.locationRule === "access") return location.timeTrackingAccessLabel;
  if (rule.locationRule === "variance") return `${location.timeTrackingVarianceMinutes} Minuten`;
  return rule.value;
}

function rightsProcessStepSetting(process, step) {
  const location = rightsProcessLocation();
  if (!process.locationSensitive || !location) return step.setting;
  if (process.id === "time_review" && step.id === "booking") {
    return location.timeTrackingEnabled
      ? `${location.name}: aktiv · ${location.timeTrackingAccessLabel}`
      : `${location.name}: Zeiterfassung deaktiviert`;
  }
  if (process.id === "time_review" && step.id === "variance") {
    return `${location.name}: ${location.timeTrackingVarianceMinutes} Minuten Abweichungstoleranz`;
  }
  if (process.id === "payroll" && step.id === "context") return `${location.name} ist als aktueller Standortbezug gewählt.`;
  return step.setting;
}

function rightsProcessStatus(process) {
  if (process.source === "custom") return ({ active: "Aktiv", draft: "Entwurf", archived: "Archiviert" })[process.status] || process.statusLabel || "Entwurf";
  if (!process.enabled) return process.statusLabel;
  if (process.id === "time_review") return rightsProcessLocation()?.timeTrackingEnabled ? "Am Standort aktiv" : "Am Standort deaktiviert";
  return process.statusLabel;
}

function canManageCustomProcesses() {
  return rightsProcessDashboard()?.capabilities?.canManageCustomProcesses === true;
}

function customProcessLocationOptions() {
  const dashboardLocations = rightsProcessDashboard()?.capabilities?.locations || rightsProcessDashboard()?.locations || [];
  const fullLocations = state.locations || [];
  return dashboardLocations.map((location) => {
    const fullLocation = fullLocations.find((entry) => String(entry.id) === String(location.id));
    return { ...location, departments: fullLocation?.departments || location.departments || [] };
  });
}

function customProcessStatusValue(process) {
  if (process?.status) return process.status;
  return process?.enabled ? "active" : "draft";
}

function customProcessScopeLabel(process) {
  const scope = process?.scope || {};
  if (scope.label) return scope.label;
  if (scope.type === "department") return [scope.locationName, scope.departmentName].filter(Boolean).join(" · ") || "Bestimmte Abteilung";
  if (scope.type === "location") return scope.locationName || "Bestimmte Filiale";
  return "Gesamtes Unternehmen";
}

function customProcessTriggerLabel(process) {
  const trigger = process?.trigger || {};
  return trigger.type === "staffing_shortfall"
    ? `Mindestbesetzung · ab ${Number(trigger.minimumShortfall || 1)} fehlend`
    : "Manuell";
}

function customProcessDisplayRules(process) {
  if ((process.rules || []).length) return process.rules;
  return [
    { label: "Bereich", value: customProcessScopeLabel(process), tone: "neutral" },
    { label: "Auslöser", value: customProcessTriggerLabel(process), tone: process.trigger?.type === "staffing_shortfall" ? "attention" : "neutral" },
    { label: "Revision", value: String(process.revision || 1), tone: "neutral" },
    { label: "Status", value: rightsProcessStatus(process), tone: customProcessStatusValue(process) === "active" ? "positive" : "attention" },
  ];
}

function customProcessStepId() {
  return `step-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function emptyCustomProcessStep() {
  return {
    id: customProcessStepId(),
    type: "actor",
    title: "",
    description: "",
    responsibilityType: "role",
    responsibilityReference: "manager",
    conditionType: "always",
    conditionText: "",
    notificationChannels: ["internal"],
  };
}

function defaultCustomProcessSteps() {
  return [
    { ...emptyCustomProcessStep(), title: "Situation prüfen", description: "Auslöser, Geltungsbereich und nächsten Handlungsbedarf nachvollziehbar prüfen." },
    { ...emptyCustomProcessStep(), type: "finish", title: "Prozess abschließen", description: "Ergebnis dokumentieren und den Prozess nachvollziehbar abschließen.", notificationChannels: [] },
  ];
}

function normalizeCustomProcessStep(step = {}) {
  const responsibility = step.responsibility || {};
  const condition = step.condition || {};
  const channels = step.notificationChannels || step.notification?.channels || step.channels || [];
  return {
    id: String(step.id || customProcessStepId()),
    type: String(step.type || "actor"),
    title: String(step.title || ""),
    description: String(step.description || ""),
    responsibilityType: String(step.responsibilityType || responsibility.type || responsibility.kind || "role"),
    responsibilityReference: String(step.responsibilityReference || responsibility.reference || responsibility.ref || ""),
    conditionType: String(step.conditionType || condition.type || condition.kind || "always"),
    conditionText: String(step.conditionText || condition.text || ""),
    notificationChannels: [...new Set((Array.isArray(channels) ? channels : [channels]).filter((channel) => ["internal", "email", "sms"].includes(channel)))],
  };
}

function customProcessStepTypeOptions(selected) {
  const types = [
    ["actor", "Aufgabe"], ["approval", "Freigabe"], ["decision", "Entscheidung"],
    ["system", "Systemprüfung"], ["finish", "Abschluss"],
  ];
  return types.map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`).join("");
}

function renderCustomProcessStepsEditor() {
  if (!elements.customProcessSteps) return;
  const steps = state.customProcessDraftSteps;
  elements.customProcessSteps.innerHTML = steps.length ? steps.map((step, index) => {
    const normalized = normalizeCustomProcessStep(step);
    const notificationDisabled = normalized.responsibilityType === "system" || normalized.conditionType !== "always";
    const channelCheckbox = (channel, label) => `<label><input type="checkbox" data-custom-step-channel="${channel}" ${!notificationDisabled && normalized.notificationChannels.includes(channel) ? "checked" : ""} ${notificationDisabled ? "disabled" : ""} />${label}</label>`;
    return `<article class="custom-process-step-card" data-custom-process-step="${escapeHtmlAttribute(normalized.id)}">
      <header><span class="custom-process-step-number">${index + 1}</span><div><strong>${escapeHtml(normalized.title || `Schritt ${index + 1}`)}</strong><small>${escapeHtml(normalized.description || "Aufgabe und Zuständigkeit ergänzen")}</small></div><div class="custom-process-step-order"><button type="button" data-custom-step-move="-1" ${index === 0 ? "disabled" : ""} aria-label="Schritt nach oben">↑</button><button type="button" data-custom-step-move="1" ${index === steps.length - 1 ? "disabled" : ""} aria-label="Schritt nach unten">↓</button><button type="button" class="danger" data-custom-step-remove aria-label="Schritt löschen">×</button></div></header>
      <div class="custom-process-step-fields">
        <label class="field"><span>Typ</span><select data-custom-step-field="type">${customProcessStepTypeOptions(normalized.type)}</select></label>
        <label class="field"><span>Titel</span><input data-custom-step-field="title" minlength="2" maxlength="120" value="${escapeHtmlAttribute(normalized.title)}" required /></label>
        <label class="field full-width"><span>Beschreibung</span><textarea data-custom-step-field="description" rows="2" maxlength="600" required>${escapeHtml(normalized.description)}</textarea></label>
        <label class="field"><span>Verantwortungsart</span><select data-custom-step-field="responsibilityType"><option value="role" ${normalized.responsibilityType === "role" ? "selected" : ""}>App-Rolle</option><option value="employee" ${normalized.responsibilityType === "employee" ? "selected" : ""}>Bestimmte Person</option><option value="system" ${normalized.responsibilityType === "system" ? "selected" : ""}>System</option></select></label>
        <label class="field ${normalized.responsibilityType === "system" ? "hidden" : ""}" data-custom-responsibility-reference><span>Referenz</span><input data-custom-step-field="responsibilityReference" list="customProcessResponsibilityOptions" maxlength="80" value="${escapeHtmlAttribute(normalized.responsibilityReference)}" placeholder="${normalized.responsibilityType === "employee" ? "Personalnummer" : "z. B. manager"}" ${normalized.responsibilityType === "system" ? "" : "required"} /></label>
        <label class="field"><span>Bedingung</span><select data-custom-step-field="conditionType"><option value="always" ${normalized.conditionType === "always" ? "selected" : ""}>Immer</option><option value="when" ${normalized.conditionType === "when" ? "selected" : ""}>Wenn Bedingung erfüllt</option><option value="optional" ${normalized.conditionType === "optional" ? "selected" : ""}>Optional</option></select></label>
        <label class="field ${normalized.conditionType === "always" ? "hidden" : ""}" data-custom-condition-text><span>Bedingungstext</span><input data-custom-step-field="conditionText" maxlength="400" value="${escapeHtmlAttribute(normalized.conditionText)}" placeholder="Verständlich beschreiben" ${normalized.conditionType === "when" ? "required" : ""} /></label>
        <fieldset class="custom-process-channel-options full-width"><legend>Verständigung nach diesem Schritt</legend>${channelCheckbox("internal", "Intern im Grabenplaner")}${channelCheckbox("email", "E-Mail")}${channelCheckbox("sms", "SMS")}</fieldset>
      </div>
    </article>`;
  }).join("") : "<p class=\"calculation-note\">Mindestens einen Prozessschritt hinzufügen.</p>";
}

function syncCustomProcessStepsFromEditor() {
  if (!elements.customProcessSteps) return;
  state.customProcessDraftSteps = [...elements.customProcessSteps.querySelectorAll("[data-custom-process-step]")].map((card) => {
    const value = (name) => card.querySelector(`[data-custom-step-field="${name}"]`)?.value?.trim() || "";
    return {
      id: card.dataset.customProcessStep,
      type: value("type"),
      title: value("title"),
      description: value("description"),
      responsibilityType: value("responsibilityType"),
      responsibilityReference: value("responsibilityReference"),
      conditionType: value("conditionType"),
      conditionText: value("conditionText"),
      notificationChannels: [...card.querySelectorAll("[data-custom-step-channel]:checked")].map((input) => input.dataset.customStepChannel),
    };
  });
}

function populateCustomProcessDepartments(selected = "") {
  if (!elements.customProcessScopeDepartment) return;
  const location = customProcessLocationOptions().find((entry) => String(entry.id) === String(elements.customProcessScopeLocation.value));
  const departments = (location?.departments || []).filter((department) => department.active !== false);
  elements.customProcessScopeDepartment.innerHTML = departments.length
    ? departments.map((department) => `<option value="${escapeHtmlAttribute(String(department.id))}">${escapeHtml(department.name)}</option>`).join("")
    : "<option value=\"\">Keine aktive Abteilung</option>";
  if (departments.some((department) => String(department.id) === String(selected))) elements.customProcessScopeDepartment.value = String(selected);
}

function populateCustomProcessResponsibilityOptions() {
  if (!elements.customProcessResponsibilityOptions) return;
  const capabilities = rightsProcessDashboard()?.capabilities || {};
  const roles = capabilities.roles || [];
  const scopeType = elements.customProcessScopeType?.value || "company";
  const locationId = String(elements.customProcessScopeLocation?.value || "");
  const departmentId = String(elements.customProcessScopeDepartment?.value || "");
  const employees = (capabilities.employees || []).filter((employee) => {
    if (scopeType === "company" || ["hr", "admin", "it_admin", "developer"].includes(employee.role)) return true;
    if (String(employee.locationId || "") !== locationId) return false;
    return scopeType !== "department" || String(employee.departmentId || "") === departmentId;
  });
  elements.customProcessResponsibilityOptions.innerHTML = [
    ...roles.map((role) => `<option value="${escapeHtmlAttribute(role.id)}">${escapeHtml(`Rolle · ${role.name || role.id}`)}</option>`),
    ...employees.map((employee) => `<option value="${escapeHtmlAttribute(employee.employeeNumber)}">${escapeHtml(`Person · ${employee.employeeNumber} · ${employee.fullName}`)}</option>`),
  ].join("");
}

function updateCustomProcessScopeFields(selectedDepartment = "") {
  const scopeType = elements.customProcessScopeType.value;
  const needsLocation = ["location", "department"].includes(scopeType);
  const needsDepartment = scopeType === "department";
  elements.customProcessScopeLocationField.classList.toggle("hidden", !needsLocation);
  elements.customProcessScopeLocation.required = needsLocation;
  elements.customProcessScopeDepartmentField.classList.toggle("hidden", !needsDepartment);
  elements.customProcessScopeDepartment.required = needsDepartment;
  populateCustomProcessDepartments(selectedDepartment);
  populateCustomProcessResponsibilityOptions();
}

function updateCustomProcessTriggerFields() {
  const needsShortfall = elements.customProcessTriggerType.value === "staffing_shortfall";
  elements.customProcessShortfallField.classList.toggle("hidden", !needsShortfall);
  elements.customProcessMinimumShortfall.required = needsShortfall;
}

function setCustomProcessMessage(message = "", error = false) {
  if (!elements.customProcessMessage) return;
  elements.customProcessMessage.textContent = message;
  elements.customProcessMessage.classList.toggle("hidden", !message);
  elements.customProcessMessage.classList.toggle("error", error);
}

function openCustomProcessEditor(process = null) {
  if (!canManageCustomProcesses() || !elements.customProcessModal) return;
  state.editingCustomProcessId = process?.source === "custom" ? String(process.id) : "";
  state.editingCustomProcessRevision = process?.revision ?? null;
  elements.customProcessId.value = state.editingCustomProcessId;
  elements.customProcessModalTitle.textContent = state.editingCustomProcessId ? "Eigenen Prozess bearbeiten" : "Eigenen Prozess anlegen";
  elements.customProcessTitle.value = process?.title || "";
  elements.customProcessSymbol.value = process?.symbol || "";
  elements.customProcessDescription.value = process?.description || process?.summary || "";
  elements.customProcessStatus.value = ["active", "draft"].includes(process?.status) ? process.status : "draft";
  elements.customProcessScopeType.value = process?.scope?.type || "company";
  const locations = customProcessLocationOptions();
  elements.customProcessScopeLocation.innerHTML = locations.length
    ? locations.map((location) => `<option value="${escapeHtmlAttribute(String(location.id))}">${escapeHtml(`${location.id} · ${location.name}`)}</option>`).join("")
    : "<option value=\"\">Kein aktiver Standort</option>";
  if (locations.some((location) => String(location.id) === String(process?.scope?.locationId))) elements.customProcessScopeLocation.value = String(process.scope.locationId);
  updateCustomProcessScopeFields(process?.scope?.departmentId || "");
  elements.customProcessTriggerType.value = process?.trigger?.type || "manual";
  elements.customProcessMinimumShortfall.value = String(process?.trigger?.minimumShortfall || 1);
  updateCustomProcessTriggerFields();
  state.customProcessDraftSteps = (process?.steps || defaultCustomProcessSteps()).map(normalizeCustomProcessStep);
  renderCustomProcessStepsEditor();
  setCustomProcessMessage();
  elements.customProcessModal.showModal();
}

function customProcessPayload() {
  syncCustomProcessStepsFromEditor();
  const scopeType = elements.customProcessScopeType.value;
  const triggerType = elements.customProcessTriggerType.value;
  return {
    title: elements.customProcessTitle.value.trim(),
    symbol: elements.customProcessSymbol.value.trim().toUpperCase(),
    description: elements.customProcessDescription.value.trim(),
    status: elements.customProcessStatus.value,
    revision: state.editingCustomProcessRevision ?? undefined,
    scope: {
      type: scopeType,
      locationId: ["location", "department"].includes(scopeType) ? elements.customProcessScopeLocation.value : null,
      departmentId: scopeType === "department" ? elements.customProcessScopeDepartment.value : null,
    },
    trigger: {
      type: triggerType,
      minimumShortfall: triggerType === "staffing_shortfall" ? Number(elements.customProcessMinimumShortfall.value || 1) : 1,
    },
    steps: state.customProcessDraftSteps.map((step) => ({
      id: step.id,
      type: step.type,
      title: step.title,
      description: step.description,
      responsibilityType: step.responsibilityType,
      responsibilityReference: step.responsibilityType === "system" ? "" : step.responsibilityReference,
      conditionType: step.conditionType,
      conditionText: step.conditionType === "always" ? "" : step.conditionText,
      notificationChannels: step.notificationChannels,
    })),
  };
}

async function saveCustomProcess(event) {
  event.preventDefault();
  const payload = customProcessPayload();
  if (payload.steps.length < 2) return setCustomProcessMessage("Bitte mindestens zwei Prozessschritte hinzufügen.", true);
  if (payload.status === "active" && !payload.steps.some((step) => step.type === "finish")) return setCustomProcessMessage("Ein aktiver Prozess benötigt einen klaren Abschlussschritt.", true);
  if (payload.steps.some((step) => !step.title || (step.responsibilityType !== "system" && !step.responsibilityReference) || (step.conditionType === "when" && !step.conditionText))) {
    return setCustomProcessMessage("Bitte alle Pflichtangaben der Prozessschritte vervollständigen.", true);
  }
  const id = state.editingCustomProcessId;
  elements.saveCustomProcessButton.disabled = true;
  setCustomProcessMessage(id ? "Prozess wird gespeichert …" : "Prozess wird angelegt …");
  try {
    const result = await api(id ? `/api/portal/v1/custom-processes/${encodeURIComponent(id)}` : "/api/portal/v1/custom-processes", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    const saved = result?.process || result;
    if (saved?.id) state.rightsDashboardSelectedProcessId = String(saved.id);
    elements.customProcessModal.close();
    await loadRightsDashboard();
    showToast(id ? "Der eigene Prozess wurde gespeichert." : "Der eigene Prozess wurde angelegt.");
  } catch (error) {
    setCustomProcessMessage(error.message, true);
  } finally {
    elements.saveCustomProcessButton.disabled = false;
  }
}

async function changeCustomProcessStatus(process, status) {
  const actionLabel = status === "archived" ? "archivieren" : status === "active" ? "aktivieren" : "als Entwurf speichern";
  if (status === "archived" && !confirm(`„${process.title}“ wirklich archivieren? Laufhistorie und Definition bleiben erhalten.`)) return;
  try {
    const result = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}/status`, {
      method: "PUT",
      body: JSON.stringify({ status, revision: process.revision }),
    });
    const updated = result?.process || result;
    if (updated?.id) state.rightsDashboardSelectedProcessId = String(updated.id);
    await loadRightsDashboard();
    showToast(`Der Prozess wurde ${actionLabel === "archivieren" ? "archiviert" : actionLabel === "aktivieren" ? "aktiviert" : "als Entwurf gespeichert"}.`);
  } catch (error) { showToast(error.message, true); }
}

async function triggerCustomProcess(process) {
  const processId = String(process?.id || "");
  if (!processId || state.customProcessTriggerPending.has(processId)) return;
  if (!confirm(`„${process.title}“ jetzt manuell auslösen? Zuständige Personen können dadurch verständigt werden.`)) return;
  const idempotencyKey = state.customProcessTriggerIdempotencyKeys.get(processId)
    || globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  state.customProcessTriggerIdempotencyKeys.set(processId, idempotencyKey);
  state.customProcessTriggerPending.add(processId);
  renderRightsCustomProcessActions(process);
  try {
    const result = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(processId)}/trigger`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ idempotencyKey }),
    });
    state.customProcessTriggerIdempotencyKeys.delete(processId);
    const queued = Number(result?.notifications?.internal || 0) + Number(result?.notifications?.external || 0);
    showToast(result?.duplicate
      ? "Diese Auslösung wurde bereits verarbeitet; es wurde kein zweiter Lauf gestartet."
      : `Der Prozess wurde ausgelöst${queued ? ` · ${queued} Verständigung(en) vorgemerkt` : ""}.`);
  } catch (error) {
    showToast(`${error.message} Beim erneuten Versuch wird dieselbe Vorgangs-ID verwendet.`, true);
  } finally {
    state.customProcessTriggerPending.delete(processId);
    const current = (rightsProcessDashboard()?.processes || []).find((entry) => String(entry.id) === processId) || process;
    renderRightsCustomProcessActions(current);
  }
}

function renderRightsCustomProcessActions(process) {
  if (!elements.rightsCustomProcessActions) return;
  const canManage = canManageCustomProcesses();
  const custom = process?.source === "custom";
  elements.rightsCustomProcessActions.classList.toggle("hidden", !custom || !canManage);
  if (!custom || !canManage) {
    elements.rightsCustomProcessActions.innerHTML = "";
    return;
  }
  const status = customProcessStatusValue(process);
  const toggleStatus = status === "active" ? "draft" : "active";
  const triggerPending = state.customProcessTriggerPending.has(String(process.id));
  elements.rightsCustomProcessActions.innerHTML = `
    <span><strong>Eigener Prozess</strong><small>Revision ${escapeHtml(String(process.revision || 1))} · ${escapeHtml(customProcessScopeLabel(process))}</small></span>
    <button type="button" class="secondary-button" data-custom-process-action="edit">Bearbeiten</button>
    <button type="button" class="secondary-button" data-custom-process-action="status" data-custom-process-status="${toggleStatus}">${toggleStatus === "active" ? "Aktivieren" : "Als Entwurf setzen"}</button>
    <button type="button" class="secondary-button" data-custom-process-action="trigger" ${status === "active" && !triggerPending ? "" : "disabled"}>${triggerPending ? "Wird ausgelöst …" : "Manuell auslösen"}</button>
    <button type="button" class="danger-button" data-custom-process-action="archive" ${status === "archived" ? "disabled" : ""}>Archivieren</button>`;
}

function renderRightsProcessExplanation(process, step) {
  if (!elements.rightsProcessExplanation) return;
  if (!process || !step) {
    elements.rightsProcessExplanation.innerHTML = "<strong>Prozessschritt anklicken</strong><p>Hier werden Zuständigkeit, wirksame Einstellung und benötigte Rechte erklärt.</p>";
    return;
  }
  const stateValue = rightsProcessStepState(process, step);
  const permissionLookup = new Map((state.rightsDashboard?.catalog || []).map((permission) => [permission.id, permission.label]));
  const permissions = (step.permissions || []).map((permission) => permissionLookup.get(permission) || permission);
  const settingsAction = step.settingsTarget
    ? `<button type="button" class="rights-process-action" data-rights-process-settings-tab="${escapeHtml(step.settingsTarget.tab)}">${escapeHtml(step.settingsTarget.label || "Einstellung öffnen")}</button>`
    : "";
  const permissionAction = step.permissions?.length
    ? `<button type="button" class="rights-process-action" data-rights-process-permission="${escapeHtml(step.permissions[0])}">Recht in Übersicht zeigen</button>`
    : "";
  const effect = stateValue === "active"
    ? `Teil des aktuell wirksamen ${process.source === "custom" ? "eigenen Prozesswegs" : "Standardwegs"}.`
    : stateValue === "conditional"
      ? "Wird nur ausgelöst, wenn die beschriebene Bedingung eintritt."
      : stateValue === "bypassed"
        ? "Wird mit der aktuellen Konfiguration übersprungen."
        : "Ist mit der aktuellen Modul- oder Standorteinstellung nicht aktiv.";
  elements.rightsProcessExplanation.innerHTML = `
    <strong>${escapeHtml(step.title)}</strong>
    <p>${escapeHtml(step.description)}</p>
    <dl>
      <dt>Zuständig</dt><dd>${escapeHtml(step.actor)}</dd>
      <dt>Aktuelle Regel</dt><dd>${escapeHtml(rightsProcessStepSetting(process, step))}</dd>
      <dt>Status</dt><dd>${escapeHtml(`${rightsProcessStateLabel(stateValue)} · ${effect}`)}</dd>
      <dt>Benötigte Rechte</dt><dd>${permissions.length ? permissions.map((permission) => `<code>${escapeHtml(permission)}</code>`).join(", ") : "Systemschritt ohne eigenes Benutzerrecht"}</dd>
    </dl>
    ${settingsAction || permissionAction ? `<div class="rights-process-explanation-actions">${settingsAction}${permissionAction}</div>` : ""}`;
}

function renderRightsProcessValidation() {
  const validation = rightsProcessDashboard()?.validation;
  if (!validation || !elements.rightsProcessValidationSummary) return;
  const labels = { blocker: "Blocker", warning: "Hinweise", ok: "Geprüft", info: "Info" };
  elements.rightsProcessValidationHint.textContent = validation.ready
    ? "Keine blockierende Konfiguration erkannt. Hinweise bleiben als bewusste Entscheidungen sichtbar."
    : "Mindestens ein Punkt muss vor einem verlässlichen Gesamtprozess geklärt werden.";
  elements.rightsProcessValidationSummary.innerHTML = ["blocker", "warning", "ok", "info"].map((severity) => `<span class="${severity}"><strong>${escapeHtml(String(validation.summary[severity] || 0))}</strong>${escapeHtml(labels[severity])}</span>`).join("");
  const order = { blocker: 0, warning: 1, ok: 2, info: 3 };
  const checks = [...(validation.checks || [])].sort((left, right) => order[left.severity] - order[right.severity]);
  elements.rightsProcessValidationList.innerHTML = checks.map((check) => `<button type="button" class="rights-process-validation-item ${escapeHtml(check.severity)}" data-rights-validation-process="${escapeHtml(check.processId)}" data-rights-validation-step="${escapeHtml(check.stepId || "")}"><span></span><strong>${escapeHtml(check.title)}</strong><small>${escapeHtml(check.detail)}</small></button>`).join("");
}

function renderRightsProcessDashboard() {
  const dashboard = rightsProcessDashboard();
  if (!dashboard || !elements.rightsProcessList) return;
  const processes = dashboard.processes || [];
  elements.addCustomProcessButton?.classList.toggle("hidden", !canManageCustomProcesses());
  if (!processes.some((process) => process.id === state.rightsDashboardSelectedProcessId)) {
    state.rightsDashboardSelectedProcessId = processes[0]?.id || "";
    state.rightsDashboardSelectedProcessStepId = "";
  }
  const selectedDefinition = processes.find((process) => process.id === state.rightsDashboardSelectedProcessId);
  const processButton = (process) => {
    const selected = process.id === state.rightsDashboardSelectedProcessId;
    const status = rightsProcessStatus(process);
    const active = process.source === "custom" ? customProcessStatusValue(process) === "active" : process.enabled;
    return `<button type="button" class="rights-process-item ${process.source === "custom" ? "custom" : "standard"} ${active ? "" : "disabled"} ${selected ? "selected" : ""}" data-rights-process="${escapeHtmlAttribute(process.id)}" aria-pressed="${selected}"><span class="rights-process-item-mark">${escapeHtml(process.symbol)}</span><span class="rights-process-item-copy"><strong>${escapeHtml(process.title)}</strong><small>${escapeHtml(status)}${process.source === "custom" ? ` · Revision ${escapeHtml(String(process.revision || 1))}` : ""}</small></span></button>`;
  };
  const standardProcesses = processes.filter((process) => process.source !== "custom");
  const customProcesses = processes.filter((process) => process.source === "custom");
  elements.rightsProcessList.innerHTML = processes.length
    ? `${standardProcesses.length ? `<section class="rights-process-list-group"><span>Standardprozesse</span>${standardProcesses.map(processButton).join("")}</section>` : ""}${customProcesses.length ? `<section class="rights-process-list-group custom"><span>Eigene Prozesse</span>${customProcesses.map(processButton).join("")}</section>` : canManageCustomProcesses() ? '<section class="rights-process-list-group custom"><span>Eigene Prozesse</span><p class="settings-note">Noch kein eigener Prozess angelegt.</p></section>' : ""}`
    : "<p class=\"settings-note\">Keine Prozessdefinitionen verfügbar.</p>";
  if (!selectedDefinition) {
    renderRightsCustomProcessActions(null);
    return;
  }
  populateRightsProcessScenarios(selectedDefinition);
  const selectedProcess = rightsProcessWithScenario(selectedDefinition);
  elements.rightsProcessLocation.disabled = !selectedProcess.locationSensitive;
  elements.rightsProcessTitle.textContent = selectedProcess.title;
  elements.rightsProcessSummary.textContent = selectedProcess.summary;
  const processStatus = rightsProcessStatus(selectedProcess);
  elements.rightsProcessStatus.textContent = processStatus;
  const processActive = selectedProcess.source === "custom" ? customProcessStatusValue(selectedProcess) === "active" : selectedProcess.enabled;
  elements.rightsProcessStatus.classList.toggle("inactive", !processActive || processStatus.includes("deaktiviert"));
  elements.rightsProcessSimulationNote.innerHTML = selectedProcess.source === "custom"
    ? `<strong>${escapeHtml(selectedProcess.scenario.label)}</strong><span>${escapeHtml(selectedProcess.scenario.description)} · Eigener Prozess, Revision ${escapeHtml(String(selectedProcess.revision || 1))}.</span>`
    : `<strong>${escapeHtml(selectedProcess.scenario.label)}</strong><span>${escapeHtml(selectedProcess.scenario.description)} · Nur Vorschau, keine gespeicherten Daten werden verändert.</span>`;
  elements.rightsProcessRules.innerHTML = customProcessDisplayRules(selectedProcess).map((rule) => `<article class="rights-process-rule ${escapeHtml(rule.tone || "neutral")}"><span>${escapeHtml(rule.label)}</span><strong>${escapeHtml(rightsProcessRuleValue(rule))}</strong></article>`).join("");
  renderRightsCustomProcessActions(selectedProcess);
  if (!(selectedProcess.steps || []).some((step) => step.id === state.rightsDashboardSelectedProcessStepId)) {
    state.rightsDashboardSelectedProcessStepId = selectedProcess.steps?.[0]?.id || "";
  }
  elements.rightsProcessTimeline.innerHTML = (selectedProcess.steps || []).map((step) => {
    const stateValue = rightsProcessStepState(selectedProcess, step);
    const selected = step.id === state.rightsDashboardSelectedProcessStepId;
    return `<button type="button" class="rights-process-step ${escapeHtml(step.type || "system")} ${escapeHtml(stateValue)} ${selected ? "selected" : ""}" data-rights-process-step="${escapeHtml(step.id)}" aria-pressed="${selected}"><span class="rights-process-step-track"></span><span class="rights-process-step-copy"><strong>${escapeHtml(step.title)}</strong><span>${escapeHtml(step.actor)}</span><small>${escapeHtml(step.description)}</small></span><span class="rights-process-step-state">${escapeHtml(rightsProcessStateLabel(stateValue))}</span></button>`;
  }).join("");
  const selectedStep = selectedProcess.steps?.find((step) => step.id === state.rightsDashboardSelectedProcessStepId) || null;
  renderRightsProcessExplanation(selectedProcess, selectedStep);
}

function openRightsProcessSettings(tab) {
  setView("settings");
  setSettingsTab(tab);
  window.setTimeout(() => document.querySelector(`[data-settings-tab="${CSS.escape(tab)}"]`)?.focus(), 120);
}

function showRightsProcessPermission(permissionId) {
  setRightsDashboardMode("rights");
  elements.rightsDashboardSearch.value = permissionId;
  elements.rightsDashboardRoleFilter.value = "";
  elements.rightsDashboardLocationFilter.value = "";
  elements.rightsDashboardOriginFilter.value = "";
  populateRightsDashboardDepartments();
  state.rightsDashboardSelectedEmployeeNumber = "";
  state.rightsDashboardSelectedPermissionId = permissionId;
  renderRightsDashboard();
  elements.rightsDashboardSearch.focus();
}

function exportRightsProcessPdf() {
  const processId = state.rightsDashboardSelectedProcessId || "vacation";
  const scenario = state.rightsProcessScenarioIds[processId] || "current";
  const parameters = new URLSearchParams({ process: processId, scenario });
  if (state.rightsProcessLocationId) parameters.set("location", state.rightsProcessLocationId);
  const link = document.createElement("a");
  link.href = `/api/portal/v1/rights-dashboard/process-export.pdf?${parameters.toString()}`;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

async function loadRightsDashboard() {
  if (!elements.rightsDashboardView) return;
  try {
    const [dashboard, personnelFieldRights] = await Promise.all([
      api("/api/portal/v1/rights-dashboard"),
      state.personnelFieldRights || api("/api/portal/v1/personnel-field-rights"),
    ]);
    state.rightsDashboard = dashboard;
    state.personnelFieldRights = personnelFieldRights;
    applyRightsDashboardTheme(state.pageThemes.rightsDashboard || dashboard.preferences?.theme || "light");
    populateRightsDashboardFilters();
    populateRightsProcessLocations();
    renderRightsProcessValidation();
    renderRightsDashboardSummary();
    renderRightsDashboard();
    await loadLocationDashboard();
    setRightsDashboardMode(state.rightsDashboardMode);
  } catch (error) {
    state.rightsDashboard = null;
    elements.addCustomProcessButton?.classList.add("hidden");
    elements.rightsCustomProcessActions?.classList.add("hidden");
    elements.rightsDashboardUserList.innerHTML = `<p class="settings-note">${escapeHtml(error.status === 403 ? "Die Dashboards sind nur für Personalleitung, Admin, IT-Admin und Developer verfügbar." : error.message)}</p>`;
    elements.rightsDashboardEmpty?.classList.remove("hidden");
    elements.rightsDashboardSelection?.classList.add("hidden");
  }
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
    elements.sicknessLocalWarningDays.value = Number(policy.localWarningDays ?? 2);
    elements.sicknessHrWarningDays.value = Number(policy.hrWarningDays ?? 3);
    elements.sicknessAumAllowanceEnabled.checked = policy.aumAllowance?.enabled === true;
    elements.sicknessAumAllowanceMaxCases.value = Number(policy.aumAllowance?.maxCasesPerYear ?? 3);
    elements.sicknessAumAllowanceMaxDays.value = Number(policy.aumAllowance?.maxCalendarDaysPerCase ?? 1);
    elements.amuAutoReviewTrustA.checked = policy.autoReviewTrustA === true;
    [elements.amuUploadMaxMb, elements.amuStoredMaxMb, elements.amuConvertImagesToPdf, elements.amuGrayscaleImages, elements.amuOcrEnabled, elements.sicknessLocalWarningDays, elements.sicknessHrWarningDays, elements.sicknessAumAllowanceEnabled, elements.sicknessAumAllowanceMaxCases, elements.sicknessAumAllowanceMaxDays, elements.amuAutoReviewTrustA, elements.saveAmuSettingsButton]
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
        localWarningDays: Number(elements.sicknessLocalWarningDays.value),
        hrWarningDays: Number(elements.sicknessHrWarningDays.value),
        aumAllowance: {
          enabled: elements.sicknessAumAllowanceEnabled.checked,
          maxCasesPerYear: Number(elements.sicknessAumAllowanceMaxCases.value),
          maxCalendarDaysPerCase: Number(elements.sicknessAumAllowanceMaxDays.value),
        },
        autoReviewTrustA: elements.amuAutoReviewTrustA.checked,
      }),
    });
    state.amuPolicy = result.policy;
    showToast("AUM-Einstellungen wurden gespeichert.");
    await loadAmuSettings();
  } catch (error) { showToast(error.message, true); }
}

function renderAmuAccessPolicy(result = state.amuAccessPolicy) {
  if (!elements.amuManagerAccessList || !elements.amuManagerDefaultAccess) return;
  const policy = result?.policy || {};
  const canChange = result?.canChange === true;
  const managerDefault = policy.managerDefault !== false;
  const managers = Array.isArray(policy.managers) ? policy.managers : [];
  elements.amuManagerDefaultAccess.checked = managerDefault;
  elements.amuManagerDefaultAccess.disabled = !canChange;
  elements.saveAmuAccessPolicyButton.disabled = !canChange;
  elements.amuManagerAccessList.innerHTML = managers.length ? managers.map((manager) => {
    const locations = (manager.locations || []).map((location) => location.name).filter(Boolean).join(" · ") || "Keine Filiale zugewiesen";
    const inheritedLabel = managerDefault ? "Rollenstandard · erlaubt" : "Rollenstandard · PL übernimmt";
    const effectiveLabel = manager.routingEligible ? "Filialleitung zuständig" : "Personalleitung zuständig";
    return `<article class="amu-manager-access-row">
      <div class="amu-manager-access-person"><strong>${escapeHtml(manager.employeeNumber)} · ${escapeHtml(manager.nickname || manager.fullName || "Filialleitung")}</strong><small>${escapeHtml(locations)}${manager.active ? (manager.passwordConfigured ? "" : " · noch kein Passwort") : " · Zugang inaktiv"}</small></div>
      <label class="field"><span>Persönliche Regel</span><select data-amu-manager-access="${escapeHtml(manager.employeeNumber)}" ${canChange ? "" : "disabled"}>
        <option value="inherit" ${manager.accessMode === "inherit" ? "selected" : ""}>${escapeHtml(inheritedLabel)}</option>
        <option value="allow" ${manager.accessMode === "allow" ? "selected" : ""}>Persönlich erlaubt</option>
        <option value="deny" ${manager.accessMode === "deny" ? "selected" : ""}>Entzogen · PL übernimmt</option>
      </select></label>
      <span class="status-badge ${manager.routingEligible ? "approved" : "warning"}">${escapeHtml(effectiveLabel)}</span>
    </article>`;
  }).join("") : '<p class="settings-note">Noch keine Filialleitung mit Portalzugang eingerichtet.</p>';
  elements.amuAccessPolicyHint.textContent = canChange
    ? "Entzüge wirken sofort. Offene AUMs werden automatisch der Personalleitung zugewiesen."
    : "Nur Personalleitung, Administration oder IT-Administration kann diese Regeln ändern.";
}

async function loadAmuAccessPolicy() {
  const section = elements.amuManagerDefaultAccess?.closest(".amu-access-policy");
  if (!section) return;
  try {
    const result = await api("/api/portal/v1/amu-access-policy");
    state.amuAccessPolicy = result;
    section.classList.remove("hidden");
    renderAmuAccessPolicy(result);
  } catch (error) {
    section.classList.toggle("hidden", error.status === 403);
    if (error.status !== 403) elements.amuAccessPolicyHint.textContent = error.message;
  }
}

async function saveAmuAccessPolicy() {
  const overrides = [...elements.amuManagerAccessList.querySelectorAll("[data-amu-manager-access]")].map((select) => ({
    employeeNumber: select.dataset.amuManagerAccess,
    accessMode: select.value,
  }));
  elements.saveAmuAccessPolicyButton.disabled = true;
  try {
    const result = await api("/api/portal/v1/amu-access-policy", {
      method: "PUT",
      body: JSON.stringify({
        managerDefault: elements.amuManagerDefaultAccess.checked,
        overrides,
      }),
    });
    state.amuAccessPolicy = result;
    renderAmuAccessPolicy(result);
    showToast("AUM-Zugriff und Zuständigkeit wurden gespeichert.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    if (state.amuAccessPolicy?.canChange) elements.saveAmuAccessPolicyButton.disabled = false;
  }
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
  const employees = (state.trustLevelSettings?.employees || []).filter((employee) => {
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
  if (!elements.timeTrackingSettings || !elements.wifiSettingsCard || elements.wifiSettingsCard.classList.contains("hidden")) return;
  try {
    const result = await api("/api/portal/v1/wifi-automation/settings");
    state.wifiAutomationSettings = result;
    elements.wifiMinimumPresenceMinutes.value = Number(result.minimumPresenceMinutes || 5);
    elements.wifiAbsenceGraceMinutes.value = Number(result.absenceGraceMinutes || 30);
    elements.saveWifiAutomationSettingsButton.disabled = result.canChange === false;
    elements.saveWifiLocationMappingsButton.disabled = result.canChange === false;
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
  } catch (error) {
    elements.wifiAutomationSettingsHint.textContent = error.status === 403
      ? "WLAN-Regeln sind nur für Personalleitung, Admin, IT-Admin und Developer verfügbar."
      : error.message;
  }
}

function contextPreferenceUserKey() {
  return state.portalSession?.user?.employeeNumber || "local";
}

function rememberContextSettingKey(view) {
  return view === "vacations" ? "remember_last_vacation_overall_plan" : "remember_last_schedule_overall_plan";
}

function rememberContextCacheKey(view) {
  return `grabenplaner-remember-${view}-overall-plan`;
}

function rememberContextEnabled(view) {
  const settings = state.data?.settings;
  const key = rememberContextSettingKey(view);
  if (settings && key in settings) {
    const enabled = settings[key] !== "0";
    localStorage.setItem(rememberContextCacheKey(view), enabled ? "1" : "0");
    return enabled;
  }
  return localStorage.getItem(rememberContextCacheKey(view)) !== "0";
}

function rememberedContextKey(view) {
  return `grabenplaner-last-overall-plan:${contextPreferenceUserKey()}:${view}`;
}

function rememberOverallContext(view, locationId, departmentId = "") {
  if (!rememberContextEnabled(view) || departmentId || !locationId) return;
  localStorage.setItem(rememberedContextKey(view), locationId);
}

function restoreRememberedOverallContext(view, locations = state.locations) {
  if (!["planning", "vacations"].includes(view) || !rememberContextEnabled(view)) return false;
  if (state.portalSession?.user?.role === "department_manager") return false;
  const locationId = localStorage.getItem(rememberedContextKey(view));
  if (!locationId || !(locations || []).some((location) => location.id === locationId && location.active)) return false;
  const changed = state.locationId !== locationId || Boolean(state.departmentId);
  state.locationId = locationId;
  state.departmentId = "";
  return changed;
}

function renderTrustLevelSettings() {
  const settings = state.trustLevelSettings;
  if (!settings) return;
  elements.trustLevelsEnabled.checked = settings.enabled !== false;
  elements.trustLevelsVisibleToManagers.checked = settings.visibleToManagers === true;
  elements.trustLevelsVisibleToDepartmentManagers.checked = settings.visibleToDepartmentManagers === true;
  elements.trustLevelsVisibleToEmployees.checked = settings.visibleToEmployees !== false;
  elements.saveWifiConfirmationLevelsButton.disabled = settings.canChange === false;
  renderWifiConfirmationLevels();
}

async function loadTrustLevelSettings() {
  if (!elements.trustLevelSettingsCard || elements.trustLevelSettingsCard.classList.contains("hidden")) return;
  try {
    state.trustLevelSettings = await api("/api/portal/v1/trust-level-settings");
    renderTrustLevelSettings();
  } catch (error) {
    elements.wifiConfirmationLevelHint.textContent = error.status === 403
      ? "Vertrauensstufen sind nur für Personalleitung, Admin, IT-Admin und Developer verfügbar."
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
  const levels = (state.trustLevelSettings?.employees || [])
    .map((employee) => ({ employeeNumber: employee.employeeNumber, level: employee.level }));
  try {
    const result = await api("/api/portal/v1/trust-level-settings", {
      method: "PUT",
      body: JSON.stringify({
        enabled: elements.trustLevelsEnabled.checked,
        visibleToManagers: elements.trustLevelsVisibleToManagers.checked,
        visibleToDepartmentManagers: elements.trustLevelsVisibleToDepartmentManagers.checked,
        visibleToEmployees: elements.trustLevelsVisibleToEmployees.checked,
        levels,
      }),
    });
    state.trustLevelSettings = result;
    renderTrustLevelSettings();
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

async function loadWorkflowSettings() {
  if (!elements.workflowSettingsCard) return;
  try {
    state.workflowSettings = await api("/api/portal/v1/workflow-settings");
    elements.vacationHrApprovalRequired.checked = Boolean(state.workflowSettings.vacationHrApprovalRequired);
    elements.vacationHrApprovalRequired.disabled = state.workflowSettings.canChange !== true;
    elements.workflowSettingsHint.textContent = state.workflowSettings.canChange
      ? "Die Einstellung kann von Personalleitung oder höher geändert werden."
      : "Nur Personalleitung oder höhere Rollen können diese Einstellung ändern.";
  } catch (error) {
    elements.workflowSettingsCard.classList.toggle("hidden", error.status === 403);
    if (error.status !== 403) elements.workflowSettingsHint.textContent = error.message;
  }
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
    state.amuCanReview = amu.canReview === true;
    state.amuAccess = amu.access || null;
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
    elements.timePresenceList.innerHTML = '<p class="settings-note">Die Zeiterfassung ist für diesen Standort noch nicht aktiviert. Die Aktivierung erfolgt in der Filialverwaltung.</p>';
    return;
  }
  const labels = { working: "Anwesend", paused: "Pause", off: "Abwesend", attention: "Bitte prüfen" };
  const canReadPersonnelRecord = personnelRecordAvailableInUi();
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

const PERSONNEL_RECORD_FORM_FIELDS = Object.freeze([
  ["firstName", "identity.firstName", ["identity", "firstName"]], ["lastName", "identity.lastName", ["identity", "lastName"]],
  ["previousName", "identity.previousName", ["identity", "previousName"]], ["salutation", "identity.salutation", ["identity", "salutation"]],
  ["title", "identity.title", ["identity", "title"]], ["birthDate", "identity.birthDate", ["identity", "birthDate"]],
  ["birthPlace", "identity.birthPlace", ["identity", "birthPlace"]], ["nationality", "identity.nationality", ["identity", "nationality"]],
  ["socialSecurityNumber", "socialSecurityNumber", ["socialSecurityNumber"]], ["iban", "iban", ["iban"]],
  ["bic", "bic", ["bic"]], ["accountHolder", "accountHolder", ["accountHolder"]],
  ["street", "address.street", ["address", "street"]], ["addressSupplement", "address.supplement", ["address", "supplement"]],
  ["postalCode", "address.postalCode", ["address", "postalCode"]], ["city", "address.city", ["address", "city"]],
  ["state", "address.state", ["address", "state"]], ["country", "address.country", ["address", "country"]],
  ["alternatePhone", "alternatePhone", ["alternatePhone"]], ["privateEmail", "privateEmail", ["privateEmail"]],
  ["emergencyName", "emergencyContact.name", ["emergencyContact", "name"]],
  ["emergencyRelationship", "emergencyContact.relationship", ["emergencyContact", "relationship"]],
  ["emergencyPhone", "emergencyContact.phone", ["emergencyContact", "phone"]],
  ["employmentStartDate", "employment.startDate", ["employment", "startDate"]],
  ["employmentEndDate", "employment.endDate", ["employment", "endDate"]],
  ["fixedTermEnd", "employment.fixedTermEnd", ["employment", "fixedTermEnd"]],
  ["probationEnd", "employment.probationEnd", ["employment", "probationEnd"]],
  ["employmentType", "employment.employmentType", ["employment", "employmentType"]],
  ["contractType", "employment.contractType", ["employment", "contractType"]],
  ["employmentStatus", "employment.employmentStatus", ["employment", "employmentStatus"]],
  ["collectiveAgreement", "employment.collectiveAgreement", ["employment", "collectiveAgreement"]],
  ["classification", "employment.classification", ["employment", "classification"]],
  ["payrollGroup", "employment.payrollGroup", ["employment", "payrollGroup"]],
  ["employmentNotes", "employment.notes", ["employment", "notes"]],
]);

function personnelRecordAccessMode(access = {}, fieldKey) {
  const explicit = access.fieldAccess?.[fieldKey];
  if (["hidden", "read", "write"].includes(explicit)) return explicit;
  if (fieldKey === "phone") return access.canWritePhone ? "write" : access.canReadPhone ? "read" : "hidden";
  if (fieldKey === "documents") return access.canWriteDocuments ? "write" : access.canReadDocuments ? "read" : "hidden";
  return access.canWriteSensitive ? "write" : access.canReadSensitive ? "read" : "hidden";
}

function personnelRecordSectionMode(access, fieldKeys) {
  const modes = fieldKeys.map((key) => personnelRecordAccessMode(access, key));
  if (modes.includes("write") && modes.includes("read")) return "mixed";
  return modes.includes("write") ? "write" : modes.includes("read") ? "read" : "hidden";
}

function personnelRecordField(name, fieldKey, label, value, accessMode, attributes = "", spanTwo = false) {
  if (accessMode === "hidden") return "";
  const editable = accessMode === "write";
  const protectedAttributes = String(attributes || "").replace(/\s*autocomplete="[^"]*"/gi, "");
  return `<label class="field${spanTwo ? " personnel-record-span-two" : ""}${editable ? "" : " personnel-record-field-readonly"}" data-personnel-field-key="${escapeHtmlAttribute(fieldKey)}"><span>${escapeHtml(label)}</span><input name="${escapeHtmlAttribute(name)}" value="${escapeHtmlAttribute(value || "")}" autocomplete="off" data-1p-ignore="true" data-lpignore="true" ${protectedAttributes} ${editable ? "" : "disabled"} /></label>`;
}

function personnelRecordArea(name, fieldKey, label, value, accessMode) {
  if (accessMode === "hidden") return "";
  const editable = accessMode === "write";
  return `<label class="field personnel-record-span-two${editable ? "" : " personnel-record-field-readonly"}" data-personnel-field-key="${escapeHtmlAttribute(fieldKey)}"><span>${escapeHtml(label)}</span><textarea name="${escapeHtmlAttribute(name)}" rows="3" maxlength="2000" autocomplete="off" data-1p-ignore="true" data-lpignore="true" ${editable ? "" : "disabled"}>${escapeHtml(value || "")}</textarea></label>`;
}

function personnelRecordDetails(title, eyebrow, accessMode, content, className = "") {
  if (accessMode === "hidden" || !String(content || "").trim()) return "";
  const editable = accessMode === "write" || accessMode === "mixed" || accessMode === true;
  const badge = accessMode === "mixed" ? "Teilweise bearbeitbar" : editable ? "Bearbeitbar" : "Nur lesen";
  return `<details class="personnel-record-details ${className}" open><summary><span><small>${escapeHtml(eyebrow)}</small><strong>${escapeHtml(title)}</strong></span><span class="status-badge ${accessMode === "mixed" ? "warning" : editable ? "approved" : "inactive"}">${badge}</span></summary><div class="personnel-record-details-body">${content}</div></details>`;
}

function personnelDocumentDate(value) {
  if (!value) return "Kein Dokumentdatum";
  const parsed = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? "Kein Dokumentdatum" : new Intl.DateTimeFormat("de-AT").format(parsed);
}

function renderPersonnelDocuments(employeeNumber, result, access) {
  const documentAccess = personnelRecordAccessMode(access, "documents");
  const canReadDocuments = documentAccess !== "hidden";
  const canWriteDocuments = documentAccess === "write";
  if (!canReadDocuments) return "";
  const entries = (Array.isArray(result.documents) ? result.documents : []).map((document) => {
    const id = String(document.id || "");
    const title = document.title || document.original_name || document.original_filename || "Personalakt-Dokument";
    const category = document.category_label || document.category || "Sonstiges";
    const description = document.description ? `<p>${escapeHtml(document.description)}</p>` : "";
    return `<article class="personnel-document-entry"><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(category)} · ${escapeHtml(personnelDocumentDate(document.document_date || document.documentDate))}</small>${description}</div><div class="personnel-document-actions"><a class="secondary-button compact-button" href="/api/portal/v1/personnel-records/${encodeURIComponent(employeeNumber)}/documents/${encodeURIComponent(id)}/content" target="_blank" rel="noopener">Öffnen</a>${canWriteDocuments ? `<button type="button" class="danger-button compact-button" data-delete-personnel-document="${escapeHtmlAttribute(id)}">Löschen</button>` : ""}</div></article>`;
  }).join("");
  const upload = canWriteDocuments ? `
    <div class="personnel-document-upload">
      <div class="personnel-record-field-grid">
        <label class="field"><span>Kategorie</span><select name="personnelDocumentCategory"><option value="contract">Dienstvertrag</option><option value="amendment">Vertragsänderung / Vereinbarung</option><option value="certificate">Zeugnis / Nachweis</option><option value="training">Schulung</option><option value="identity">Identitätsnachweis</option><option value="payroll">Lohnverrechnung</option><option value="other">Sonstiges</option></select></label>
        <label class="field"><span>Dokumentdatum</span><input name="personnelDocumentDate" type="date" /></label>
        <label class="field personnel-record-span-two"><span>Titel</span><input name="personnelDocumentTitle" maxlength="160" /></label>
        <label class="field personnel-record-span-two"><span>Beschreibung</span><textarea name="personnelDocumentDescription" rows="2" maxlength="600" placeholder="Optional"></textarea></label>
        <label class="field personnel-record-span-two"><span>PDF oder Bild · höchstens 15 MB</span><input name="personnelDocumentFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/tiff" /></label>
      </div>
      <div class="personnel-document-upload-actions"><button type="button" class="primary-button compact-button" data-upload-personnel-document>Dokument geschützt hochladen</button></div>
    </div>` : "";
  return personnelRecordDetails("Personalakt-Dokumente", "Geschützte Ablage", documentAccess,
    `<div class="personnel-document-list">${entries || '<p class="settings-note">Noch keine allgemeinen Personalakt-Dokumente vorhanden.</p>'}</div>${upload}`,
    "sensitive-personnel-section");
}

async function openPersonnelRecord(employeeNumber) {
  if (!elements.personnelRecordModal) return;
  const requestToken = Symbol(`personnel-record-${employeeNumber}`);
  state.personnelRecordRequestToken = requestToken;
  state.personnelRecord = null;
  state.personnelRecordDirtyFields.clear();
  elements.personnelRecordTitle.textContent = `Personalakt · ${employeeNumber}`;
  elements.personnelRecordContent.innerHTML = '<p class="settings-note">Einträge werden geladen.</p>';
  elements.personnelRecordMessage.textContent = "";
  elements.personnelRecordMessage.classList.add("hidden");
  elements.savePersonnelRecordButton.classList.add("hidden");
  if (!elements.personnelRecordModal.open) elements.personnelRecordModal.showModal();
  try {
    const result = await api(`/api/portal/v1/personnel-records/${encodeURIComponent(employeeNumber)}`);
    if (!elements.personnelRecordModal.open || state.personnelRecordRequestToken !== requestToken) return;
    state.personnelRecord = { employeeNumber, result };
    const employee = result.employee || {};
    const access = result.access || {};
    const record = normalizeProtectedPersonnelRecord(result.profile || {});
    const sensitive = record.sensitive;
    const mode = (key) => personnelRecordAccessMode(access, key);
    elements.personnelRecordTitle.textContent = `${employee.personnel_number || employeeNumber} · ${employee.nickname || employee.full_name || "Personalakt"}`;

    const contactKeys = ["phone", "alternatePhone", "privateEmail"];
    const contactSection = personnelRecordDetails("Kontaktdaten", "Kontakt", personnelRecordSectionMode(access, contactKeys), `
      <div class="personnel-record-field-grid">
        ${personnelRecordField("personnelPhone", "phone", "Telefonnummer", record.phone, mode("phone"), 'type="tel" maxlength="40" autocomplete="tel"')}
        ${personnelRecordField("alternatePhone", "alternatePhone", "Weitere Telefonnummer", sensitive.alternatePhone, mode("alternatePhone"), 'type="tel" maxlength="40"')}
        ${personnelRecordField("privateEmail", "privateEmail", "Private E-Mail", sensitive.privateEmail, mode("privateEmail"), 'type="email" maxlength="160" autocomplete="email"', true)}
      </div>${access.phoneWriteRequiresTrustA && mode("phone") !== "write" ? '<p class="calculation-note">Leitungen benötigen für Änderungen ein ausdrücklich vergebenes Schreibrecht und die eigene Vertrauensstufe A.</p>' : ""}`);

    const identityKeys = ["identity.firstName", "identity.lastName", "identity.previousName", "identity.salutation", "identity.title", "identity.birthDate", "identity.birthPlace", "identity.nationality"];
    const identitySection = personnelRecordDetails("Persönliche Daten", "Identität", personnelRecordSectionMode(access, identityKeys), `
      <div class="personnel-record-field-grid">
        ${personnelRecordField("firstName", "identity.firstName", "Vorname", sensitive.identity.firstName, mode("identity.firstName"), 'maxlength="100" autocomplete="given-name"')}
        ${personnelRecordField("lastName", "identity.lastName", "Nachname", sensitive.identity.lastName, mode("identity.lastName"), 'maxlength="100" autocomplete="family-name"')}
        ${personnelRecordField("previousName", "identity.previousName", "Früherer Name", sensitive.identity.previousName, mode("identity.previousName"), 'maxlength="120"')}
        ${personnelRecordField("salutation", "identity.salutation", "Anrede", sensitive.identity.salutation, mode("identity.salutation"), 'maxlength="40"')}
        ${personnelRecordField("title", "identity.title", "Titel", sensitive.identity.title, mode("identity.title"), 'maxlength="80"')}
        ${personnelRecordField("birthDate", "identity.birthDate", "Geburtsdatum", sensitive.identity.birthDate, mode("identity.birthDate"), 'type="date"')}
        ${personnelRecordField("birthPlace", "identity.birthPlace", "Geburtsort", sensitive.identity.birthPlace, mode("identity.birthPlace"), 'maxlength="120"')}
        ${personnelRecordField("nationality", "identity.nationality", "Staatsangehörigkeit", sensitive.identity.nationality, mode("identity.nationality"), 'maxlength="80"')}
      </div>`);

    const emergencyKeys = ["emergencyContact.name", "emergencyContact.relationship", "emergencyContact.phone"];
    const emergencySection = personnelRecordDetails("Notfallkontakt", "Kontakt", personnelRecordSectionMode(access, emergencyKeys), `
      <div class="personnel-record-field-grid">
        ${personnelRecordField("emergencyName", "emergencyContact.name", "Name", sensitive.emergencyContact.name, mode("emergencyContact.name"), 'maxlength="120"')}
        ${personnelRecordField("emergencyRelationship", "emergencyContact.relationship", "Beziehung", sensitive.emergencyContact.relationship, mode("emergencyContact.relationship"), 'maxlength="80"')}
        ${personnelRecordField("emergencyPhone", "emergencyContact.phone", "Telefonnummer", sensitive.emergencyContact.phone, mode("emergencyContact.phone"), 'type="tel" maxlength="40"', true)}
      </div>`);

    const protectedKeys = ["socialSecurityNumber", "accountHolder", "iban", "bic", "address.street", "address.supplement", "address.postalCode", "address.city", "address.state", "address.country"];
    const protectedSection = personnelRecordDetails("SV, Bank & Adresse", "Besonders geschützt", personnelRecordSectionMode(access, protectedKeys), `
      <div class="personnel-record-field-grid">
        ${personnelRecordField("socialSecurityNumber", "socialSecurityNumber", "SV-Nummer", sensitive.socialSecurityNumber, mode("socialSecurityNumber"), 'inputmode="numeric" maxlength="13" autocomplete="off"')}
        ${personnelRecordField("accountHolder", "accountHolder", "Kontoinhaber/-in", sensitive.accountHolder, mode("accountHolder"), 'maxlength="120" autocomplete="off"')}
        ${personnelRecordField("iban", "iban", "IBAN", sensitive.iban, mode("iban"), 'maxlength="34" autocomplete="off"', true)}
        ${personnelRecordField("bic", "bic", "BIC", sensitive.bic, mode("bic"), 'maxlength="11" autocomplete="off"')}
        ${personnelRecordField("street", "address.street", "Straße und Hausnummer", sensitive.address.street, mode("address.street"), 'maxlength="160" autocomplete="street-address"', true)}
        ${personnelRecordField("addressSupplement", "address.supplement", "Adresszusatz", sensitive.address.supplement, mode("address.supplement"), 'maxlength="120"', true)}
        ${personnelRecordField("postalCode", "address.postalCode", "Postleitzahl", sensitive.address.postalCode, mode("address.postalCode"), 'maxlength="20" autocomplete="postal-code"')}
        ${personnelRecordField("city", "address.city", "Ort", sensitive.address.city, mode("address.city"), 'maxlength="100" autocomplete="address-level2"')}
        ${personnelRecordField("state", "address.state", "Bundesland", sensitive.address.state, mode("address.state"), 'maxlength="100" autocomplete="address-level1"')}
        ${personnelRecordField("country", "address.country", "Land", sensitive.address.country, mode("address.country"), 'maxlength="80" autocomplete="country-name"')}
      </div><p class="calculation-note">Diese Werte werden verschlüsselt gespeichert und niemals in Teamlisten ausgegeben.</p>`, "sensitive-personnel-section");

    const employmentKeys = ["employment.startDate", "employment.endDate", "employment.fixedTermEnd", "employment.probationEnd", "employment.employmentType", "employment.contractType", "employment.employmentStatus", "employment.collectiveAgreement", "employment.classification", "employment.payrollGroup", "employment.notes"];
    const employmentSection = personnelRecordDetails("Beschäftigung & Vertrag", "Vertragsdaten", personnelRecordSectionMode(access, employmentKeys), `
      <div class="personnel-record-field-grid">
        ${personnelRecordField("employmentStartDate", "employment.startDate", "Eintrittsdatum", sensitive.employment.startDate, mode("employment.startDate"), 'type="date"')}
        ${personnelRecordField("employmentEndDate", "employment.endDate", "Austrittsdatum", sensitive.employment.endDate, mode("employment.endDate"), 'type="date"')}
        ${personnelRecordField("fixedTermEnd", "employment.fixedTermEnd", "Befristet bis", sensitive.employment.fixedTermEnd, mode("employment.fixedTermEnd"), 'type="date"')}
        ${personnelRecordField("probationEnd", "employment.probationEnd", "Probezeit bis", sensitive.employment.probationEnd, mode("employment.probationEnd"), 'type="date"')}
        ${personnelRecordField("employmentType", "employment.employmentType", "Beschäftigungsart", sensitive.employment.employmentType, mode("employment.employmentType"), 'maxlength="100"')}
        ${personnelRecordField("contractType", "employment.contractType", "Vertragsart", sensitive.employment.contractType, mode("employment.contractType"), 'maxlength="100"')}
        ${personnelRecordField("employmentStatus", "employment.employmentStatus", "Beschäftigungsstatus", sensitive.employment.employmentStatus, mode("employment.employmentStatus"), 'maxlength="80"')}
        ${personnelRecordField("collectiveAgreement", "employment.collectiveAgreement", "Kollektivvertrag", sensitive.employment.collectiveAgreement, mode("employment.collectiveAgreement"), 'maxlength="160"')}
        ${personnelRecordField("classification", "employment.classification", "Einstufung", sensitive.employment.classification, mode("employment.classification"), 'maxlength="120"')}
        ${personnelRecordField("payrollGroup", "employment.payrollGroup", "Lohnverrechnungsgruppe", sensitive.employment.payrollGroup, mode("employment.payrollGroup"), 'maxlength="120"')}
        ${personnelRecordArea("employmentNotes", "employment.notes", "Interne Hinweise", sensitive.employment.notes, mode("employment.notes"))}
      </div>`);

    const reportEntries = (result.reports || []).map((report) => {
      const documents = (report.documents || []).map((document) => result.canOpenFiles
        ? `<a class="secondary-button compact-button" href="/api/portal/v1/amu-reports/${report.id}/documents/${encodeURIComponent(document.id)}/content" target="_blank" rel="noopener">${escapeHtml(document.original_name || "Dokument")} öffnen</a>`
        : `<span class="status-badge inactive">${escapeHtml(document.original_name || "Dokument")} · kein Dateizugriff</span>`).join("");
      return `<article class="personnel-record-entry"><div><strong>${formatAmuPeriod(report)}</strong><small>${escapeHtml(report.location_name || "")}${report.department_name ? ` · ${escapeHtml(report.department_name)}` : ""} · ${escapeHtml(amuReportStatusLabel(report))}</small>${report.employee_note ? `<p>${escapeHtml(report.employee_note)}</p>` : ""}</div><div class="amu-document-links">${documents || "Kein aktives Dokument"}</div></article>`;
    }).join("");
    const amuSection = access.canReadAmu ? personnelRecordDetails("Arbeitsunfähigkeitsmeldungen", "AUM · Dokumente & Verlauf", false,
      `<div class="personnel-record-report-list">${reportEntries || '<p class="settings-note">Noch keine Arbeitsunfähigkeitsmeldungen im Personalakt.</p>'}</div>`) : "";
    const documentSection = renderPersonnelDocuments(employeeNumber, result, access);
    elements.personnelRecordContent.innerHTML = `${contactSection}${identitySection}${emergencySection}${protectedSection}${employmentSection}${documentSection}${amuSection}`
      || '<p class="settings-note">Für diesen Personalakt sind keine Bereiche freigegeben.</p>';
    state.personnelRecordDirtyFields.clear();
    const canWriteFormField = mode("phone") === "write" || PERSONNEL_RECORD_FORM_FIELDS.some(([, fieldKey]) => mode(fieldKey) === "write");
    elements.savePersonnelRecordButton.classList.toggle("hidden", !canWriteFormField);
  } catch (error) {
    if (!elements.personnelRecordModal.open || state.personnelRecordRequestToken !== requestToken) return;
    state.personnelRecord = null;
    elements.personnelRecordContent.innerHTML = `<p class="settings-note">${escapeHtml(error.message)}</p>`;
  }
}

async function savePersonnelRecord(event) {
  event.preventDefault();
  const current = state.personnelRecord;
  if (!current) return;
  const access = current.result?.access || {};
  const fields = elements.personnelRecordForm.elements;
  const value = (name) => String(fields.namedItem(name)?.value || "").trim();
  const mode = (key) => personnelRecordAccessMode(access, key);
  const setNestedValue = (target, path, fieldValue) => {
    let cursor = target;
    path.forEach((part, index) => {
      if (index === path.length - 1) cursor[part] = fieldValue;
      else cursor = cursor[part] ||= {};
    });
  };
  const body = {};
  if (state.personnelRecordDirtyFields.has("phone") && mode("phone") === "write" && fields.namedItem("personnelPhone")) body.phone = value("personnelPhone");
  const sensitivePatch = {};
  PERSONNEL_RECORD_FORM_FIELDS.forEach(([inputName, fieldKey, path]) => {
    if (state.personnelRecordDirtyFields.has(fieldKey) && mode(fieldKey) === "write" && fields.namedItem(inputName)) {
      setNestedValue(sensitivePatch, path, value(inputName));
    }
  });
  if (Object.keys(sensitivePatch).length) body.sensitive = sensitivePatch;
  if (!Object.keys(body).length) return showToast("Es wurden keine bearbeitbaren Felder geändert.");
  elements.savePersonnelRecordButton.disabled = true;
  elements.personnelRecordMessage.classList.add("hidden");
  try {
    const result = await api(`/api/portal/v1/personnel-records/${encodeURIComponent(current.employeeNumber)}`, { method: "PUT", body: JSON.stringify(body) });
    showToast(result.changedFields?.length ? "Der Personalakt wurde verschlüsselt gespeichert." : "Es waren keine Änderungen zu speichern.");
    await openPersonnelRecord(current.employeeNumber);
  } catch (error) {
    elements.personnelRecordMessage.textContent = error.message;
    elements.personnelRecordMessage.classList.remove("hidden");
  } finally {
    elements.savePersonnelRecordButton.disabled = false;
  }
}

async function uploadPersonnelDocument() {
  const current = state.personnelRecord;
  if (!current) return;
  const fields = elements.personnelRecordForm.elements;
  const file = fields.namedItem("personnelDocumentFile")?.files?.[0];
  const title = String(fields.namedItem("personnelDocumentTitle")?.value || "").trim();
  if (!file) return showToast("Bitte ein PDF oder Bild auswählen.", true);
  if (!title) return showToast("Bitte einen Dokumenttitel eingeben.", true);
  if (file.size > 15 * 1024 * 1024) return showToast("Die Datei darf höchstens 15 MB groß sein.", true);
  const button = elements.personnelRecordContent.querySelector("[data-upload-personnel-document]");
  const formData = new FormData();
  formData.append("category", String(fields.namedItem("personnelDocumentCategory")?.value || "other"));
  formData.append("title", title);
  formData.append("documentDate", String(fields.namedItem("personnelDocumentDate")?.value || ""));
  formData.append("description", String(fields.namedItem("personnelDocumentDescription")?.value || "").trim());
  formData.append("document", file, file.name);
  if (button) button.disabled = true;
  try {
    const response = await rawApi(`/api/portal/v1/personnel-records/${encodeURIComponent(current.employeeNumber)}/documents`, { method: "POST", body: formData });
    await response.json().catch(() => ({}));
    showToast("Das Dokument wurde geschützt gespeichert.");
    await openPersonnelRecord(current.employeeNumber);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

async function deletePersonnelDocument(documentId) {
  const current = state.personnelRecord;
  if (!current || !documentId || !confirm("Dieses Personalakt-Dokument wirklich löschen?")) return;
  try {
    await api(`/api/portal/v1/personnel-records/${encodeURIComponent(current.employeeNumber)}/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
    showToast("Das Dokument wurde gelöscht.");
    await openPersonnelRecord(current.employeeNumber);
  } catch (error) {
    showToast(error.message, true);
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

function amuReportStatusLabel(report) {
  return report?.review_mode === "automatic"
    ? "Automatisch geprüft und zugeordnet"
    : requestStatusLabels[report?.status] || report?.status || "";
}

function renderRequestNavigation() {
  const counts = state.requestCounts;
  const sicknessEnabled = state.portalStatus?.installationFeatures?.sicknessAmu !== false;
  const amuAvailable = sicknessEnabled && state.amuAccess?.available !== false;
  document.querySelectorAll('[data-request-kind-tab="amu"]').forEach((button) => button.classList.toggle("hidden", !amuAvailable));
  if (!amuAvailable && state.requestKindTab === "amu") state.requestKindTab = "vacation";
  document.querySelectorAll("[data-request-kind-tab]").forEach((button) => button.classList.toggle("active", button.dataset.requestKindTab === state.requestKindTab));
  elements.requestsNavCount.textContent = counts.total;
  elements.requestsNavCount.classList.toggle("hidden", !counts.total);
  elements.requestsNavButton.classList.toggle("attention", counts.total > 0);
  elements.vacationRequestCount.textContent = counts.vacation;
  elements.timeOffRequestCount.textContent = counts.timeOff;
  elements.amuRequestCount.textContent = amuAvailable ? counts.amu || 0 : 0;
  elements.requestWorkflowSummary.innerHTML = `
    <article><span>Urlaub offen</span><strong>${counts.vacation}</strong></article>
    <article><span>ZA offen</span><strong>${counts.timeOff}</strong></article>
    ${amuAvailable ? `<article><span>AUM neu</span><strong>${counts.amu || 0}</strong></article>` : ""}
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
    const canReview = !state.portalStatus?.portalEnabled || state.amuCanReview === true;
    elements.managerVacationRequestList.innerHTML = reports.length ? reports.map((report) => {
      const files = (report.documents || []).map((document) => canOpenFiles
        ? `<a href="/api/portal/v1/amu-reports/${report.id}/documents/${encodeURIComponent(document.id)}/content" target="_blank" rel="noopener">${escapeHtml(document.original_name || "Dokument")} · ${Math.max(1, Math.round(Number(document.size || 0) / 1024))} KB</a>`
        : `<span>${escapeHtml(document.original_name || "Dokument")} · ${Math.max(1, Math.round(Number(document.size || 0) / 1024))} KB</span>`).join("");
      const responsibility = report.responsibility || {};
      const reportCanReview = canReview && responsibility.can_review !== false;
      return `<article class="manager-request-row amu-request-row" data-amu-report="${report.id}">
        <span class="employee-dot" style="--employee-color:${escapeHtml(report.color || "#507267")}"></span>
        <div><strong><span class="request-kind-badge amu">AUM</span> ${escapeHtml(report.employee_number)} · ${escapeHtml(report.nickname || report.full_name)}</strong><small>${formatAmuPeriod(report)} · ${escapeHtml(report.location_name || "")}${report.employee_note ? ` · ${escapeHtml(report.employee_note)}` : ""}</small><small><span class="request-status ${escapeHtml(report.status)}">${escapeHtml(amuReportStatusLabel(report))}</span>${responsibility.label ? ` · zuständig: ${escapeHtml(responsibility.label)}` : ""}${report.reviewed_by && report.review_mode !== "automatic" ? ` · geprüft von ${escapeHtml(report.reviewed_by)}` : ""}${report.review_note ? ` · ${escapeHtml(report.review_note)}` : ""}</small><div class="amu-document-links">${files}</div></div>
        ${reportCanReview && ["submitted", "returned"].includes(report.status) ? '<button class="secondary-button" data-open-amu-action type="button">AUM bearbeiten</button>' : ""}
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
  elements.requestActionSummary.textContent = `${report.employee_number} · ${report.nickname || report.full_name} · ${formatAmuPeriod(report)}`;
  elements.requestActionNote.value = "";
  elements.requestEditFields.classList.add("hidden");
  elements.requestActionHistory.innerHTML = report.reviewed_by
    ? `<div><strong>${report.review_mode === "automatic" ? "Grabenplaner-Automatik" : escapeHtml(report.reviewed_by)} · ${escapeHtml(amuReportStatusLabel(report))}</strong><span>${report.reviewed_at ? escapeHtml(new Date(report.reviewed_at).toLocaleString("de-AT")) : ""}${report.review_note ? ` · ${escapeHtml(report.review_note)}` : ""}</span></div>`
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
    state.centralVacationLoadedYear = null;
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
  const canImport = hasIntegrationPermission("employees:import");
  const render = (profiles, target, emptyText) => {
    if (!target) return;
    target.innerHTML = profiles.length ? profiles.map((profile) => {
      const connection = integrationConnections().find((item) => item.id === profile.configuration?.connectionId);
      const source = profile.direction === "import"
        ? profile.configuration?.sourceType === "sql"
          ? `SQL-View · ${connection?.name || "Quelle nicht verfügbar"}`
          : `${profile.format.toUpperCase()}-Datei`
        : `${profile.format.toUpperCase()} · ${profile.configuration?.layout === "movement_lines" ? "Lohnarten" : "Tagesjournal"}`;
      return `
      <div class="integration-profile-row" data-integration-profile="${escapeHtml(profile.id)}">
        <div class="integration-profile-copy"><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(source)}</small></div>
        <div class="integration-profile-actions">
          ${profile.direction === "import" && canImport ? `<button class="secondary-button compact-button" type="button" data-use-integration-profile="${escapeHtml(profile.id)}">Verwenden</button>` : ""}
          ${canWrite ? `<button class="icon-button" type="button" data-delete-integration-profile="${escapeHtml(profile.id)}" aria-label="Profil l\u00f6schen">\u00d7</button>` : ""}
        </div>
      </div>
    `; }).join("") : `<p class="settings-note">${escapeHtml(emptyText)}</p>`;
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

function integrationConnections(kind = "") {
  return (state.integrations.connections || []).filter((connection) => (!kind || connection.kind === kind));
}

function canConfigureIntegrationConnections() {
  return hasIntegrationPermission("integrations:connections:write");
}

function canReplaceIntegrationCredentials() {
  return hasIntegrationPermission("integrations:credentials:write");
}

function canDeliverPayroll() {
  return hasIntegrationPermission("payroll:deliver");
}

function integrationConnectionKindLabel(kind) {
  return kind === "personnel_sql_source" ? "SQL-Personalquelle" : kind === "payroll_https_target" ? "HTTPS-Lohnziel" : "Verbindung";
}

function integrationConnectionStatus(connection) {
  if (connection.active === false || connection.status === "disabled") return { label: "Inaktiv", className: "inactive" };
  if (connection.status === "ready") return { label: "Bereit", className: "" };
  if (connection.status === "error") return { label: "Prüfen", className: "warning" };
  return { label: "Ungeprüft", className: "inactive" };
}

function connectionPublicSummary(connection) {
  const configuration = connection.configuration || {};
  if (connection.kind === "personnel_sql_source") {
    const source = [configuration.database, configuration.schemaName, configuration.objectName].filter(Boolean).join(" · ");
    return `${configuration.host || "SQL-Server"}${configuration.port ? `:${configuration.port}` : ""}${source ? ` · ${source}` : ""}`;
  }
  try { return new URL(configuration.endpoint).host; } catch { return "HTTPS-JSON-Ziel"; }
}

function renderIntegrationContracts() {
  if (!elements.integrationContractList) return;
  const contracts = state.integrations.contracts || [];
  elements.integrationContractList.innerHTML = contracts.length ? contracts.map((contract) => {
    const direction = contract.direction === "inbound" ? "Eingang" : "Ausgang";
    const transport = contract.transport === "mssql_view" ? "SQL-View · nur Lesen" : "HTTPS-JSON · dokumentierte API";
    const shortHash = String(contract.sha256 || "").slice(0, 12);
    return `<article class="integration-contract-row">
      <span class="integration-contract-mark" aria-hidden="true">${contract.direction === "inbound" ? "IN" : "OUT"}</span>
      <div><strong>${escapeHtml(contract.title)}</strong><small>${escapeHtml(direction)} · ${escapeHtml(transport)}</small><code>${escapeHtml(contract.id)} · v${escapeHtml(contract.version)}${shortHash ? ` · SHA-256 ${escapeHtml(shortHash)}…` : ""}</code></div>
      <button class="secondary-button compact-button" type="button" data-download-integration-contract="${escapeHtml(contract.id)}">JSON</button>
    </article>`;
  }).join("") : '<p class="settings-note">Keine Schnittstellenverträge verfügbar.</p>';
}

async function downloadIntegrationContract(id) {
  const response = await rawApi(`/api/integrations/contracts/${encodeURIComponent(id)}?download=1`);
  await downloadFileResponse(response, `${id}.json`);
}

function renderIntegrationConnections() {
  if (!elements.integrationConnectionList) return;
  const canConfigure = canConfigureIntegrationConnections();
  const connections = state.integrations.connections || [];
  const loadNotice = state.integrations.connectionLoadError
    ? `<div class="integration-alert error"><strong>Verbindungen nicht geladen</strong><span>${escapeHtml(state.integrations.connectionLoadError)}</span></div>`
    : state.integrations.connectionCatalog?.secretStoreAvailable === false
      ? '<div class="integration-alert error"><strong>Geschützter Schlüsselspeicher fehlt</strong><span>Verbindungen mit Zugangsdaten können erst nach der Serverkonfiguration verwendet werden.</span></div>' : "";
  const rows = connections.length ? connections.map((connection) => {
    const status = integrationConnectionStatus(connection);
    const tested = connection.lastTestedAt ? `Zuletzt geprüft ${new Date(connection.lastTestedAt).toLocaleString("de-AT")}` : "Noch nicht geprüft";
    const credentials = connection.configuration?.authenticationType === "none"
      ? "Keine Anmeldung erforderlich"
      : connection.credentialsConfigured ? "Zugangsdaten geschützt hinterlegt" : "Zugangsdaten fehlen";
    return `<article class="integration-connection-row" data-integration-connection="${escapeHtml(connection.id)}">
      <span class="integration-connection-mark" aria-hidden="true">${connection.kind === "personnel_sql_source" ? "SQL" : "API"}</span>
      <div class="integration-connection-copy"><div><strong>${escapeHtml(connection.name)}</strong><span class="status-badge ${status.className}">${escapeHtml(status.label)}</span></div><small>${escapeHtml(integrationConnectionKindLabel(connection.kind))} · ${escapeHtml(connectionPublicSummary(connection))}</small><small>${escapeHtml(credentials)} · ${escapeHtml(tested)}</small><small>Vertrag ${escapeHtml(connection.configuration?.contractId || "nicht gebunden")}</small></div>
      <div class="integration-connection-actions">
        ${canConfigure && connection.active !== false ? `<button class="secondary-button compact-button" type="button" data-test-integration-connection="${escapeHtml(connection.id)}">Testen</button>` : ""}
        ${canConfigure ? `<button class="secondary-button compact-button" type="button" data-edit-integration-connection="${escapeHtml(connection.id)}">Bearbeiten</button>` : ""}
      </div>
    </article>`;
  }).join("") : '<p class="settings-note">Noch keine direkte Verbindung eingerichtet.</p>';
  elements.integrationConnectionList.innerHTML = `${loadNotice}${rows}`;
  renderIntegrationConnectionSelections();
}

function renderIntegrationConnectionSelections() {
  const sqlConnections = integrationConnections("personnel_sql_source")
    .filter((connection) => connection.active !== false && connection.status === "ready" && connection.credentialsConfigured);
  const apiTargets = integrationConnections("payroll_https_target")
    .filter((connection) => connection.active !== false && connection.status === "ready"
      && (connection.configuration?.authenticationType === "none" || connection.credentialsConfigured));
  if (elements.personnelImportSqlConnection) {
    const selected = elements.personnelImportSqlConnection.value;
    elements.personnelImportSqlConnection.innerHTML = `<option value="">Geprüfte Verbindung auswählen</option>${sqlConnections.map((connection) => `<option value="${escapeHtml(connection.id)}">${escapeHtml(connection.name)}</option>`).join("")}`;
    if (sqlConnections.some((connection) => connection.id === selected)) elements.personnelImportSqlConnection.value = selected;
  }
  if (elements.payrollApiTarget) {
    const selected = elements.payrollApiTarget.value;
    elements.payrollApiTarget.innerHTML = `<option value="">Keine direkte Übertragung</option>${apiTargets.map((connection) => `<option value="${escapeHtml(connection.id)}">${escapeHtml(connection.name)}</option>`).join("")}`;
    if (apiTargets.some((connection) => connection.id === selected)) elements.payrollApiTarget.value = selected;
  }
}

function renderIntegrationDeliveries() {
  if (!elements.integrationDeliveryHistory) return;
  if (state.integrations.deliveryLoadError) {
    elements.integrationDeliveryHistory.innerHTML = `<div class="integration-alert error"><strong>Lieferverlauf nicht geladen</strong><span>${escapeHtml(state.integrations.deliveryLoadError)}</span></div>`;
    return;
  }
  const deliveries = state.integrations.deliveries || [];
  elements.integrationDeliveryHistory.innerHTML = deliveries.length ? deliveries.map((delivery) => {
    const status = delivery.status === "delivered" || delivery.status === "completed" || delivery.status === "success"
      ? { label: "Übertragen", className: "" } : { label: delivery.status === "pending" ? "Wird übertragen" : "Fehlgeschlagen", className: delivery.status === "pending" ? "inactive" : "warning" };
    const connection = integrationConnections().find((item) => item.id === delivery.connectionId);
    const timestamp = delivery.completedAt || delivery.createdAt || delivery.startedAt;
    const rows = Number(delivery.rowCount ?? delivery.totalCount ?? 0);
    const remote = delivery.remoteStatus || delivery.remoteStatusCode || delivery.httpStatus || "";
    return `<div class="integration-delivery-row"><span class="status-badge ${status.className}">${escapeHtml(status.label)}</span><div><strong>${escapeHtml(connection?.name || delivery.connectionName || "HTTPS-Lohnziel")}</strong><small>${rows ? `${rows} Zeilen · ` : ""}${remote ? `HTTP ${escapeHtml(remote)} · ` : ""}${timestamp ? new Date(timestamp).toLocaleString("de-AT") : ""}</small></div><code>${escapeHtml(String(delivery.id || "").slice(0, 12))}</code></div>`;
  }).join("") : '<p class="settings-note">Noch keine direkte Lohnübertragung protokolliert.</p>';
}

function setIntegrationConnectionMessage(message = "", error = false) {
  if (!elements.integrationConnectionMessage) return;
  elements.integrationConnectionMessage.textContent = message;
  elements.integrationConnectionMessage.classList.toggle("hidden", !message);
  elements.integrationConnectionMessage.classList.toggle("error", error);
}

function clearIntegrationCredentialInputs() {
  [elements.integrationCredentialUsername, elements.integrationCredentialPassword, elements.integrationCredentialToken,
    elements.integrationCredentialApiKey, elements.integrationCredentialBasicUsername, elements.integrationCredentialBasicPassword]
    .forEach((input) => { if (input) input.value = ""; });
}

function updateIntegrationConnectionForm() {
  const kind = elements.integrationConnectionKind.value;
  const isSql = kind === "personnel_sql_source";
  const editing = Boolean(state.integrations.editingConnectionId);
  const canConfigure = canConfigureIntegrationConnections();
  const canCredentials = canReplaceIntegrationCredentials();
  const currentConnection = (state.integrations.connections || []).find((connection) => connection.id === state.integrations.editingConnectionId);
  elements.integrationCredentialTitle.textContent = editing ? "Zugangsdaten ersetzen" : "Neue Zugangsdaten";
  elements.integrationSqlFields.classList.toggle("hidden", !isSql);
  elements.integrationApiFields.classList.toggle("hidden", isSql);
  elements.integrationSqlCredentials.classList.toggle("hidden", !isSql);
  elements.integrationApiCredentials.classList.toggle("hidden", isSql);
  elements.integrationConnectionKind.disabled = editing || !canConfigure;
  elements.integrationConnectionForm.querySelectorAll(".integration-connection-fields input,.integration-connection-fields select,.integration-connection-fields textarea,.integration-scope-details select,#integrationConnectionName,#integrationConnectionActive")
    .forEach((field) => { field.disabled = !canConfigure; });
  if (editing && !canCredentials && !isSql) elements.integrationApiAuthentication.disabled = true;
  elements.integrationCredentialPanel.classList.toggle("hidden", !canCredentials);
  const auth = elements.integrationApiAuthentication.value;
  elements.integrationApiKeyHeaderField.classList.toggle("hidden", isSql || auth !== "api_key");
  elements.integrationBearerTokenField.classList.toggle("hidden", isSql || auth !== "bearer");
  elements.integrationApiKeyField.classList.toggle("hidden", isSql || auth !== "api_key");
  elements.integrationBasicUsernameField.classList.toggle("hidden", isSql || auth !== "basic");
  elements.integrationBasicPasswordField.classList.toggle("hidden", isSql || auth !== "basic");
  elements.integrationCredentialStatus.textContent = editing
    ? ((state.integrations.connections || []).find((connection) => connection.id === state.integrations.editingConnectionId)?.credentialsConfigured
      ? "Zugangsdaten sind geschützt hinterlegt. Leere Felder lassen sie unverändert."
      : auth === "none" ? "Für diese Verbindung ist keine Anmeldung erforderlich." : "Noch keine Zugangsdaten hinterlegt.")
    : (auth === "none" && !isSql ? "Für diese Verbindung ist keine Anmeldung erforderlich." : "Bitte neue Zugangsdaten eingeben.");
  elements.testIntegrationConnectionButton.classList.toggle("hidden", !editing || !canConfigure || currentConnection?.active === false);
  elements.deleteIntegrationConnectionButton.classList.toggle("hidden", !editing || !canConfigure || currentConnection?.active === false);
  elements.saveIntegrationConnectionButton.classList.toggle("hidden", !canConfigure);
}

function resetIntegrationConnectionForm() {
  state.integrations.editingConnectionId = "";
  elements.integrationConnectionForm.reset();
  elements.integrationConnectionId.value = "";
  elements.integrationConnectionKind.value = "personnel_sql_source";
  elements.integrationConnectionActive.checked = true;
  elements.integrationSqlPort.value = "1433";
  elements.integrationSqlSchema.value = "dbo";
  elements.integrationSqlTls.value = "verify_full";
  elements.integrationSqlTimeout.value = "10000";
  elements.integrationSqlRowLimit.value = "1000";
  elements.integrationApiAuthentication.value = "none";
  elements.integrationApiKeyHeader.value = "X-API-Key";
  elements.integrationApiTimeout.value = "10000";
  elements.integrationApiRequestLimit.value = "5242880";
  elements.integrationApiResponseLimit.value = "262144";
  clearIntegrationCredentialInputs();
  setIntegrationConnectionMessage();
}

function populateIntegrationConnectionScope(scope = {}) {
  const locationIds = new Set((scope.locationIds || []).map(String));
  const departmentIds = new Set((scope.departmentIds || []).map(String));
  elements.integrationConnectionScopeLocations.innerHTML = state.locations.filter((location) => location.active !== false)
    .map((location) => `<option value="${escapeHtml(location.id)}" ${locationIds.has(String(location.id)) ? "selected" : ""}>${escapeHtml(location.id)} · ${escapeHtml(location.name)}</option>`).join("");
  elements.integrationConnectionScopeDepartments.innerHTML = state.locations.flatMap((location) => (location.departments || [])
    .filter((department) => department.active !== false)
    .map((department) => `<option value="${escapeHtml(department.id)}" ${departmentIds.has(String(department.id)) ? "selected" : ""}>${escapeHtml(location.name)} · ${escapeHtml(department.name)}</option>`)).join("");
}

function openIntegrationConnection(connectionId = "") {
  resetIntegrationConnectionForm();
  const connection = (state.integrations.connections || []).find((item) => item.id === connectionId) || null;
  state.integrations.editingConnectionId = connection?.id || "";
  elements.integrationConnectionId.value = connection?.id || "";
  elements.integrationConnectionTitle.textContent = connection ? "Direkte Verbindung bearbeiten" : "Direkte Verbindung hinzufügen";
  if (connection) {
    const configuration = connection.configuration || {};
    elements.integrationConnectionKind.value = connection.kind;
    elements.integrationConnectionName.value = connection.name || "";
    elements.integrationConnectionActive.checked = connection.active !== false;
    if (connection.kind === "personnel_sql_source") {
      elements.integrationSqlHost.value = configuration.host || "";
      elements.integrationSqlPort.value = configuration.port || 1433;
      elements.integrationSqlDatabase.value = configuration.database || "";
      elements.integrationSqlInstance.value = configuration.instanceName || "";
      elements.integrationSqlSchema.value = configuration.schemaName || "dbo";
      elements.integrationSqlView.value = configuration.objectName || "";
      elements.integrationSqlAllowedColumns.value = (configuration.allowedColumns || []).join("\n");
      elements.integrationSqlTls.value = configuration.tlsMode || "verify_full";
      elements.integrationSqlTimeout.value = configuration.timeoutMs || 10000;
      elements.integrationSqlRowLimit.value = configuration.rowLimit || 1000;
    } else {
      elements.integrationApiEndpoint.value = configuration.endpoint || "";
      elements.integrationApiAuthentication.value = configuration.authenticationType || "none";
      elements.integrationApiKeyHeader.value = configuration.apiKeyHeader || "X-API-Key";
      elements.integrationApiTimeout.value = configuration.timeoutMs || 10000;
      elements.integrationApiRequestLimit.value = configuration.requestLimitBytes || 5242880;
      elements.integrationApiResponseLimit.value = configuration.responseLimitBytes || 262144;
    }
    populateIntegrationConnectionScope(configuration.scope || {});
  } else {
    populateIntegrationConnectionScope();
  }
  updateIntegrationConnectionForm();
  elements.integrationConnectionModal.showModal();
}

function integrationCredentialsForSubmission(kind, editing) {
  if (!canReplaceIntegrationCredentials()) return undefined;
  if (kind === "personnel_sql_source") {
    const username = elements.integrationCredentialUsername.value.trim();
    const password = elements.integrationCredentialPassword.value;
    return username || password || !editing ? { username, password } : undefined;
  }
  const auth = elements.integrationApiAuthentication.value;
  const existingAuth = integrationConnections().find((connection) => connection.id === state.integrations.editingConnectionId)?.configuration?.authenticationType;
  const authenticationChanged = editing && existingAuth !== auth;
  if (auth === "none") return {};
  if (auth === "bearer") {
    const token = elements.integrationCredentialToken.value;
    return token || !editing || authenticationChanged ? { token } : undefined;
  }
  if (auth === "api_key") {
    const apiKey = elements.integrationCredentialApiKey.value;
    return apiKey || !editing || authenticationChanged ? { apiKey } : undefined;
  }
  const username = elements.integrationCredentialBasicUsername.value.trim();
  const password = elements.integrationCredentialBasicPassword.value;
  return username || password || !editing || authenticationChanged ? { username, password } : undefined;
}

function integrationConnectionPayload() {
  const kind = elements.integrationConnectionKind.value;
  const editing = Boolean(state.integrations.editingConnectionId);
  const scope = {
    locationIds: [...elements.integrationConnectionScopeLocations.selectedOptions].map((option) => option.value),
    departmentIds: [...elements.integrationConnectionScopeDepartments.selectedOptions].map((option) => option.value),
  };
  const configuration = kind === "personnel_sql_source" ? {
    host: elements.integrationSqlHost.value.trim(),
    port: Number(elements.integrationSqlPort.value),
    database: elements.integrationSqlDatabase.value.trim(),
    instanceName: elements.integrationSqlInstance.value.trim(),
    schemaName: elements.integrationSqlSchema.value.trim(),
    objectName: elements.integrationSqlView.value.trim(),
    objectType: "view",
    allowedColumns: elements.integrationSqlAllowedColumns.value.split(/[\r\n,;]+/).map((entry) => entry.trim()).filter(Boolean),
    tlsMode: elements.integrationSqlTls.value,
    timeoutMs: Number(elements.integrationSqlTimeout.value),
    rowLimit: Number(elements.integrationSqlRowLimit.value),
    scope,
  } : {
    endpoint: elements.integrationApiEndpoint.value.trim(),
    method: "POST",
    authenticationType: elements.integrationApiAuthentication.value,
    apiKeyHeader: elements.integrationApiAuthentication.value === "api_key" ? elements.integrationApiKeyHeader.value.trim() : "",
    idempotencyHeader: "Idempotency-Key",
    timeoutMs: Number(elements.integrationApiTimeout.value),
    requestLimitBytes: Number(elements.integrationApiRequestLimit.value),
    responseLimitBytes: Number(elements.integrationApiResponseLimit.value),
    scope,
  };
  const credentials = integrationCredentialsForSubmission(kind, editing);
  return {
    kind,
    provider: kind === "personnel_sql_source" ? "mssql" : "generic_https_json",
    name: elements.integrationConnectionName.value.trim(),
    active: elements.integrationConnectionActive.checked,
    configuration,
    ...(credentials === undefined ? {} : { credentials }),
  };
}

async function saveIntegrationConnection(event) {
  event.preventDefault();
  const id = state.integrations.editingConnectionId;
  elements.saveIntegrationConnectionButton.disabled = true;
  setIntegrationConnectionMessage("Verbindung wird sicher gespeichert …");
  try {
    const result = await api(id ? `/api/integrations/connections/${encodeURIComponent(id)}` : "/api/integrations/connections", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(integrationConnectionPayload()),
    });
    clearIntegrationCredentialInputs();
    elements.integrationConnectionModal.close();
    await loadIntegrations();
    showToast(result?.connection?.credentialsConfigured || result?.credentialsConfigured ? "Verbindung und neue Zugangsdaten gespeichert." : "Verbindung gespeichert.");
  } catch (error) {
    clearIntegrationCredentialInputs();
    setIntegrationConnectionMessage(error.message, true);
  } finally {
    elements.saveIntegrationConnectionButton.disabled = false;
  }
}

async function testIntegrationConnection(id = state.integrations.editingConnectionId) {
  if (!id) return;
  const button = elements.integrationConnectionList?.querySelector(`[data-test-integration-connection="${CSS.escape(id)}"]`);
  if (button) button.disabled = true;
  if (elements.integrationConnectionModal.open) setIntegrationConnectionMessage("Verbindung wird geprüft …");
  try {
    const result = await api(`/api/integrations/connections/${encodeURIComponent(id)}/test`, { method: "POST", body: "{}" });
    if (elements.integrationConnectionModal.open) setIntegrationConnectionMessage(result?.message || "Verbindung erfolgreich geprüft.");
    showToast(result?.message || "Verbindung erfolgreich geprüft.");
    await loadIntegrations();
  } catch (error) {
    if (elements.integrationConnectionModal.open) setIntegrationConnectionMessage(error.message, true);
    else showToast(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function deleteIntegrationConnection(id = state.integrations.editingConnectionId) {
  const connection = integrationConnections().find((item) => item.id === id);
  if (!connection || !confirm(`Verbindung „${connection.name}“ wirklich löschen?`)) return;
  try {
    await api(`/api/integrations/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
    elements.integrationConnectionModal.close();
    await loadIntegrations();
    showToast("Verbindung gelöscht.");
  } catch (error) { setIntegrationConnectionMessage(error.message, true); }
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
  if (elements.payrollDeliverButton) elements.payrollDeliverButton.disabled = true;
}

function renderPayrollPreflight(result = null) {
  if (!elements.payrollPreflightResult) return;
  if (!result) {
    elements.payrollPreflightResult.innerHTML = `<p class="settings-note">Vor dem Download werden Datenqualit\u00e4t und Freigabestatus gepr\u00fcft.</p>`;
    elements.payrollDownloadButton.disabled = true;
    if (elements.payrollDeliverButton) elements.payrollDeliverButton.disabled = true;
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
  if (elements.payrollDeliverButton) {
    elements.payrollDeliverButton.disabled = !canDeliverPayroll() || !elements.payrollApiTarget?.value
      || !result.rowCount || (result.blockers?.length || 0) > 0;
  }
}

async function loadIntegrations() {
  const requests = [];
  const keys = [];
  state.integrations.connectionLoadError = "";
  state.integrations.deliveryLoadError = "";
  if (hasIntegrationPermission("employees:import")) { keys.push("importCatalog"); requests.push(api("/api/integrations/personnel-import/catalog")); }
  if (hasIntegrationPermission("payroll:export")) { keys.push("payrollCatalog"); requests.push(api("/api/integrations/payroll-export/catalog")); }
  if (hasIntegrationPermission("integrations:read")) {
    keys.push("profiles", "runs", "contracts");
    requests.push(
      api("/api/integrations/profiles").then((result) => result.profiles || []),
      api("/api/integrations/runs?limit=30").then((result) => result.runs || []),
      api("/api/integrations/contracts").then((result) => result.contracts || []),
    );
  }
  if (hasIntegrationPermission("integrations:connections:read") || hasIntegrationPermission("integrations:connections:write")) {
    keys.push("connectionCatalog", "connections");
    requests.push(
      api("/api/integrations/connections/catalog").catch((error) => {
        state.integrations.connectionLoadError = error.message;
        return null;
      }),
      api("/api/integrations/connections").then((result) => result.connections || result.items || []).catch((error) => {
        state.integrations.connectionLoadError = error.message;
        return [];
      }),
    );
  }
  if (hasIntegrationPermission("integrations:read")) {
    keys.push("deliveries");
    requests.push(api("/api/integrations/payroll-export/deliveries?limit=30").then((result) => result.deliveries || result.items || []).catch((error) => {
      state.integrations.deliveryLoadError = error.message;
      return [];
    }));
  }
  const values = await Promise.all(requests);
  keys.forEach((key, index) => { state.integrations[key] = values[index]; });
  const range = currentMonthRange();
  if (!elements.payrollDateFrom.value) elements.payrollDateFrom.value = range.from;
  if (!elements.payrollDateTo.value) elements.payrollDateTo.value = range.to;
  renderIntegrationProfileLists();
  renderIntegrationConnections();
  renderIntegrationContracts();
  renderIntegrationDeliveries();
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
  updatePersonnelImportDefaultDepartments();
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
  elements.personnelImportSourceType.value = "file";
  if (elements.personnelImportProfile) elements.personnelImportProfile.value = "";
  elements.personnelImportMapping.innerHTML = "";
  elements.personnelImportSummary.innerHTML = "";
  elements.personnelImportPreviewBody.innerHTML = "";
  elements.personnelImportPreviewHint.textContent = "";
  elements.applyPersonnelImportButton.disabled = true;
  setPersonnelImportMessage();
  setPersonnelImportStep("file");
  updatePersonnelImportSourceFields();
}

function resetPersonnelImportWizard() {
  void discardPersonnelImportSessions();
  clearPersonnelImportWizard();
}

function applyPersonnelImportProfile(profile) {
  const configuration = profile?.configuration || {};
  const defaults = configuration.defaults || {};
  if (profile && elements.personnelImportProfile) elements.personnelImportProfile.value = profile.id;
  elements.personnelImportSourceType.value = configuration.sourceType === "sql" ? "sql" : "file";
  if (configuration.connectionId && [...elements.personnelImportSqlConnection.options].some((option) => option.value === configuration.connectionId)) {
    elements.personnelImportSqlConnection.value = configuration.connectionId;
  }
  if (defaults.homeLocationId) elements.personnelImportDefaultLocation.value = defaults.homeLocationId;
  updatePersonnelImportDefaultDepartments(defaults.preferredDepartmentId || "");
  if (defaults.positionId) elements.personnelImportDefaultPosition.value = defaults.positionId;
  if (defaults.contractedHours !== undefined) elements.personnelImportDefaultHours.value = defaults.contractedHours;
  if (configuration.duplicateStrategy) elements.personnelImportDuplicateStrategy.value = configuration.duplicateStrategy;
  updatePersonnelImportSourceFields();
  if (configuration.sourceType === "sql" && configuration.connectionId && elements.personnelImportSqlConnection.value !== configuration.connectionId) {
    setPersonnelImportMessage("Die im Profil hinterlegte SQL-Personalquelle ist derzeit nicht geprüft oder nicht verfügbar.", true);
  }
}

async function openPersonnelImportWizard(profileId = "") {
  if (!state.integrations.importCatalog) await loadIntegrations();
  resetPersonnelImportWizard();
  populatePersonnelImportDefaults();
  renderIntegrationProfileLists();
  renderIntegrationConnectionSelections();
  const profile = integrationProfiles("import", "personnel").find((item) => item.id === profileId) || null;
  applyPersonnelImportProfile(profile);
  elements.personnelImportModal.showModal();
}

function updatePersonnelImportDefaultDepartments(preferredValue = elements.personnelImportDefaultDepartment?.value || "") {
  if (!elements.personnelImportDefaultDepartment) return;
  const locations = state.integrations.importCatalog?.references?.locations || [];
  const location = locations.find((item) => String(item.id) === String(elements.personnelImportDefaultLocation?.value));
  const departments = (location?.departments || []).filter((department) => department.active !== false);
  elements.personnelImportDefaultDepartment.innerHTML = `<option value="">Gesamter Standort</option>${departments
    .map((department) => `<option value="${escapeHtml(department.id)}">${escapeHtml(department.name)}</option>`).join("")}`;
  if (departments.some((department) => String(department.id) === String(preferredValue))) {
    elements.personnelImportDefaultDepartment.value = String(preferredValue);
  }
}

function updatePersonnelImportSourceFields() {
  const sql = elements.personnelImportSourceType?.value === "sql";
  elements.personnelImportFileField?.classList.toggle("hidden", sql);
  elements.personnelImportSqlConnectionField?.classList.toggle("hidden", !sql);
  if (elements.inspectPersonnelImportButton) elements.inspectPersonnelImportButton.textContent = sql ? "SQL-View prüfen" : "Datei prüfen";
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
  const sqlSource = elements.personnelImportSourceType.value === "sql";
  if (sqlSource) {
    const connectionId = elements.personnelImportSqlConnection.value;
    if (!connectionId) { setPersonnelImportMessage("Bitte zuerst eine SQL-Personalquelle auswählen.", true); return; }
    elements.inspectPersonnelImportButton.disabled = true;
    setPersonnelImportMessage("SQL-View wird begrenzt und schreibgeschützt gelesen …");
    try {
      const result = await api(`/api/integrations/connections/${encodeURIComponent(connectionId)}/sql/inspect`, {
        method: "POST",
        body: JSON.stringify({
          defaultLocationId: elements.personnelImportDefaultLocation.value,
          defaultDepartmentId: elements.personnelImportDefaultDepartment.value || "",
        }),
      });
      state.integrations.inspection = result.inspection || result;
      elements.personnelImportSheet.innerHTML = state.integrations.inspection.sheets.map((sheet) => `<option value="${escapeHtml(sheet.name)}">${escapeHtml(sheet.name)} · ${sheet.rowCount} Zeilen</option>`).join("");
      const sheet = selectedImportSheet();
      elements.personnelImportHeaderRow.value = sheet?.suggestedHeaderRow || 1;
      renderPersonnelImportMapping();
      setPersonnelImportStep("mapping");
      setPersonnelImportMessage(`SQL-View sicher gelesen · höchstens ${state.integrations.inspection.rowLimit || 5000} Zeilen bleiben nur für diese befristete Vorschau im Arbeitsspeicher.`);
    } catch (error) {
      setPersonnelImportMessage(error.message, true);
    } finally {
      elements.inspectPersonnelImportButton.disabled = false;
    }
    return;
  }
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
    version: 2,
    sourceType: elements.personnelImportSourceType.value,
    connectionId: elements.personnelImportSourceType.value === "sql" ? elements.personnelImportSqlConnection.value : "",
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
      preferredDepartmentId: elements.personnelImportDefaultDepartment.value || "",
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
        sourceType: configuration.sourceType,
        connectionId: configuration.connectionId || null,
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
  if (elements.payrollDeliverButton) elements.payrollDeliverButton.disabled = true;
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

async function deliverPayrollExport() {
  const preflight = state.integrations.payrollPreflight;
  const connectionId = elements.payrollApiTarget?.value || "";
  if (!preflight || !connectionId || preflight.blockers?.length || !preflight.rowCount || !canDeliverPayroll()) return;
  const target = integrationConnections("payroll_https_target").find((connection) => connection.id === connectionId);
  if (!target) { showToast("Bitte ein verfügbares HTTPS-Lohnziel auswählen.", true); return; }
  if (!confirm(`Die final geprüften Lohnverrechnungsdaten jetzt sicher an „${target.name}“ übertragen?`)) return;
  elements.payrollDeliverButton.disabled = true;
  try {
    const result = await api("/api/integrations/payroll-export/deliver", {
      method: "POST",
      body: JSON.stringify({
        connectionId,
        dateFrom: elements.payrollDateFrom.value,
        dateTo: elements.payrollDateTo.value,
        locationId: elements.payrollLocation.value,
        departmentId: elements.payrollDepartment.value || null,
        profileId: elements.payrollProfile.value || null,
        configuration: currentPayrollConfiguration(),
        fingerprint: preflight.fingerprint,
      }),
    });
    state.integrations.payrollPreflight = null;
    renderPayrollPreflight();
    await loadIntegrations();
    showToast(result?.message || "Lohnverrechnungsdaten wurden sicher übertragen.");
  } catch (error) {
    showToast(error.message, true);
    renderPayrollPreflight(state.integrations.payrollPreflight);
  }
}

function setView(view) {
  const features = state.portalStatus?.installationFeatures || {};
  if ((view === "vacations" && features.vacation === false)
    || (view === "requests" && features.requests === false)
    || (view === "timeTracking" && features.timeTracking === false)
    || (view === "personnelAdministration" && elements.personnelAdministrationNavButton?.classList.contains("hidden"))
    || (view === "rightsDashboard" && elements.rightsDashboardNavButton?.classList.contains("hidden"))) view = "planning";
  state.currentView = view;
  if (timePresenceRefreshTimer) clearInterval(timePresenceRefreshTimer);
  timePresenceRefreshTimer = null;
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  renderContextNavigation();
  elements.planningView.classList.toggle("active", view === "planning");
  elements.requestsView.classList.toggle("active", view === "requests");
  elements.timeTrackingView?.classList.toggle("active", view === "timeTracking");
  elements.vacationsView.classList.toggle("active", view === "vacations");
  elements.personnelAdministrationView?.classList.toggle("active", view === "personnelAdministration");
  elements.personnelView.classList.toggle("active", view === "personnel");
  elements.rightsDashboardView?.classList.toggle("active", view === "rightsDashboard");
  elements.settingsView.classList.toggle("active", view === "settings");
  applyActivePageAppearance();
  if (view === "settings") {
    const activeSettingsTab = document.querySelector("[data-settings-tab].active:not(.hidden)");
    const firstAllowedSettingsTab = document.querySelector("[data-settings-tab]:not(.hidden)");
    if (!activeSettingsTab && firstAllowedSettingsTab) setSettingsTab(firstAllowedSettingsTab.dataset.settingsTab);
  }
  if (view === "requests") loadManagerVacationRequests();
  if (view === "personnelAdministration") loadPersonnelAdministration();
  if (view === "rightsDashboard") loadRightsDashboard();
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
  if (!["planning", "requests", "timeTracking", "vacations", "personnelAdministration", "personnel", "rightsDashboard", "settings"].includes(requestedView)) return;
  if (requestedView === "requests") {
    const requestedKind = parameters.get("kind");
    if (["vacation", "time_off", "amu"].includes(requestedKind)) state.requestKindTab = requestedKind;
    document.querySelectorAll("[data-request-kind-tab]").forEach((button) => button.classList.toggle("active", button.dataset.requestKindTab === state.requestKindTab));
  }
  if (requestedView === "rightsDashboard") {
    const dashboardMode = parameters.get("dashboard");
    if (["locations", "rights", "processes"].includes(dashboardMode)) state.rightsDashboardMode = dashboardMode;
    const processId = parameters.get("process");
    if (processId) state.rightsDashboardSelectedProcessId = processId.slice(0, 120);
  }
  const contextChanged = restoreRememberedOverallContext(requestedView);
  setView(requestedView);
  if (contextChanged) loadAll();
}

function setSettingsTab(tab) {
  document.querySelectorAll("[data-settings-tab]").forEach((button) => button.classList.toggle("active", button.dataset.settingsTab === tab));
  document.querySelector(`[data-settings-tab="${tab}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  elements.generalSettings.classList.toggle("active", tab === "general");
  elements.brandingSettings.classList.toggle("active", tab === "branding");
  elements.pdfSettings.classList.toggle("active", tab === "pdf");
  elements.personnelSettings.classList.toggle("active", tab === "personnel");
  elements.vacationSettings?.classList.toggle("active", tab === "vacation");
  elements.timeTrackingSettings?.classList.toggle("active", tab === "timeTracking");
  elements.integrationSettings?.classList.toggle("active", tab === "integrations");
  elements.accessSettings.classList.toggle("active", tab === "access");
  elements.rightsSettings?.classList.toggle("active", tab === "rights");
  elements.backupSettings.classList.toggle("active", tab === "backup");
  elements.usbProvisioningSettings?.classList.toggle("active", tab === "usbProvisioning");
  const canSaveGeneralSettings = !state.portalStatus?.portalEnabled
    || state.portalSession?.user?.permissions?.includes("settings:write");
  const canSaveBackupSettings = !state.portalStatus?.portalEnabled
    || state.portalSession?.user?.permissions?.includes("backup:write");
  elements.saveSettingsButton?.classList.toggle("hidden", ["integrations", "usbProvisioning"].includes(tab)
    || (tab === "backup" ? !canSaveBackupSettings : !canSaveGeneralSettings));
  if (tab === "access") {
    loadPortalUsers();
    loadAmuSettings();
    loadAmuAccessPolicy();
    loadGreetingSettings();
  }
  if (tab === "vacation") {
    loadWorkflowSettings();
    loadApprovalDelegations();
  }
  if (tab === "rights") loadRightsManagement();
  if (tab === "integrations") loadIntegrations().catch((error) => showToast(error.message, true));
  if (tab === "timeTracking") loadWifiAutomationSettings();
  if (tab === "backup") refreshServerDiagnostics();
  if (tab === "personnel") loadTrustLevelSettings();
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
  if (employee && !employee.portal_access) return false;
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

function syncEmployeeSicknessAllowanceField() {
  const canManage = canManageWifiAutomationSettings();
  if (!elements.employeeSicknessWithoutAumField) return;
  elements.employeeSicknessWithoutAumField.classList.toggle("hidden", !canManage);
  if (!canManage) return;
  const trustA = elements.employeeTimeConfirmationLevel.value === "A";
  elements.employeeSicknessWithoutAumEnabled.disabled = state.employeeEditMode === "display" || !trustA;
  elements.employeeSicknessWithoutAumHint.textContent = trustA
    ? "Wirksam, sobald auch die Unternehmensregel aktiviert ist."
    : "Die Freigabe bleibt gespeichert, wird aber erst mit Vertrauensstufe A wirksam.";
}

function canWriteSensitivePersonnelRecord() {
  return !state.portalStatus?.portalEnabled
    || state.portalSession?.user?.permissions?.includes("personnel:sensitive:write");
}

function normalizeProtectedPersonnelRecord(profile = {}, { defaultCountry = false } = {}) {
  const sensitive = profile.sensitive && typeof profile.sensitive === "object" ? profile.sensitive : {};
  const identity = sensitive.identity && typeof sensitive.identity === "object" ? sensitive.identity : {};
  const emergencyContact = sensitive.emergencyContact && typeof sensitive.emergencyContact === "object"
    ? sensitive.emergencyContact : {};
  const address = sensitive.address && typeof sensitive.address === "object" ? sensitive.address : {};
  const employment = sensitive.employment && typeof sensitive.employment === "object" ? sensitive.employment : {};
  return {
    phone: String(profile.phone || ""),
    sensitive: {
      identity: {
        firstName: String(identity.firstName || ""),
        lastName: String(identity.lastName || ""),
        previousName: String(identity.previousName || ""),
        salutation: String(identity.salutation || ""),
        title: String(identity.title || ""),
        birthDate: String(identity.birthDate || ""),
        birthPlace: String(identity.birthPlace || ""),
        nationality: String(identity.nationality || ""),
      },
      alternatePhone: String(sensitive.alternatePhone || ""),
      privateEmail: String(sensitive.privateEmail || ""),
      emergencyContact: {
        name: String(emergencyContact.name || ""),
        relationship: String(emergencyContact.relationship || ""),
        phone: String(emergencyContact.phone || ""),
      },
      socialSecurityNumber: String(sensitive.socialSecurityNumber || ""),
      iban: String(sensitive.iban || ""),
      bic: String(sensitive.bic || ""),
      accountHolder: String(sensitive.accountHolder || ""),
      address: {
        street: String(address.street || ""),
        supplement: String(address.supplement || ""),
        postalCode: String(address.postalCode || ""),
        city: String(address.city || ""),
        state: String(address.state || ""),
        country: String(address.country ?? (defaultCountry ? "Österreich" : "")),
      },
      employment: {
        startDate: String(employment.startDate || ""),
        endDate: String(employment.endDate || ""),
        fixedTermEnd: String(employment.fixedTermEnd || ""),
        probationEnd: String(employment.probationEnd || ""),
        employmentType: String(employment.employmentType || ""),
        contractType: String(employment.contractType || ""),
        employmentStatus: String(employment.employmentStatus || ""),
        collectiveAgreement: String(employment.collectiveAgreement || ""),
        classification: String(employment.classification || ""),
        payrollGroup: String(employment.payrollGroup || ""),
        notes: String(employment.notes || ""),
      },
    },
  };
}

function employeeRecordControl(name) {
  return elements.employeeForm?.elements?.namedItem(name) || null;
}

function fillEmployeeProtectedRecord(profile = {}) {
  const record = normalizeProtectedPersonnelRecord(profile);
  const { sensitive } = record;
  const values = {
    employeeRecordPhone: record.phone,
    employeeRecordFirstName: sensitive.identity.firstName,
    employeeRecordLastName: sensitive.identity.lastName,
    employeeRecordPreviousName: sensitive.identity.previousName,
    employeeRecordSalutation: sensitive.identity.salutation,
    employeeRecordTitle: sensitive.identity.title,
    employeeRecordBirthDate: sensitive.identity.birthDate,
    employeeRecordBirthPlace: sensitive.identity.birthPlace,
    employeeRecordNationality: sensitive.identity.nationality,
    employeeRecordAlternatePhone: sensitive.alternatePhone,
    employeeRecordPrivateEmail: sensitive.privateEmail,
    employeeRecordEmergencyName: sensitive.emergencyContact.name,
    employeeRecordEmergencyRelationship: sensitive.emergencyContact.relationship,
    employeeRecordEmergencyPhone: sensitive.emergencyContact.phone,
    employeeRecordSocialSecurityNumber: sensitive.socialSecurityNumber,
    employeeRecordIban: sensitive.iban,
    employeeRecordBic: sensitive.bic,
    employeeRecordAccountHolder: sensitive.accountHolder,
    employeeRecordStreet: sensitive.address.street,
    employeeRecordAddressSupplement: sensitive.address.supplement,
    employeeRecordPostalCode: sensitive.address.postalCode,
    employeeRecordCity: sensitive.address.city,
    employeeRecordState: sensitive.address.state,
    employeeRecordCountry: sensitive.address.country,
    employeeRecordStartDate: sensitive.employment.startDate,
    employeeRecordEndDate: sensitive.employment.endDate,
    employeeRecordFixedTermEnd: sensitive.employment.fixedTermEnd,
    employeeRecordProbationEnd: sensitive.employment.probationEnd,
    employeeRecordEmploymentType: sensitive.employment.employmentType,
    employeeRecordContractType: sensitive.employment.contractType,
    employeeRecordEmploymentStatus: sensitive.employment.employmentStatus,
    employeeRecordCollectiveAgreement: sensitive.employment.collectiveAgreement,
    employeeRecordClassification: sensitive.employment.classification,
    employeeRecordPayrollGroup: sensitive.employment.payrollGroup,
    employeeRecordNotes: sensitive.employment.notes,
  };
  for (const [name, value] of Object.entries(values)) {
    const control = employeeRecordControl(name);
    if (control) control.value = value;
  }
}

function personnelRecordPatch(before = {}, after = {}) {
  const patch = {};
  for (const [key, nextValue] of Object.entries(after)) {
    const previousValue = before?.[key];
    if (nextValue && typeof nextValue === "object" && !Array.isArray(nextValue)) {
      const nested = personnelRecordPatch(previousValue && typeof previousValue === "object" ? previousValue : {}, nextValue);
      if (Object.keys(nested).length) patch[key] = nested;
    } else if (String(nextValue ?? "") !== String(previousValue ?? "")) {
      patch[key] = nextValue;
    }
  }
  return patch;
}

function clearEmployeeProtectedRecord() {
  state.employeePersonnelRecord = null;
  elements.employeeProtectedRecord?.querySelectorAll("input,textarea").forEach((control) => { control.value = ""; });
  if (elements.employeeProtectedRecord) elements.employeeProtectedRecord.open = false;
}

function clearPersonnelRecordDialog() {
  state.personnelRecordRequestToken = null;
  state.personnelRecord = null;
  state.personnelRecordDirtyFields.clear();
  if (elements.personnelRecordContent) elements.personnelRecordContent.replaceChildren();
  if (elements.personnelRecordMessage) elements.personnelRecordMessage.textContent = "";
}

function setEmployeeProtectedRecordDisabled(disabled) {
  elements.employeeProtectedRecord?.querySelectorAll("input,select,textarea").forEach((control) => {
    control.disabled = disabled;
  });
}

function collectEmployeeProtectedRecord() {
  const value = (name) => String(employeeRecordControl(name)?.value || "").trim();
  return {
    phone: value("employeeRecordPhone"),
    sensitive: {
      identity: {
        firstName: value("employeeRecordFirstName"),
        lastName: value("employeeRecordLastName"),
        previousName: value("employeeRecordPreviousName"),
        salutation: value("employeeRecordSalutation"),
        title: value("employeeRecordTitle"),
        birthDate: value("employeeRecordBirthDate"),
        birthPlace: value("employeeRecordBirthPlace"),
        nationality: value("employeeRecordNationality"),
      },
      alternatePhone: value("employeeRecordAlternatePhone"),
      privateEmail: value("employeeRecordPrivateEmail"),
      emergencyContact: {
        name: value("employeeRecordEmergencyName"),
        relationship: value("employeeRecordEmergencyRelationship"),
        phone: value("employeeRecordEmergencyPhone"),
      },
      socialSecurityNumber: value("employeeRecordSocialSecurityNumber"),
      iban: value("employeeRecordIban"),
      bic: value("employeeRecordBic"),
      accountHolder: value("employeeRecordAccountHolder"),
      address: {
        street: value("employeeRecordStreet"),
        supplement: value("employeeRecordAddressSupplement"),
        postalCode: value("employeeRecordPostalCode"),
        city: value("employeeRecordCity"),
        state: value("employeeRecordState"),
        country: value("employeeRecordCountry"),
      },
      employment: {
        startDate: value("employeeRecordStartDate"),
        endDate: value("employeeRecordEndDate"),
        fixedTermEnd: value("employeeRecordFixedTermEnd"),
        probationEnd: value("employeeRecordProbationEnd"),
        employmentType: value("employeeRecordEmploymentType"),
        contractType: value("employeeRecordContractType"),
        employmentStatus: value("employeeRecordEmploymentStatus"),
        collectiveAgreement: value("employeeRecordCollectiveAgreement"),
        classification: value("employeeRecordClassification"),
        payrollGroup: value("employeeRecordPayrollGroup"),
        notes: value("employeeRecordNotes"),
      },
    },
  };
}

async function loadEmployeeProtectedRecord(employeeNumber) {
  const requestedEmployee = String(employeeNumber || "");
  state.employeePersonnelRecord = { employeeNumber: requestedEmployee, loaded: false };
  setEmployeeProtectedRecordDisabled(true);
  if (elements.employeeProtectedRecordHint) elements.employeeProtectedRecordHint.textContent = "Geschützte Daten werden geladen …";
  try {
    const result = await api(`/api/portal/v1/personnel-records/${encodeURIComponent(requestedEmployee)}`);
    if (String(document.querySelector("#employeeNumber")?.value || "") !== requestedEmployee || !elements.employeeModal?.open) return;
    const initial = normalizeProtectedPersonnelRecord(result.profile || {});
    fillEmployeeProtectedRecord(initial);
    state.employeePersonnelRecord = { employeeNumber: requestedEmployee, loaded: true, initial };
    if (elements.employeeProtectedRecordHint) elements.employeeProtectedRecordHint.textContent = "Die Angaben werden verschlüsselt im Personalakt gespeichert.";
    setEmployeeProtectedRecordDisabled(false);
  } catch (error) {
    if (String(document.querySelector("#employeeNumber")?.value || "") !== requestedEmployee || !elements.employeeModal?.open) return;
    state.employeePersonnelRecord = { employeeNumber: requestedEmployee, loaded: false };
    if (elements.employeeProtectedRecordHint) elements.employeeProtectedRecordHint.textContent = `Personalakt konnte nicht geladen werden: ${error.message}`;
  }
}

function openEmployeeModal(employee = null) {
  const permissions = state.portalSession?.user?.permissions || [];
  const centralContext = state.currentView === "personnelAdministration";
  const fullAccess = !state.portalStatus?.portalEnabled
    || (centralContext ? canWriteCentralPersonnel() : permissions.includes("employees:write"));
  const displayAccess = Boolean(employee) && permissions.includes("employees:display:write");
  if (!fullAccess && !displayAccess) return;
  const centralPersonnelWrite = canWriteCentralPersonnel();
  state.employeeEditMode = fullAccess ? "full" : "display";
  elements.employeeForm.reset();
  state.employeePersonnelRecord = null;
  const employeeCostCenterId = employee?.cost_center_id ?? employee?.costCenterId ?? "";
  const availableCostCenters = state.costCenters.filter((center) => center.active || String(center.id) === String(employeeCostCenterId));
  if (employeeCostCenterId && !availableCostCenters.some((center) => String(center.id) === String(employeeCostCenterId))) {
    availableCostCenters.push(normalizeCostCenter({
      id: employeeCostCenterId,
      code: employee?.cost_center_code ?? employee?.costCenterCode ?? "",
      name: employee?.cost_center_name ?? employee?.costCenterName ?? "Bestehende Kostenstelle",
      active: false,
    }));
  }
  elements.employeeCostCenter.innerHTML = `<option value="">Bitte Kostenstelle auswählen</option>${availableCostCenters
    .sort((left, right) => left.code.localeCompare(right.code, "de-AT", { numeric: true }))
    .map((center) => `<option value="${escapeHtmlAttribute(String(center.id))}">${escapeHtml(`${center.code} · ${center.name}${center.active ? "" : " · inaktiv"}`)}</option>`).join("")}`;
  elements.employeeCostCenter.value = String(employeeCostCenterId || "");
  elements.employeeCostCenter.disabled = !centralPersonnelWrite;
  elements.employeeCostCenter.required = centralPersonnelWrite;
  elements.employeeCostCenterHint.textContent = centralPersonnelWrite
    ? "Eine Kostenstelle ist für jeden Personalstamm erforderlich."
    : "Die Kostenstelle kann ausschließlich in der zentralen Personalverwaltung geändert werden.";
  elements.employeeHomeLocation.innerHTML = `<option value="">Keine Stammfiliale</option>${(state.locations || []).map((location) =>
    `<option value="${escapeHtml(location.id)}">${escapeHtml(location.id)} · ${escapeHtml(location.name)}</option>`,
  ).join("")}`;
  elements.employeeHomeLocation.required = !centralPersonnelWrite;
  elements.employeeHomeLocationHint.textContent = centralPersonnelWrite
    ? "Für Verwaltung, Geschäftsleitung oder Produktion kann die Stammfiliale entfallen."
    : "Eine filiallose Zuordnung kann ausschließlich in der zentralen Personalverwaltung gespeichert werden.";
  document.querySelector("#employeeNumber").value = employee?.personnel_number || "";
  document.querySelector("#employeeNumber").disabled = Boolean(employee);
  document.querySelector("#employeeName").value = employee?.full_name || "";
  document.querySelector("#employeeNickname").value = employee?.nickname || "";
  document.querySelector("#employeeHours").value = employee?.contracted_hours ?? 38.5;
  elements.employeeTargetWorkdays.value = employee?.target_workdays_per_week ?? 5;
  elements.employeePosition.innerHTML = (state.positions || []).map((position) =>
    `<option value="${escapeHtml(position.id)}">${escapeHtml(position.name)}</option>`,
  ).join("");
  elements.employeePosition.value = employee?.position_id || "verkaufsmitarbeiter";
  const canManageConfirmationLevel = canManageWifiAutomationSettings();
  const canViewConfirmationLevel = canManageConfirmationLevel || Boolean(employee && "time_confirmation_level" in employee);
  elements.employeeTimeConfirmationLevel.value = employee?.time_confirmation_level || "C";
  elements.employeeSicknessWithoutAumEnabled.checked = employee?.sickness_without_aum_enabled === true;
  elements.employeeTimeConfirmationLevelField?.classList.toggle("hidden", !canViewConfirmationLevel);
  elements.employeeHomeLocation.value = employee
    ? String(employee.home_location_id ?? employee.homeLocationId ?? "")
    : centralPersonnelWrite ? "" : (state.locationId || state.locations?.[0]?.id || "");
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
  const canEditProtectedRecord = fullAccess && canWriteSensitivePersonnelRecord();
  elements.employeeProtectedRecord?.classList.toggle("hidden", !canEditProtectedRecord);
  if (elements.employeeProtectedRecord) elements.employeeProtectedRecord.open = false;
  elements.employeeProtectedRecord?.querySelectorAll("input,textarea").forEach((control) => {
    control.setAttribute("autocomplete", "off");
    control.setAttribute("data-1p-ignore", "true");
    control.setAttribute("data-lpignore", "true");
  });
  if (canEditProtectedRecord) {
    if (employee) loadEmployeeProtectedRecord(employee.personnel_number);
    else {
      const initial = normalizeProtectedPersonnelRecord({ sensitive: { address: { country: "Österreich" } } });
      fillEmployeeProtectedRecord(initial);
      state.employeePersonnelRecord = { employeeNumber: "", loaded: true, initial };
      setEmployeeProtectedRecordDisabled(false);
      if (elements.employeeProtectedRecordHint) elements.employeeProtectedRecordHint.textContent = "Die Angaben werden verschlüsselt gemeinsam mit dem neuen Teammitglied gespeichert.";
    }
  }
  const protectedControls = [
    "employeeName", "employeeNickname", "employeeHours", "employeeTargetWorkdays", "employeeCostCenter", "employeeHomeLocation", "employeePosition",
    "employeeTimeConfirmationLevel", "employeePreferredDepartment", "employeePreferredDay", "employeeActive",
  ];
  for (const id of protectedControls) document.querySelector(`#${id}`).disabled = displayOnly;
  elements.employeeCostCenter.disabled = displayOnly || !centralPersonnelWrite;
  elements.employeeTimeConfirmationLevel.disabled = displayOnly || !canManageConfirmationLevel;
  syncEmployeeSicknessAllowanceField();
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

function canUseAllEmployeesForShiftPlanning() {
  return !state.portalStatus?.portalEnabled
    || ["developer", "it_admin", "admin", "hr"].includes(state.portalSession?.user?.role);
}

function shiftEmployeeCandidates(selectedEmployeeNumber = "", shift = null) {
  const scopedEmployees = state.data?.employees || [];
  const source = canUseAllEmployeesForShiftPlanning() ? state.allEmployees : scopedEmployees;
  const selected = String(selectedEmployeeNumber || "");
  const candidates = source.filter((employee) => (
    employee.active !== false && employee.active !== 0 && employee.active !== "0"
  ) || String(employee.personnel_number) === selected);
  if (!candidates.some((employee) => String(employee.personnel_number) === selected)) {
    const existing = [...scopedEmployees, ...state.allEmployees]
      .find((employee) => String(employee.personnel_number) === selected);
    if (existing) candidates.push(existing);
    else if (selected) candidates.push({
      personnel_number: selected,
      nickname: shift?.nickname || shift?.full_name || selected,
      home_location_id: shift?.home_location_id || shift?.homeLocationId || "",
    });
  }
  return [...new Map(candidates.map((employee) => [employee.personnel_number, employee])).values()]
    .sort((left, right) => String(left.personnel_number).localeCompare(String(right.personnel_number), "de-AT", { numeric: true, sensitivity: "base" }));
}

function shiftEmployeeOptionLabel(employee) {
  const homeLocationId = String(employee.home_location_id || employee.homeLocationId || "");
  const homeLocation = employee.home_location_name || employee.homeLocationName
    || state.locations.find((location) => location.id === homeLocationId)?.name || homeLocationId;
  const externalHint = homeLocationId && homeLocationId !== state.locationId ? ` · Stammfiliale ${homeLocation}` : "";
  return `${employee.nickname || employee.full_name || employee.fullName || employee.personnel_number} · ${employee.personnel_number}${externalHint}`;
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
  const selectedEmployeeNumber = shift?.employee_number || employeeNumber;
  const candidates = shiftEmployeeCandidates(selectedEmployeeNumber, shift);
  const initialEmployee = candidates.find((employee) => employee.personnel_number === selectedEmployeeNumber);
  if (initialEmployee && !shift && !employeeCanWorkOnDate(initialEmployee, shift?.shift_date || date)) {
    showToast(`${initialEmployee.nickname} hat an diesem Wochentag keinen fix vereinbarten Arbeitstag.`, true);
    return;
  }
  document.querySelector("#shiftEmployee").innerHTML = candidates.map((employee) =>
    `<option value="${escapeHtmlAttribute(employee.personnel_number)}">${escapeHtml(shiftEmployeeOptionLabel(employee))}</option>`,
  ).join("");
  const departments = departmentsForLocation(state.locationId);
  elements.shiftDepartment.innerHTML = `<option value="">Keine / Allgemein</option>${departments.map((department) =>
    `<option value="${department.id}">${escapeHtml(department.name)}</option>`,
  ).join("")}`;
  elements.shiftForm.reset();
  document.querySelector("#shiftId").value = shift?.id || "";
  document.querySelector("#shiftEmployee").value = selectedEmployeeNumber;
  const selectedEmployee = candidates.find((employee) => employee.personnel_number === selectedEmployeeNumber);
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
  const centralPersonnelWrite = canWriteCentralPersonnel();
  if (centralPersonnelWrite && !elements.employeeCostCenter.value) {
    showToast("Bitte eine Kostenstelle auswählen.", true);
    elements.employeeCostCenter.focus();
    return;
  }
  if (!centralPersonnelWrite && !elements.employeeHomeLocation.value) {
    showToast("Eine filiallose Zuordnung kann ausschließlich in der zentralen Personalverwaltung gespeichert werden.", true);
    return;
  }
  const body = {
    personnelNumber: number,
    fullName: document.querySelector("#employeeName").value,
    nickname: document.querySelector("#employeeNickname").value,
    contractedHours: Number(document.querySelector("#employeeHours").value),
    targetWorkdaysPerWeek: Number(elements.employeeTargetWorkdays.value),
    positionId: elements.employeePosition.value,
    homeLocationId: elements.employeeHomeLocation.value,
    preferredDepartmentId: elements.employeePreferredDepartment.value,
    preferredDayOff: document.querySelector("#employeePreferredDay").value,
    fixedWorkdays: Array.from(document.querySelectorAll('[name="employeeFixedWorkday"]:checked')).map((input) => input.value),
    color: state.selectedColor,
    active: document.querySelector("#employeeActive").checked,
  };
  if (centralPersonnelWrite) body.costCenterId = elements.employeeCostCenter.value;
  if (canManageWifiAutomationSettings()) {
    body.timeConfirmationLevel = elements.employeeTimeConfirmationLevel.value;
    body.sicknessWithoutAumEnabled = elements.employeeSicknessWithoutAumEnabled.checked;
  }
  if (canWriteSensitivePersonnelRecord() && state.employeeEditMode === "full" && state.employeePersonnelRecord?.loaded) {
    const currentPersonnelRecord = collectEmployeeProtectedRecord();
    const recordPatch = personnelRecordPatch(state.employeePersonnelRecord.initial || {}, currentPersonnelRecord);
    if (!isEdit || Object.keys(recordPatch).length) body.personnelRecord = isEdit ? recordPatch : currentPersonnelRecord;
  }
  const editedEmployee = state.allEmployees.find((employee) => employee.personnel_number === number)
    || state.personnelDirectory.find((employee) => employee.personnel_number === number)
    || null;
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
    state.personnelAdministrationLoaded = false;
    showToast(isEdit ? "Teammitglied wurde aktualisiert." : "Teammitglied wurde angelegt.");
    await loadAll();
    if (state.currentView === "personnelAdministration") await loadPersonnelAdministration({ force: true });
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

async function ensureLocationCostCenters() {
  if (!canReadCostCenters() || state.costCenters.length) return;
  const payload = await api("/api/cost-centers?includeInactive=1");
  state.costCenters = apiList(payload, ["costCenters", "cost_centers", "items"]).map(normalizeCostCenter);
}

function populateLocationCostCenter(selectedId = "", fallbackLabel = "") {
  const canEdit = canWriteCostCenters();
  const activeCenters = state.costCenters
    .filter((center) => center.active || String(center.id) === String(selectedId))
    .sort((left, right) => left.code.localeCompare(right.code, "de-AT", { numeric: true, sensitivity: "base" }));
  elements.locationCostCenterField?.classList.toggle("hidden", !canEdit);
  elements.locationCostCenterReadonly?.classList.toggle("hidden", canEdit);
  if (elements.locationCostCenter) {
    elements.locationCostCenter.disabled = !canEdit;
    elements.locationCostCenter.innerHTML = `<option value="">Bitte Kostenstelle auswählen</option>${activeCenters.map((center) =>
      `<option value="${escapeHtmlAttribute(String(center.id))}">${escapeHtml([center.code, center.name].filter(Boolean).join(" · ") || "Kostenstelle")}${center.active ? "" : " · inaktiv"}</option>`,
    ).join("")}`;
    elements.locationCostCenter.value = activeCenters.some((center) => String(center.id) === String(selectedId)) ? String(selectedId) : "";
  }
  const selectedCenter = state.costCenters.find((center) => String(center.id) === String(selectedId));
  const readonlyLabel = elements.locationCostCenterReadonly?.querySelector("strong");
  if (readonlyLabel) readonlyLabel.textContent = selectedCenter
    ? [selectedCenter.code, selectedCenter.name].filter(Boolean).join(" · ")
    : fallbackLabel || "Noch nicht zugeordnet";
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
  const fallbackLocation = currentLocation();
  populateLocationCostCenter(fallbackLocation?.cost_center_id || fallbackLocation?.costCenterId || "",
    [fallbackLocation?.cost_center_code || fallbackLocation?.costCenterCode, fallbackLocation?.cost_center_name || fallbackLocation?.costCenterName].filter(Boolean).join(" · "));
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
  populateLocationCostCenter(location.cost_center_id || location.costCenterId || "",
    [location.cost_center_code || location.costCenterCode, location.cost_center_name || location.costCenterName].filter(Boolean).join(" · "));
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
    const costCenterSettings = canWriteCostCenters() ? { costCenterId: elements.locationCostCenter.value } : {};
    state.locations = await api(isEdit ? `/api/locations/${encodeURIComponent(id)}` : "/api/locations", {
      method: isEdit ? "PUT" : "POST",
      body: JSON.stringify({
        id,
        name: elements.locationName.value,
        minStaff: Number(elements.locationMinStaff.value || 0),
        active: elements.locationActive.checked,
        ...costCenterSettings,
        ...timeTrackingSettings,
        daySettings: readLocationDayFields(),
      }),
    });
    elements.locationEditorModal?.close();
    state.personnelAdministrationLoaded = false;
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
    locationId: state.locationId,
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
    showToast(paths.length > 1 ? "Sicherungen erstellt: intern und am zusätzlichen lokalen Ziel." : `Sicherung erstellt: ${paths[0] || backup.path}`);
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

async function saveBackupSettings() {
  try {
    await api("/api/backup/settings", {
      method: "PUT",
      body: JSON.stringify({
        externalBackupEnabled: document.querySelector("#externalBackupEnabled").checked,
        backupDirectory: document.querySelector("#backupDirectory").value,
        backupIntervalHours: Number(document.querySelector("#backupIntervalHours").value),
      }),
    });
    showToast("Backup-Einstellungen wurden gespeichert.");
    await Promise.all([loadAll(), loadSystemInfo()]);
    return true;
  } catch (error) {
    showToast(error.message, true);
    return false;
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
        rememberLastScheduleOverallPlan: elements.rememberLastScheduleOverallPlan.checked,
        rememberLastVacationOverallPlan: elements.rememberLastVacationOverallPlan.checked,
    };
    if (!portalEnabled || permissions.includes("operation_mode:write")) {
      payload.operationMode = state.desiredOperationMode || state.portalStatus?.operationMode || "local";
    }
    const result = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    if (elements.dashboardFontSize) {
      await saveDashboardFontSize(elements.dashboardFontSize.value, { silent: true });
    }
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
    state.personnelAdministrationLoaded = false;
    showToast("Teammitglied wurde gelöscht.");
    await loadAll();
    if (state.currentView === "personnelAdministration") await loadPersonnelAdministration({ force: true });
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

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => {
  const view = button.dataset.view;
  const contextChanged = restoreRememberedOverallContext(view);
  setView(view);
  if (contextChanged) loadAll();
}));
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
elements.serverAlertBanner?.addEventListener("click", () => {
  setView("settings");
  setSettingsTab("backup");
  elements.serverDiagnosticsCard?.scrollIntoView({ behavior: "smooth", block: "start" });
});
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
elements.saveAmuAccessPolicyButton?.addEventListener("click", saveAmuAccessPolicy);
elements.saveGreetingSettingsButton?.addEventListener("click", saveGreetingSettings);
elements.rightsEmployeeSearch?.addEventListener("input", renderRightsManagement);
elements.rightsUserList?.addEventListener("click", (event) => {
  const card = event.target.closest("[data-rights-user]");
  if (card && event.target.closest("[data-edit-user-rights]")) openRightsEditor(card.dataset.rightsUser);
});
elements.rightsEditorForm?.addEventListener("submit", saveUserRights);
elements.personnelFieldRightsRole?.addEventListener("change", (event) => {
  state.selectedPersonnelFieldRightsRole = event.target.value;
  renderPersonnelFieldRights();
});
elements.personnelFieldRightsMatrix?.addEventListener("change", (event) => {
  const select = event.target.closest("select[data-personnel-field-right]");
  if (!select) return;
  const role = state.selectedPersonnelFieldRightsRole;
  const matrix = state.personnelFieldRightsDrafts[role]
    ||= { ...(state.personnelFieldRights?.matrix?.[role] || {}) };
  matrix[select.dataset.personnelFieldRight] = select.value;
  state.personnelFieldRightsDirtyRoles.add(state.selectedPersonnelFieldRightsRole);
  const roleLabel = state.personnelFieldRights?.roles?.find((role) => role.id === state.selectedPersonnelFieldRightsRole)?.label || "diese Leitungsebene";
  if (elements.personnelFieldRightsHint) elements.personnelFieldRightsHint.textContent = `Ungespeicherte Änderungen für ${roleLabel}. Andere Leitungsebenen können trotzdem angesehen werden.`;
  const selectedOption = elements.personnelFieldRightsRole?.selectedOptions?.[0];
  if (selectedOption && !selectedOption.textContent.includes("nicht gespeichert")) selectedOption.textContent += " · nicht gespeichert";
  select.closest(".personnel-field-right-row")?.setAttribute("data-field-access-level", select.value);
  personnelFieldGroupSummary(select.closest(".personnel-field-rights-group"));
});
elements.savePersonnelFieldRightsButton?.addEventListener("click", savePersonnelFieldRights);
document.querySelectorAll("button[data-page-theme-choice]").forEach((button) => button.addEventListener("click", () => {
  const view = button.closest(".view")?.id?.replace(/View$/, "") || state.currentView;
  savePageTheme(view, button.dataset.pageThemeChoice);
}));
elements.dashboardFontSize?.addEventListener("change", () => applyDashboardFontSize(elements.dashboardFontSize.value));
document.querySelectorAll("button[data-rights-dashboard-mode]").forEach((button) => button.addEventListener("click", () => setRightsDashboardMode(button.dataset.rightsDashboardMode)));
elements.refreshLocationDashboard?.addEventListener("click", loadLocationDashboard);
elements.locationDashboardDate?.addEventListener("change", loadLocationDashboard);
elements.locationDashboardFilters?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-location-dashboard-filter]");
  if (!button) return;
  state.locationDashboardFilter = button.dataset.locationDashboardFilter || "all";
  renderLocationDashboard();
});
elements.locationDashboardGrid?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-location-dashboard-move]");
  const card = button?.closest("[data-location-dashboard-card]");
  if (!button || !card || button.disabled || !state.locationDashboard) return;
  const currentIndex = state.locationDashboard.locations.findIndex((location) => String(location.id) === card.dataset.locationDashboardCard);
  reorderLocationDashboardCard(card.dataset.locationDashboardCard, currentIndex + Number(button.dataset.locationDashboardMove || 0));
});
elements.locationDashboardGrid?.addEventListener("dragstart", (event) => {
  const card = event.target.closest("[data-location-dashboard-card]");
  if (!card) return;
  state.locationDashboardDraggingId = card.dataset.locationDashboardCard;
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.locationDashboardDraggingId);
});
elements.locationDashboardGrid?.addEventListener("dragover", (event) => {
  const card = event.target.closest("[data-location-dashboard-card]");
  if (!card || card.dataset.locationDashboardCard === state.locationDashboardDraggingId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  elements.locationDashboardGrid.querySelectorAll(".drag-target").forEach((item) => item.classList.remove("drag-target"));
  card.classList.add("drag-target");
});
elements.locationDashboardGrid?.addEventListener("drop", (event) => {
  const card = event.target.closest("[data-location-dashboard-card]");
  if (!card || !state.locationDashboardDraggingId || !state.locationDashboard) return;
  event.preventDefault();
  const draggedLocationId = state.locationDashboardDraggingId;
  state.locationDashboardDraggingId = "";
  const targetIndex = state.locationDashboard.locations.findIndex((location) => String(location.id) === card.dataset.locationDashboardCard);
  reorderLocationDashboardCard(draggedLocationId, targetIndex);
});
elements.locationDashboardGrid?.addEventListener("dragend", () => {
  state.locationDashboardDraggingId = "";
  elements.locationDashboardGrid.querySelectorAll(".dragging,.drag-target").forEach((item) => item.classList.remove("dragging", "drag-target"));
});
elements.rightsDashboardSearch?.addEventListener("input", renderRightsDashboard);
elements.rightsDashboardRoleFilter?.addEventListener("change", renderRightsDashboard);
elements.rightsDashboardLocationFilter?.addEventListener("change", () => {
  populateRightsDashboardDepartments();
  renderRightsDashboard();
});
elements.rightsDashboardDepartmentFilter?.addEventListener("change", renderRightsDashboard);
elements.rightsDashboardOriginFilter?.addEventListener("change", renderRightsDashboard);
elements.rightsDashboardUserList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-rights-dashboard-user]");
  if (!button) return;
  state.rightsDashboardSelectedEmployeeNumber = button.dataset.rightsDashboardUser;
  state.rightsDashboardSelectedPermissionId = "";
  renderRightsDashboard();
});
elements.rightsDashboardMatrix?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-rights-dashboard-permission]");
  if (!button) return;
  state.rightsDashboardSelectedPermissionId = button.dataset.rightsDashboardPermission;
  const selected = rightsDashboardFilteredUsers().find((user) => user.employeeNumber === state.rightsDashboardSelectedEmployeeNumber);
  if (selected) renderRightsDashboardSelection(selected);
});
elements.rightsProcessLocation?.addEventListener("change", () => {
  state.rightsProcessLocationId = elements.rightsProcessLocation.value;
  renderRightsProcessDashboard();
});
elements.rightsProcessScenario?.addEventListener("change", () => {
  state.rightsProcessScenarioIds[state.rightsDashboardSelectedProcessId] = elements.rightsProcessScenario.value;
  state.rightsDashboardSelectedProcessStepId = "";
  renderRightsProcessDashboard();
});
elements.rightsProcessExportPdf?.addEventListener("click", exportRightsProcessPdf);
elements.addCustomProcessButton?.addEventListener("click", () => openCustomProcessEditor());
elements.customProcessForm?.addEventListener("submit", saveCustomProcess);
elements.customProcessScopeType?.addEventListener("change", () => updateCustomProcessScopeFields());
elements.customProcessScopeLocation?.addEventListener("change", () => {
  populateCustomProcessDepartments();
  populateCustomProcessResponsibilityOptions();
});
elements.customProcessScopeDepartment?.addEventListener("change", populateCustomProcessResponsibilityOptions);
elements.customProcessTriggerType?.addEventListener("change", updateCustomProcessTriggerFields);
elements.addCustomProcessStepButton?.addEventListener("click", () => {
  syncCustomProcessStepsFromEditor();
  if (state.customProcessDraftSteps.length >= 30) return showToast("Ein eigener Prozess kann höchstens 30 Schritte enthalten.", true);
  state.customProcessDraftSteps.push(emptyCustomProcessStep());
  renderCustomProcessStepsEditor();
  elements.customProcessSteps.querySelector("[data-custom-process-step]:last-child input[data-custom-step-field=\"title\"]")?.focus();
});
elements.customProcessSteps?.addEventListener("click", (event) => {
  const card = event.target.closest("[data-custom-process-step]");
  if (!card) return;
  syncCustomProcessStepsFromEditor();
  const index = state.customProcessDraftSteps.findIndex((step) => step.id === card.dataset.customProcessStep);
  if (index < 0) return;
  const move = event.target.closest("[data-custom-step-move]");
  if (move) {
    const target = index + Number(move.dataset.customStepMove || 0);
    if (target >= 0 && target < state.customProcessDraftSteps.length) {
      const [step] = state.customProcessDraftSteps.splice(index, 1);
      state.customProcessDraftSteps.splice(target, 0, step);
      renderCustomProcessStepsEditor();
    }
    return;
  }
  if (event.target.closest("[data-custom-step-remove]")) {
    state.customProcessDraftSteps.splice(index, 1);
    renderCustomProcessStepsEditor();
  }
});
elements.customProcessSteps?.addEventListener("input", (event) => {
  const card = event.target.closest("[data-custom-process-step]");
  if (!card) return;
  if (event.target.matches('[data-custom-step-field="title"]')) card.querySelector("header strong").textContent = event.target.value || "Unbenannter Schritt";
  if (event.target.matches('[data-custom-step-field="description"]')) card.querySelector("header small").textContent = event.target.value || "Aufgabe und Zuständigkeit ergänzen";
});
elements.customProcessSteps?.addEventListener("change", (event) => {
  const card = event.target.closest("[data-custom-process-step]");
  if (!card) return;
  if (event.target.matches('[data-custom-step-field="responsibilityType"]')) {
    const field = card.querySelector("[data-custom-responsibility-reference]");
    const input = field.querySelector("input");
    const hidden = event.target.value === "system";
    field.classList.toggle("hidden", hidden);
    input.required = !hidden;
    input.placeholder = event.target.value === "employee" ? "Personalnummer" : "z. B. manager";
    const notificationDisabled = hidden || card.querySelector('[data-custom-step-field="conditionType"]')?.value !== "always";
    card.querySelectorAll("[data-custom-step-channel]").forEach((channel) => {
      channel.disabled = notificationDisabled;
      if (notificationDisabled) channel.checked = false;
    });
  }
  if (event.target.matches('[data-custom-step-field="conditionType"]')) {
    const field = card.querySelector("[data-custom-condition-text]");
    const input = field.querySelector("input");
    const hidden = event.target.value === "always";
    field.classList.toggle("hidden", hidden);
    input.required = event.target.value === "when";
    const disabled = event.target.value !== "always" || card.querySelector('[data-custom-step-field="responsibilityType"]')?.value === "system";
    card.querySelectorAll("[data-custom-step-channel]").forEach((channel) => {
      channel.disabled = disabled;
      if (disabled) channel.checked = false;
    });
  }
});
elements.rightsProcessValidationList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-rights-validation-process]");
  if (!button) return;
  state.rightsDashboardSelectedProcessId = button.dataset.rightsValidationProcess;
  state.rightsDashboardSelectedProcessStepId = button.dataset.rightsValidationStep || "";
  renderRightsProcessDashboard();
  elements.rightsProcessTitle?.scrollIntoView({ behavior: "smooth", block: "center" });
});
elements.rightsProcessList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-rights-process]");
  if (!button) return;
  state.rightsDashboardSelectedProcessId = button.dataset.rightsProcess;
  state.rightsDashboardSelectedProcessStepId = "";
  renderRightsProcessDashboard();
});
elements.rightsProcessTimeline?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-rights-process-step]");
  if (!button) return;
  state.rightsDashboardSelectedProcessStepId = button.dataset.rightsProcessStep;
  renderRightsProcessDashboard();
});
elements.rightsCustomProcessActions?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-custom-process-action]");
  if (!button || button.disabled) return;
  const process = (rightsProcessDashboard()?.processes || []).find((entry) => entry.id === state.rightsDashboardSelectedProcessId && entry.source === "custom");
  if (!process) return;
  if (button.dataset.customProcessAction === "edit") openCustomProcessEditor(process);
  if (button.dataset.customProcessAction === "status") changeCustomProcessStatus(process, button.dataset.customProcessStatus);
  if (button.dataset.customProcessAction === "archive") changeCustomProcessStatus(process, "archived");
  if (button.dataset.customProcessAction === "trigger") triggerCustomProcess(process);
});
elements.rightsProcessExplanation?.addEventListener("click", (event) => {
  const settingsButton = event.target.closest("[data-rights-process-settings-tab]");
  if (settingsButton) openRightsProcessSettings(settingsButton.dataset.rightsProcessSettingsTab);
  const permissionButton = event.target.closest("[data-rights-process-permission]");
  if (permissionButton) showRightsProcessPermission(permissionButton.dataset.rightsProcessPermission);
});
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
elements.personnelImportSourceType?.addEventListener("change", updatePersonnelImportSourceFields);
elements.personnelImportDefaultLocation?.addEventListener("change", () => updatePersonnelImportDefaultDepartments(""));
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
  applyPersonnelImportProfile(profile);
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
elements.addIntegrationConnectionButton?.addEventListener("click", () => openIntegrationConnection());
elements.integrationConnectionList?.addEventListener("click", (event) => {
  const edit = event.target.closest("[data-edit-integration-connection]");
  if (edit) { openIntegrationConnection(edit.dataset.editIntegrationConnection); return; }
  const test = event.target.closest("[data-test-integration-connection]");
  if (test) testIntegrationConnection(test.dataset.testIntegrationConnection).catch((error) => showToast(error.message, true));
});
elements.integrationConnectionForm?.addEventListener("submit", saveIntegrationConnection);
elements.integrationConnectionKind?.addEventListener("change", () => { clearIntegrationCredentialInputs(); updateIntegrationConnectionForm(); });
elements.integrationApiAuthentication?.addEventListener("change", () => { clearIntegrationCredentialInputs(); updateIntegrationConnectionForm(); });
elements.testIntegrationConnectionButton?.addEventListener("click", () => testIntegrationConnection().catch((error) => setIntegrationConnectionMessage(error.message, true)));
elements.deleteIntegrationConnectionButton?.addEventListener("click", () => deleteIntegrationConnection().catch((error) => setIntegrationConnectionMessage(error.message, true)));
elements.integrationConnectionModal?.addEventListener("close", () => { clearIntegrationCredentialInputs(); resetIntegrationConnectionForm(); });
elements.savePersonnelImportProfileButton?.addEventListener("click", () => saveIntegrationProfile("import").catch((error) => showToast(error.message, true)));
[elements.importProfileList, elements.exportProfileList].forEach((list) => list?.addEventListener("click", (event) => {
  const useButton = event.target.closest("[data-use-integration-profile]");
  if (useButton) {
    openPersonnelImportWizard(useButton.dataset.useIntegrationProfile).catch((error) => showToast(error.message, true));
    return;
  }
  const button = event.target.closest("[data-delete-integration-profile]");
  if (button) deleteIntegrationProfile(button.dataset.deleteIntegrationProfile).catch((error) => showToast(error.message, true));
}));
elements.integrationContractList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-download-integration-contract]");
  if (button) downloadIntegrationContract(button.dataset.downloadIntegrationContract).catch((error) => showToast(error.message, true));
});
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
elements.payrollApiTarget?.addEventListener("change", () => {
  state.integrations.payrollPreflight = null;
  renderPayrollPreflight();
});
elements.payrollPreflightButton?.addEventListener("click", preflightPayrollExport);
elements.payrollDownloadButton?.addEventListener("click", downloadPayrollExport);
elements.payrollDeliverButton?.addEventListener("click", deliverPayrollExport);
elements.savePayrollProfileButton?.addEventListener("click", () => saveIntegrationProfile("export").catch((error) => showToast(error.message, true)));
document.querySelectorAll("[data-settings-tab]").forEach((button) => button.addEventListener("click", () => setSettingsTab(button.dataset.settingsTab)));
elements.saveWifiAutomationSettingsButton?.addEventListener("click", saveWifiAutomationSettings);
elements.saveWifiLocationMappingsButton?.addEventListener("click", saveWifiLocationMappings);
elements.saveWifiConfirmationLevelsButton?.addEventListener("click", saveWifiConfirmationLevels);
elements.wifiConfirmationLevelSearch?.addEventListener("input", renderWifiConfirmationLevels);
elements.wifiConfirmationLevelList?.addEventListener("change", (event) => {
  const select = event.target.closest("[data-wifi-confirmation-level]");
  if (!select) return;
  const employee = (state.trustLevelSettings?.employees || [])
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
    const group = navigationGroups()[key];
    const children = group?.children;
    if (!children) return;
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
  rememberOverallContext(button.dataset.contextView, state.locationId, state.departmentId);
  setView(button.dataset.contextView);
  loadAll();
});
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => document.querySelector(`#${button.dataset.close}`).close()));
elements.employeeModal?.addEventListener("close", clearEmployeeProtectedRecord);
elements.personnelRecordModal?.addEventListener("close", clearPersonnelRecordDialog);
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
  const employeeNumber = document.querySelector("#shiftEmployee").value;
  const employee = [...(state.data?.employees || []), ...state.allEmployees]
    .find((item) => item.personnel_number === employeeNumber);
  const departmentId = String(employee?.preferred_department_id || employee?.preferredDepartmentId || "");
  if (departmentId && [...elements.shiftDepartment.options].some((option) => option.value === departmentId)) {
    elements.shiftDepartment.value = departmentId;
  }
});
document.querySelector("#addEmployeeButton").addEventListener("click", async () => {
  if (canWriteCentralPersonnel() && !state.personnelAdministrationLoaded) await loadPersonnelAdministration();
  openEmployeeModal();
});
elements.addCentralEmployeeButton?.addEventListener("click", () => openEmployeeModal());
document.querySelectorAll("[data-personnel-administration-tab]").forEach((button) => button.addEventListener("click", () => setPersonnelAdministrationTab(button.dataset.personnelAdministrationTab)));
document.querySelector(".personnel-administration-tabs")?.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...document.querySelectorAll("[data-personnel-administration-tab]:not(.hidden)")];
  if (!tabs.length) return;
  const currentIndex = Math.max(0, tabs.indexOf(document.activeElement));
  const targetIndex = event.key === "Home" ? 0
    : event.key === "End" ? tabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[targetIndex].focus();
  setPersonnelAdministrationTab(tabs[targetIndex].dataset.personnelAdministrationTab);
});
elements.personnelDirectorySearch?.addEventListener("input", (event) => {
  state.personnelDirectorySearch = event.target.value;
  renderPersonnelDirectory();
});
elements.personnelDirectoryCostCenterFilter?.addEventListener("change", (event) => {
  state.personnelDirectoryCostCenterFilter = event.target.value;
  renderPersonnelDirectory();
});
elements.personnelDirectoryStatusFilter?.addEventListener("change", (event) => {
  state.personnelDirectoryStatusFilter = event.target.value;
  renderPersonnelDirectory();
});
elements.centralVacationSearch?.addEventListener("input", (event) => {
  state.centralVacationSearch = event.target.value;
  renderCentralVacations();
});
elements.centralVacationCostCenterFilter?.addEventListener("change", (event) => {
  state.centralVacationCostCenterFilter = event.target.value;
  renderCentralVacations();
});
elements.centralVacationYear?.addEventListener("change", async (event) => {
  const year = Number(event.target.value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    showToast("Bitte ein gültiges Jahr auswählen.", true);
    event.target.value = state.centralVacationYear;
    return;
  }
  state.centralVacationYear = year;
  state.centralVacationLoadedYear = null;
  await loadCentralVacations({ force: true });
});
elements.addCostCenterButton?.addEventListener("click", () => openCostCenterModal());
elements.costCenterForm?.addEventListener("submit", saveCostCenter);
elements.deactivateCostCenterButton?.addEventListener("click", deactivateCostCenter);
document.querySelector("#saveSettingsButton").addEventListener("click", () => (
  elements.backupSettings?.classList.contains("active") ? saveBackupSettings() : saveSettings(false)
));
elements.locationForm.addEventListener("submit", saveLocation);
elements.departmentForm.addEventListener("submit", saveDepartment);
elements.addLocationButton?.addEventListener("click", async () => {
  try {
    await ensureLocationCostCenters();
    resetLocationForm();
    if (!state.costCenters.some((center) => center.active)) {
      showToast("Bitte zuerst eine aktive Kostenstelle anlegen.", true);
      return;
    }
    elements.locationEditorModal?.showModal();
  } catch (error) {
    showToast(error.message, true);
  }
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
elements.employeeTimeConfirmationLevel?.addEventListener("change", syncEmployeeSicknessAllowanceField);
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
elements.personnelRecordForm?.addEventListener("submit", savePersonnelRecord);
elements.personnelRecordContent?.addEventListener("input", (event) => {
  const field = event.target.closest("[data-personnel-field-key]");
  if (field && !event.target.disabled) state.personnelRecordDirtyFields.add(field.dataset.personnelFieldKey);
});
elements.personnelRecordContent?.addEventListener("click", (event) => {
  const uploadButton = event.target.closest("[data-upload-personnel-document]");
  if (uploadButton) {
    uploadPersonnelDocument();
    return;
  }
  const deleteButton = event.target.closest("[data-delete-personnel-document]");
  if (deleteButton) deletePersonnelDocument(deleteButton.dataset.deletePersonnelDocument);
});
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

elements.personnelDirectoryBody?.addEventListener("click", async (event) => {
  const recordButton = event.target.closest("[data-central-personnel-record]");
  if (recordButton) {
    openPersonnelRecord(recordButton.dataset.centralPersonnelRecord);
    return;
  }
  const editButton = event.target.closest("[data-central-edit-employee]");
  if (!editButton) return;
  const employeeNumber = editButton.dataset.centralEditEmployee;
  const employee = state.personnelDirectory.find((item) => item.personnel_number === employeeNumber);
  if (employee) openEmployeeModal(employee);
});

elements.costCenterList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-cost-center]");
  if (!button) return;
  const costCenter = state.costCenters.find((item) => String(item.id) === String(button.dataset.editCostCenter));
  if (costCenter) openCostCenterModal(costCenter);
});

elements.employeeTableBody.addEventListener("click", async (event) => {
  const recordButton = event.target.closest("[data-personnel-record]");
  if (recordButton) {
    openPersonnelRecord(recordButton.dataset.personnelRecord);
    return;
  }
  const button = event.target.closest("[data-edit-employee]");
  if (!button) return;
  if (canWriteCentralPersonnel() && !state.personnelAdministrationLoaded) await loadPersonnelAdministration();
  openEmployeeModal(state.allEmployees.find((employee) => employee.personnel_number === button.dataset.editEmployee));
});

elements.locationList.addEventListener("click", async (event) => {
  const locationButton = event.target.closest("[data-edit-location]");
  if (locationButton) {
    const location = (state.locations || []).find((item) => item.id === locationButton.dataset.editLocation);
    if (location) {
      try {
        await ensureLocationCostCenters();
        fillLocationForm(location);
        elements.locationEditorModal?.showModal();
      } catch (error) {
        showToast(error.message, true);
      }
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
