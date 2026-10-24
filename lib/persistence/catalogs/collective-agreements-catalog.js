"use strict";

const {
  COLLECTIVE_AGREEMENTS_STATEMENTS,
} = require("../statements/collective-agreements");

const AGREEMENT_COLUMNS = `
  id,
  code,
  title,
  short_title AS shortTitle,
  jurisdiction,
  review_state AS reviewState,
  current_version_id AS currentVersionId,
  note,
  created_by AS createdBy,
  updated_by AS updatedBy,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const VERSION_COLUMNS = `
  id,
  agreement_id AS agreementId,
  version_label AS versionLabel,
  source_state AS sourceState,
  valid_from AS validFrom,
  valid_to AS validTo,
  external_published_on AS externalPublishedOn,
  source_title AS sourceTitle,
  source_url AS sourceUrl,
  source_retrieved_on AS sourceRetrievedOn,
  source_sha256 AS sourceSha256,
  source_note AS sourceNote,
  contracting_parties_json AS contractingParties,
  territorial_scope AS territorialScope,
  functional_scope AS functionalScope,
  personal_scope AS personalScope,
  employee_groups_json AS employeeGroups,
  work_time_parameters_note AS workTimeParametersNote,
  classification_note AS classificationNote,
  apprentice_relevance AS apprenticeRelevance,
  apprentice_note AS apprenticeNote,
  successor_note AS successorNote,
  linked_profile_version_id AS linkedProfileVersionId,
  snapshot_json AS snapshot,
  content_sha256 AS contentSha256,
  created_by AS createdBy,
  created_at AS createdAt
`;

const BUSINESS_UNIT_COLUMNS = `
  id,
  code,
  name,
  legal_entity_name AS legalEntityName,
  description,
  active,
  created_by AS createdBy,
  updated_by AS updatedBy,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const BUSINESS_UNIT_SCOPE_COLUMNS = `
  id,
  business_unit_id AS businessUnitId,
  scope_type AS scopeType,
  scope_key AS scopeKey,
  created_by AS createdBy,
  created_at AS createdAt
`;

const ASSIGNMENT_COLUMNS = `
  a.id,
  v.agreement_id AS agreementId,
  c.code AS agreementCode,
  c.title AS agreementTitle,
  a.agreement_version_id AS agreementVersionId,
  v.version_label AS versionLabel,
  a.business_unit_id AS businessUnitId,
  u.code AS businessUnitCode,
  u.name AS businessUnitName,
  a.valid_from AS validFrom,
  a.valid_to AS validTo,
  a.review_state AS reviewState,
  a.rationale,
  a.reference_note AS referenceNote,
  a.created_by AS createdBy,
  a.created_at AS createdAt
`;

function entry(statement, sql) {
  return Object.freeze({
    statement,
    sql,
    returning: false,
  });
}

