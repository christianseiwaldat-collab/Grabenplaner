"use strict";

const { definePersistenceStatement } = require("../contract");

const PROFILE_VERSION_ROW = Object.freeze({
  id: "text",
  profileId: "text",
  version: "text",
  layer: "text",
  status: "text",
  validFrom: "date",
  validTo: { kind: "date", nullable: true },
  rules: "json",
  sources: "json",
  contentSha256: "text",
  profileName: "text",
});

const CUSTOM_WORK_RULE_STATEMENTS = Object.freeze({
  getActiveBusinessUnit: definePersistenceStatement({
    id: "custom-work-rules.get-active-business-unit",
    operation: "queryOne",
    parameters: { id: "text" },
    columns: {
      id: "text",
      code: "text",
      name: "text",
    },
  }),
  getActiveLocation: definePersistenceStatement({
    id: "custom-work-rules.get-active-location",
    operation: "queryOne",
    parameters: { id: "text" },
    columns: {
      id: "text",
      name: "text",
    },
  }),
  getActiveDepartment: definePersistenceStatement({
    id: "custom-work-rules.get-active-department",
    operation: "queryOne",
    parameters: { id: "text" },
    columns: {
      id: "text",
      name: "text",
      locationId: "text",
      locationName: "text",
    },
  }),
  getProfileVersion: definePersistenceStatement({
    id: "custom-work-rules.get-profile-version",
    operation: "queryOne",
    parameters: { id: "text" },
    columns: PROFILE_VERSION_ROW,
  }),
  insertProfileVersion: definePersistenceStatement({
    id: "custom-work-rules.insert-profile-version",
    operation: "execute",
    parameters: {
      id: "text",
      profileId: "text",
      version: "text",
      layer: "text",
      status: "text",
      validFrom: "date",
      validTo: { kind: "date", nullable: true },
      rules: "json",
      sources: "json",
      contentSha256: "text",
      createdBy: "text",
      publishedAt: { kind: "text", nullable: true },
    },
  }),
  getProfileStatus: definePersistenceStatement({
    id: "custom-work-rules.get-profile-status",
    operation: "queryOne",
    parameters: { id: "text" },
    columns: { status: "text" },
  }),
  touchActiveProfile: definePersistenceStatement({
    id: "custom-work-rules.touch-active-profile",
    operation: "execute",
    parameters: {
      id: "text",
      updatedBy: "text",
    },
  }),
  updateDraftProfile: definePersistenceStatement({
    id: "custom-work-rules.update-draft-profile",
    operation: "execute",
    parameters: {
      id: "text",
      name: "text",
      description: "text",
      sector: "text",
      currentVersionId: "text",
      updatedBy: "text",
    },
  }),
  profileExists: definePersistenceStatement({
    id: "custom-work-rules.profile-exists",
    operation: "queryOne",
    parameters: { id: "text" },
    columns: { exists: "boolean" },
  }),
  insertProfile: definePersistenceStatement({
    id: "custom-work-rules.insert-profile",
    operation: "execute",
    parameters: {
      id: "text",
      name: "text",
      description: "text",
      createdBy: "text",
      updatedBy: "text",
    },
  }),
  getProfileForRevision: definePersistenceStatement({
    id: "custom-work-rules.get-profile-for-revision",
    operation: "queryOne",
    parameters: { id: "text" },
    columns: {
      id: "text",
      status: "text",
      builtin: "boolean",
    },
  }),
  countDraftVersions: definePersistenceStatement({
    id: "custom-work-rules.count-draft-versions",
    operation: "queryOne",
    parameters: { profileId: "text" },
    columns: { count: "safe_integer" },
  }),
  getCustomProfile: definePersistenceStatement({
    id: "custom-work-rules.get-custom-profile",
    operation: "queryOne",
    parameters: { id: "text" },
    columns: {
      id: "text",
      name: "text",
      description: "text",
      status: "text",
      currentVersionId: { kind: "text", nullable: true },
      createdBy: "text",
      updatedBy: "text",
      createdAt: "text",
      updatedAt: "text",
    },
  }),
  listProfileVersionMetadata: definePersistenceStatement({
    id: "custom-work-rules.list-profile-version-metadata",
    operation: "queryAll",
    parameters: { profileId: "text" },
    columns: {
      id: "text",
      createdBy: "text",
      createdAt: "text",
    },
  }),
  publicationRegistryAvailable: definePersistenceStatement({
    id: "custom-work-rules.publication-registry-available",
    operation: "queryOne",
    columns: { available: "boolean" },
  }),
  listPublications: definePersistenceStatement({
    id: "custom-work-rules.list-publications",
    operation: "queryAll",
    parameters: { profileId: "text" },
    columns: {
      sourceProfileVersionId: "text",
      releasedProfileVersionId: "text",
      id: "text",
      publishedAt: "text",
    },
  }),
  getVersionMetadata: definePersistenceStatement({
    id: "custom-work-rules.get-version-metadata",
    operation: "queryOne",
    parameters: { id: "text" },
    columns: {
      id: "text",
      createdBy: "text",
      createdAt: "text",
    },
  }),
  countReleaseVersions: definePersistenceStatement({
    id: "custom-work-rules.count-release-versions",
    operation: "queryOne",
    parameters: { profileId: "text" },
    columns: { count: "safe_integer" },
  }),
  activatePublishedProfile: definePersistenceStatement({
    id: "custom-work-rules.activate-published-profile",
    operation: "execute",
    parameters: {
      id: "text",
      name: "text",
      description: "text",
      sector: "text",
      currentVersionId: "text",
      updatedBy: "text",
    },
  }),
  listCustomProfileIds: definePersistenceStatement({
    id: "custom-work-rules.list-custom-profile-ids",
    operation: "queryAll",
    columns: { id: "text" },
  }),
});

module.exports = {
  CUSTOM_WORK_RULE_STATEMENTS,
};
