"use strict";

const {
  assertPersistenceAccess,
} = require("./contract");
const {
  createBrandingSnapshotRepository,
} = require("./repositories/branding-snapshot");
const {
  createAbsenceManagementRepository,
} = require("./repositories/absence-management");
const {
  createCollectiveAgreementsRepository,
} = require("./repositories/collective-agreements");
const {
  createCustomWorkRulesRepository,
} = require("./repositories/custom-work-rules");
const {
  createCustomProcessManagementRepository,
} = require("./repositories/custom-process-management");
const {
  createGovernanceStoreRepository,
} = require("./repositories/governance-store");
const {
  createIntegrationRuntimeRepository,
} = require("./repositories/integration-runtime");
const {
  createOrganizationPersonnelRepository,
} = require("./repositories/organization-personnel");
const {
  createPersonalNotificationContactsRepository,
} = require("./repositories/personal-notification-contacts");
const {
  createPersonnelLifecycleRepository,
} = require("./repositories/personnel-lifecycle");
const {
  createPlanningSettingsRepository,
} = require("./repositories/planning-settings");
const {
  createLoanModuleRepository,
} = require("./repositories/loan-module");
const {
  createMobileAuthRepository,
} = require("./repositories/mobile-auth");
const {
  createPortalAccessRepository,
} = require("./repositories/portal-access");
const {
  createUiPreferencesRepository,
} = require("./repositories/ui-preferences");
const {
  createTimeTrackingRepository,
} = require("./repositories/time-tracking");
const {
  createWifiAutomationRepository,
} = require("./repositories/wifi-automation");
const {
  createWorkRuleStoreRepository,
} = require("./repositories/work-rule-store");
const {
  createWorkRuleGovernanceRepository,
} = require("./repositories/work-rule-governance");
const {
  createSystemCenterMetricsRepository,
} = require("./repositories/system-center-metrics");
const {
  createRuntimeRecoveryRepository,
} = require("./repositories/runtime-recovery");
const {
  createSicknessAmuManagementRepository,
} = require("./repositories/sickness-amu-management");
const {
  createSalesAnalyticsPersistenceRepository,
} = require("./repositories/sales-analytics");

const createApplicationRepositories = Object.freeze(function createApplicationRepositories(access) {
  assertPersistenceAccess(access);
  return Object.freeze({
    absenceManagement: createAbsenceManagementRepository(access),
    brandingSnapshot: createBrandingSnapshotRepository(access),
    collectiveAgreements: createCollectiveAgreementsRepository(access),
    customProcessManagement: createCustomProcessManagementRepository(access),
    customWorkRules: createCustomWorkRulesRepository(access),
    governanceStore: createGovernanceStoreRepository(access),
    integrationRuntime: createIntegrationRuntimeRepository(access),
    loanModule: createLoanModuleRepository(access),
    mobileAuth: createMobileAuthRepository(access),
    organizationPersonnel: createOrganizationPersonnelRepository(access),
    personalNotificationContacts: createPersonalNotificationContactsRepository(access),
    personnelLifecycle: createPersonnelLifecycleRepository(access),
    planningSettings: createPlanningSettingsRepository(access),
    portalAccess: createPortalAccessRepository(access),
    runtimeRecovery: createRuntimeRecoveryRepository(access),
    salesAnalytics: createSalesAnalyticsPersistenceRepository(access),
    sicknessAmuManagement: createSicknessAmuManagementRepository(access),
    systemCenterMetrics: createSystemCenterMetricsRepository(access),
    timeTracking: createTimeTrackingRepository(access),
    uiPreferences: createUiPreferencesRepository(access),
    wifiAutomation: createWifiAutomationRepository(access),
    workRuleGovernance: createWorkRuleGovernanceRepository(access),
    workRules: createWorkRuleStoreRepository(access),
  });
});

module.exports = {
  createApplicationRepositories,
};