const SQLITE_COLLECTIVE_AGREEMENTS_CATALOG = Object.freeze([
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.agreementByCode,
    `
      SELECT id
      FROM collective_agreements
      WHERE code = $code
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.agreementById,
    `
      SELECT ${AGREEMENT_COLUMNS}
      FROM collective_agreements
      WHERE id = $id
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.listAgreements,
    `
      SELECT ${AGREEMENT_COLUMNS}
      FROM collective_agreements
      ORDER BY title COLLATE NOCASE, code
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.insertAgreement,
    `
      INSERT INTO collective_agreements (
        id,
        code,
        title,
        short_title,
        jurisdiction,
        review_state,
        note,
        created_by,
        updated_by
      )
      VALUES (
        $id,
        $code,
        $title,
        $shortTitle,
        $jurisdiction,
        'review_pending',
        $note,
        $actor,
        $actor
      )
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.linkedProfileVersionById,
    `
      SELECT id, layer
      FROM work_rule_profile_versions
      WHERE id = $id
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.versionByLabel,
    `
      SELECT id
      FROM collective_agreement_versions
      WHERE agreement_id = $agreementId
        AND version_label = $versionLabel
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.versionRangeById,
    `
      SELECT
        id,
        valid_from AS validFrom,
        valid_to AS validTo
      FROM collective_agreement_versions
      WHERE id = $id
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.listVersions,
    `
      SELECT ${VERSION_COLUMNS}
      FROM collective_agreement_versions
      ORDER BY valid_from DESC, created_at DESC, id DESC
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.listVersionsByAgreement,
    `
      SELECT ${VERSION_COLUMNS}
      FROM collective_agreement_versions
      WHERE agreement_id = $agreementId
      ORDER BY valid_from DESC, created_at DESC, id DESC
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.insertVersion,
    `
      INSERT INTO collective_agreement_versions (
        id,
        agreement_id,
        version_label,
        source_state,
        valid_from,
        valid_to,
        external_published_on,
        source_title,
        source_url,
        source_retrieved_on,
        source_sha256,
        source_note,
        contracting_parties_json,
        territorial_scope,
        functional_scope,
        personal_scope,
        employee_groups_json,
        work_time_parameters_note,
        classification_note,
        apprentice_relevance,
        apprentice_note,
        successor_note,
        linked_profile_version_id,
        snapshot_json,
        content_sha256,
        created_by
      )
      VALUES (
        $id,
        $agreementId,
        $versionLabel,
        'documented',
        $validFrom,
        $validTo,
        $externalPublishedOn,
        $sourceTitle,
        $sourceUrl,
        $sourceRetrievedOn,
        $sourceSha256,
        $sourceNote,
        $contractingParties,
        $territorialScope,
        $functionalScope,
        $personalScope,
        $employeeGroups,
        $workTimeParametersNote,
        $classificationNote,
        $apprenticeRelevance,
        $apprenticeNote,
        $successorNote,
        $linkedProfileVersionId,
        $snapshot,
        $contentSha256,
        $actor
      )
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.setCurrentVersion,
    `
      UPDATE collective_agreements
      SET
        current_version_id = $versionId,
        updated_by = $actor,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $agreementId
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.businessUnitByCode,
    `
      SELECT id
      FROM collective_agreement_business_units
      WHERE code = $code
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.businessUnitById,
    `
      SELECT ${BUSINESS_UNIT_COLUMNS}
      FROM collective_agreement_business_units
      WHERE id = $id
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.activeBusinessUnitById,
    `
      SELECT id
      FROM collective_agreement_business_units
      WHERE id = $id
        AND active = 1
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.listBusinessUnits,
    `
      SELECT ${BUSINESS_UNIT_COLUMNS}
      FROM collective_agreement_business_units
      ORDER BY name COLLATE NOCASE, code
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.listActiveBusinessUnits,
    `
      SELECT ${BUSINESS_UNIT_COLUMNS}
      FROM collective_agreement_business_units
      WHERE active = 1
      ORDER BY name COLLATE NOCASE, code
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.insertBusinessUnit,
    `
      INSERT INTO collective_agreement_business_units (
        id,
        code,
        name,
        legal_entity_name,
        description,
        active,
        created_by,
        updated_by
      )
      VALUES (
        $id,
        $code,
        $name,
        $legalEntityName,
        $description,
        1,
        $actor,
        $actor
      )
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.touchBusinessUnit,
    `
      UPDATE collective_agreement_business_units
      SET
        updated_by = $actor,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $id
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.listBusinessUnitScopes,
    `
      SELECT ${BUSINESS_UNIT_SCOPE_COLUMNS}
      FROM collective_agreement_business_unit_scopes
      ORDER BY business_unit_id, scope_type, scope_key
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.listBusinessUnitScopesByUnit,
    `
      SELECT ${BUSINESS_UNIT_SCOPE_COLUMNS}
      FROM collective_agreement_business_unit_scopes
      WHERE business_unit_id = $businessUnitId
      ORDER BY scope_type, scope_key
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.activeScopeOwner,
    `
      SELECT u.name
      FROM collective_agreement_business_unit_scopes s
      JOIN collective_agreement_business_units u
        ON u.id = s.business_unit_id
      WHERE s.scope_type = $scopeType
        AND s.scope_key = $scopeKey
        AND u.active = 1
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.insertBusinessUnitScope,
    `
      INSERT INTO collective_agreement_business_unit_scopes (
        id,
        business_unit_id,
        scope_type,
        scope_key,
        created_by
      )
      VALUES (
        $id,
        $businessUnitId,
        $scopeType,
        $scopeKey,
        $actor
      )
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.costCenterScopeTarget,
    `
      SELECT
        CAST(id AS TEXT) AS scopeKey,
        code,
        name
      FROM cost_centers
      WHERE CAST(id AS TEXT) = $scopeKey
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.locationScopeTarget,
    `
      SELECT
        CAST(id AS TEXT) AS scopeKey,
        name
      FROM locations
      WHERE CAST(id AS TEXT) = $scopeKey
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.departmentScopeTarget,
    `
      SELECT
        CAST(d.id AS TEXT) AS scopeKey,
        d.name,
        CAST(l.id AS TEXT) AS locationId,
        l.name AS locationName
      FROM departments d
      JOIN locations l
        ON l.id = d.location_id
      WHERE CAST(d.id AS TEXT) = $scopeKey
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.pendingAssignment,
    `
      SELECT id
      FROM collective_agreement_assignments
      WHERE agreement_version_id = $agreementVersionId
        AND business_unit_id = $businessUnitId
        AND valid_from = $validFrom
        AND COALESCE(valid_to, '') = COALESCE($validTo, '')
        AND review_state = 'review_pending'
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.insertAssignment,
    `
      INSERT INTO collective_agreement_assignments (
        id,
        agreement_version_id,
        business_unit_id,
        valid_from,
        valid_to,
        review_state,
        rationale,
        reference_note,
        created_by
      )
      VALUES (
        $id,
        $agreementVersionId,
        $businessUnitId,
        $validFrom,
        $validTo,
        'review_pending',
        $rationale,
        $referenceNote,
        $actor
      )
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.assignmentById,
    `
      SELECT ${ASSIGNMENT_COLUMNS}
      FROM collective_agreement_assignments a
      JOIN collective_agreement_versions v
        ON v.id = a.agreement_version_id
      JOIN collective_agreements c
        ON c.id = v.agreement_id
      JOIN collective_agreement_business_units u
        ON u.id = a.business_unit_id
      WHERE a.id = $id
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.listAssignments,
    `
      SELECT ${ASSIGNMENT_COLUMNS}
      FROM collective_agreement_assignments a
      JOIN collective_agreement_versions v
        ON v.id = a.agreement_version_id
      JOIN collective_agreements c
        ON c.id = v.agreement_id
      JOIN collective_agreement_business_units u
        ON u.id = a.business_unit_id
      ORDER BY a.created_at DESC, a.id DESC
    `,
  ),
  entry(
    COLLECTIVE_AGREEMENTS_STATEMENTS.listAssignmentGovernanceEvents,
    `
      SELECT assignment_id, event_type, effective_on, occurred_at, id
      FROM collective_agreement_assignment_events
      ORDER BY assignment_id, effective_on, occurred_at, id
    `,
  ),
]);

module.exports = {
  SQLITE_COLLECTIVE_AGREEMENTS_CATALOG,
};
