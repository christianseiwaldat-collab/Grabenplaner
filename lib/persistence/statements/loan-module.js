"use strict";

const { definePersistenceStatement } = require("../contract");

const JSON_PARAMETER = Object.freeze({ payload: "json" });
const JSON_ROW = Object.freeze({ data: "json" });

function queryOne(id, { parameters = JSON_PARAMETER } = {}) {
  return definePersistenceStatement({
    id: `loan-module.${id}`,
    operation: "queryOne",
    parameters,
    columns: JSON_ROW,
  });
}

function queryAll(id, { parameters = JSON_PARAMETER } = {}) {
  return definePersistenceStatement({
    id: `loan-module.${id}`,
    operation: "queryAll",
    parameters,
    columns: JSON_ROW,
  });
}

function execute(id, { parameters = JSON_PARAMETER } = {}) {
  return definePersistenceStatement({
    id: `loan-module.${id}`,
    operation: "execute",
    parameters,
  });
}

const LOAN_MODULE_STATEMENTS = Object.freeze({
  firstActiveLocation: queryOne("first-active-location", { parameters: {} }),
  getLocationSetting: queryOne("get-location-setting"),
  listLocationSettings: queryAll("list-location-settings", { parameters: {} }),
  getDocumentRecipientCandidate: queryOne("get-document-recipient-candidate"),
  upsertLocationSetting: execute("upsert-location-setting"),
  updateBranchOverviewColumns: execute("update-branch-overview-columns"),

  getArticle: queryOne("get-article"),
  getArticleByIdentifier: queryOne("get-article-by-identifier"),
  searchArticles: queryAll("search-articles"),
  upsertArticle: execute("upsert-article"),
  upsertArticleIdentifier: execute("upsert-article-identifier"),
  getActiveArticle: queryOne("get-active-article"),
  listOpenOverviewItems: queryAll("list-open-overview-items"),

  listMigrationRuns: queryAll("list-migration-runs", { parameters: {} }),
  getMigrationRun: queryOne("get-migration-run"),
  getF18MigrationRunForLocation: queryOne("get-f18-migration-run-for-location"),
  listMigrationTargetEmployees: queryAll("list-migration-target-employees", { parameters: {} }),
  insertMigrationRun: execute("insert-migration-run"),
  upsertImportedArticle: execute("upsert-imported-article"),
  insertImportedLoan: execute("insert-imported-loan"),
  insertMigrationRecord: execute("insert-migration-record"),

  getEmployee: queryOne("get-employee"),
  getLoan: queryOne("get-loan"),
  listLoans: queryAll("list-loans"),
  listManagementLoans: queryAll("list-management-loans"),
  listTeamMembers: queryAll("list-team-members"),
  hasLivePortalSession: queryOne("has-live-portal-session"),

  expireReturnConfirmations: execute("expire-return-confirmations", { parameters: {} }),
  getReturnConfirmation: queryOne("get-return-confirmation"),
  getPendingReturnConfirmation: queryOne("get-pending-return-confirmation"),
  listPendingReturnConfirmations: queryAll("list-pending-return-confirmations"),
  getPendingWitnessPayload: queryOne("get-pending-witness-payload"),
  getReturnPreparation: queryOne("get-return-preparation"),
  upsertReturnPreparation: execute("upsert-return-preparation"),
  deleteReturnPreparation: execute("delete-return-preparation"),
  insertReturnConfirmation: execute("insert-return-confirmation"),
  cancelReturnConfirmation: execute("cancel-return-confirmation"),
  rejectReturnConfirmation: execute("reject-return-confirmation"),
  confirmReturnConfirmation: execute("confirm-return-confirmation"),

  listLoanItems: queryAll("list-loan-items"),
  listLoanEvents: queryAll("list-loan-events"),
  listLoanDocuments: queryAll("list-loan-documents"),
  getLoanDocument: queryOne("get-loan-document"),
  listLoanPhotos: queryAll("list-loan-photos"),
  getLoanPhoto: queryOne("get-loan-photo"),
  listLoanPhotoAttachments: queryAll("list-loan-photo-attachments"),
  getLoanPhotoAttachment: queryOne("get-loan-photo-attachment"),
  listLoanDocumentDeliveries: queryAll("list-loan-document-deliveries"),
  listFallbackDocumentRecipients: queryAll("list-fallback-document-recipients", { parameters: {} }),
  countLoanPhotos: queryOne("count-loan-photos"),
  nextPhotoAttachmentRevision: queryOne("next-photo-attachment-revision"),

  insertLoanDocumentDelivery: execute("insert-loan-document-delivery"),
  insertLoanPhoto: execute("insert-loan-photo"),
  insertLoanPhotoAttachment: execute("insert-loan-photo-attachment"),
  insertLoanDocument: execute("insert-loan-document"),
  insertLoanEvent: execute("insert-loan-event"),
  insertLoan: execute("insert-loan"),
  insertLoanItem: execute("insert-loan-item"),

  updateManagedLoan: execute("update-managed-loan"),
  updateManagedLoanItem: execute("update-managed-loan-item"),
  closeManagedLoan: execute("close-managed-loan"),
  reopenManagedLoan: execute("reopen-managed-loan"),
  clearLoanItemReturnConditions: execute("clear-loan-item-return-conditions"),
  markLoanReturned: execute("mark-loan-returned"),
  updateLoanItemReturnCondition: execute("update-loan-item-return-condition"),
  markConfirmationNotificationsRead: execute("mark-confirmation-notifications-read"),
  markRecipientConfirmationNotificationRead: execute("mark-recipient-confirmation-notification-read"),

  listProtectedLoanDocuments: queryAll("list-protected-loan-documents", { parameters: {} }),
  listProtectedLoanPhotos: queryAll("list-protected-loan-photos", { parameters: {} }),
  listProtectedLoanPhotoAttachments: queryAll("list-protected-loan-photo-attachments", { parameters: {} }),
  listLoanDocumentStorageKeys: queryAll("list-loan-document-storage-keys", { parameters: {} }),
  listLoanPhotoStorageKeys: queryAll("list-loan-photo-storage-keys", { parameters: {} }),
  listLoanPhotoAttachmentStorageKeys: queryAll("list-loan-photo-attachment-storage-keys", { parameters: {} }),
});

module.exports = {
  LOAN_MODULE_STATEMENTS,
};
