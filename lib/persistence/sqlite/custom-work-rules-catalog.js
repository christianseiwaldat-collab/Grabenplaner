"use strict";

const {
  CUSTOM_WORK_RULE_STATEMENTS,
} = require("../statements/custom-work-rules");

const SQLITE_CUSTOM_WORK_RULES_CATALOG = Object.freeze([
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.getActiveBusinessUnit,
    sql: `
      SELECT id, code, name
      FROM collective_agreement_business_units
      WHERE id = $id AND active = 1
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.getActiveLocation,
    sql: `
      SELECT CAST(id AS TEXT) AS id, name
      FROM locations
      WHERE CAST(id AS TEXT) = $id AND active = 1
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.getActiveDepartment,
    sql: `
      SELECT
        CAST(d.id AS TEXT) AS id,
        d.name,
        CAST(l.id AS TEXT) AS locationId,
        l.name AS locationName
      FROM departments d
      JOIN locations l ON l.id = d.location_id
      WHERE CAST(d.id AS TEXT) = $id
        AND d.active = 1
        AND l.active = 1
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.getProfileVersion,
    sql: `
      SELECT
        v.id,
        v.profile_id AS profileId,
        v.version,
        v.layer,
        v.status,
        v.valid_from AS validFrom,
        v.valid_to AS validTo,
        v.rules_json AS rules,
        v.sources_json AS sources,
        v.content_sha256 AS contentSha256,
        p.name AS profileName
      FROM work_rule_profile_versions v
      JOIN work_rule_profiles p ON p.id = v.profile_id
      WHERE v.id = $id
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.insertProfileVersion,
    sql: `
      INSERT INTO work_rule_profile_versions (
        id,
        profile_id,
        version,
        layer,
        status,
        valid_from,
        valid_to,
        rules_json,
        sources_json,
        content_sha256,
        created_by,
        published_at
      )
      VALUES (
        $id,
        $profileId,
        $version,
        $layer,
        $status,
        $validFrom,
        $validTo,
        $rules,
        $sources,
        $contentSha256,
        $createdBy,
        $publishedAt
      )
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.getProfileStatus,
    sql: `
      SELECT status
      FROM work_rule_profiles
      WHERE id = $id
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.touchActiveProfile,
    sql: `
      UPDATE work_rule_profiles
      SET updated_by = $updatedBy, updated_at = CURRENT_TIMESTAMP
      WHERE id = $id AND builtin = 0
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.updateDraftProfile,
    sql: `
      UPDATE work_rule_profiles
      SET
        name = $name,
        description = $description,
        jurisdiction = 'AT',
        sector = $sector,
        status = 'draft',
        current_version_id = $currentVersionId,
        updated_by = $updatedBy,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $id AND builtin = 0
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.profileExists,
    sql: `
      SELECT EXISTS(
        SELECT 1
        FROM work_rule_profiles
        WHERE id = $id
      ) AS "exists"
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.insertProfile,
    sql: `
      INSERT INTO work_rule_profiles (
        id,
        name,
        description,
        jurisdiction,
        sector,
        builtin,
        status,
        current_version_id,
        created_by,
        updated_by
      )
      VALUES (
        $id,
        $name,
        $description,
        'AT',
        'custom',
        0,
        'draft',
        NULL,
        $createdBy,
        $updatedBy
      )
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.getProfileForRevision,
    sql: `
      SELECT id, status, builtin
      FROM work_rule_profiles
      WHERE id = $id
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.countDraftVersions,
    sql: `
      SELECT COUNT(*) AS count
      FROM work_rule_profile_versions
      WHERE profile_id = $profileId AND version LIKE 'draft-%'
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.getCustomProfile,
    sql: `
      SELECT
        id,
        name,
        description,
        status,
        current_version_id AS currentVersionId,
        created_by AS createdBy,
        updated_by AS updatedBy,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM work_rule_profiles
      WHERE id = $id AND builtin = 0 AND id LIKE 'custom:%'
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.listProfileVersionMetadata,
    sql: `
      SELECT id, created_by AS createdBy, created_at AS createdAt
      FROM work_rule_profile_versions
      WHERE profile_id = $profileId
      ORDER BY created_at DESC, id DESC
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.publicationRegistryAvailable,
    sql: `
      SELECT EXISTS(
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name = 'work_rule_publications'
      ) AS available
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.listPublications,
    sql: `
      SELECT
        source_profile_version_id AS sourceProfileVersionId,
        released_profile_version_id AS releasedProfileVersionId,
        id,
        published_at AS publishedAt
      FROM work_rule_publications
      WHERE profile_id = $profileId
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.getVersionMetadata,
    sql: `
      SELECT id, created_by AS createdBy, created_at AS createdAt
      FROM work_rule_profile_versions
      WHERE id = $id
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.countReleaseVersions,
    sql: `
      SELECT COUNT(*) AS count
      FROM work_rule_profile_versions
      WHERE profile_id = $profileId AND version LIKE 'release-%'
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.activatePublishedProfile,
    sql: `
      UPDATE work_rule_profiles
      SET
        name = $name,
        description = $description,
        jurisdiction = 'AT',
        sector = $sector,
        status = 'active',
        current_version_id = $currentVersionId,
        updated_by = $updatedBy,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $id AND builtin = 0
    `,
  }),
  Object.freeze({
    statement: CUSTOM_WORK_RULE_STATEMENTS.listCustomProfileIds,
    sql: `
      SELECT id
      FROM work_rule_profiles
      WHERE builtin = 0 AND id LIKE 'custom:%'
      ORDER BY name COLLATE NOCASE, id
    `,
  }),
].map((entry) => Object.freeze({
  ...entry,
  returning: false,
})));

module.exports = {
  SQLITE_CUSTOM_WORK_RULES_CATALOG,
};
