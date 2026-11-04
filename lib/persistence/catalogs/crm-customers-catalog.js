"use strict";
const { sqlPredicate } = require("../../flexible-search");

const {
  CRM_CUSTOMER_STATEMENTS: S,
} = require("../statements/crm-customers");

function entry(statement, sql) {
  return Object.freeze({ statement, sql, returning: false });
}

const CUSTOM_FIELDS_JSON = `
  COALESCE((
    SELECT json_group_array(json_object(
      'id', ordered.id,
      'title', ordered.title,
      'value', ordered.value,
      'sortOrder', ordered.sort_order
    ))
    FROM (
      SELECT id, title, value, sort_order
      FROM crm_customer_custom_fields
      WHERE customer_id = customer.id
      ORDER BY sort_order, id
    ) ordered
  ), '[]')
`;

const CUSTOMER_SEARCH_COLUMNS = `
  customer.id,
  customer.account_number AS accountNumber,
  customer.customer_number AS customerNumber,
  customer.customer_type AS customerType,
  customer.company_name AS companyName,
  customer.first_name AS firstName,
  customer.last_name AS lastName,
  customer.street,
  customer.address_supplement AS addressSupplement,
  customer.postal_code AS postalCode,
  customer.city,
  customer.country,
  customer.phone,
  customer.email,
  customer.website,
  customer.vat_id AS vatId,
  customer.birth_date AS birthDate,
  customer.revision,
  EXISTS(SELECT 1 FROM crm_customer_photos photo WHERE photo.customer_id = customer.id)
    AS photoAvailable,
  (SELECT photo.updated_at FROM crm_customer_photos photo WHERE photo.customer_id = customer.id)
    AS photoUpdatedAt
`;

const CUSTOMER_COLUMNS = `
  ${CUSTOMER_SEARCH_COLUMNS},
  ${CUSTOM_FIELDS_JSON} AS customFields
`;

const SEARCH_PREDICATE = `
  ($customerType IS NULL OR customer.customer_type = $customerType)
  AND ${sqlPredicate(['customer.account_number', 'customer.customer_number', 'customer.company_name', 'customer.first_name', 'customer.last_name', 'customer.street', 'customer.address_supplement', 'customer.postal_code', 'customer.city', 'customer.country', 'customer.phone', 'customer.email', 'customer.website', 'customer.vat_id', "(SELECT group_concat(custom.title || ' ' || custom.value, ' ') FROM crm_customer_custom_fields custom WHERE custom.customer_id=customer.id)"])}
`;

const SORT_VALUE = `CASE $sort
  WHEN 'accountNumber' THEN customer.account_number
  WHEN 'customerNumber' THEN customer.customer_number
  WHEN 'lastName' THEN customer.last_name
  WHEN 'firstName' THEN customer.first_name
  WHEN 'customerType' THEN customer.customer_type
  WHEN 'companyName' THEN customer.company_name
  WHEN 'postalCode' THEN customer.postal_code
  WHEN 'city' THEN customer.city
  WHEN 'country' THEN customer.country
  WHEN 'phone' THEN customer.phone
  WHEN 'email' THEN customer.email
  WHEN 'website' THEN customer.website
  WHEN 'vatId' THEN customer.vat_id
  WHEN 'birthDate' THEN customer.birth_date
END`;

const SQLITE_CRM_CUSTOMERS_CATALOG = Object.freeze([
  entry(S.search, `
    SELECT ${CUSTOMER_SEARCH_COLUMNS}
    FROM crm_customers customer
    WHERE ${SEARCH_PREDICATE}
    ORDER BY
      CASE WHEN $direction = 'asc' THEN ${SORT_VALUE} END COLLATE NOCASE ASC,
      CASE WHEN $direction = 'desc' THEN ${SORT_VALUE} END COLLATE NOCASE DESC,
      customer.last_name COLLATE NOCASE,
      customer.first_name COLLATE NOCASE,
      customer.company_name COLLATE NOCASE,
      customer.id
    LIMIT $limit OFFSET $offset
  `),
  entry(S.countSearch, `
    SELECT COUNT(*) AS total
    FROM crm_customers customer
    WHERE ${SEARCH_PREDICATE}
  `),
  entry(S.get, `
    SELECT ${CUSTOMER_COLUMNS}
    FROM crm_customers customer
    WHERE customer.id = $id
    LIMIT 1
  `),
  entry(S.insert, `
    INSERT INTO crm_customers (
      id, account_number, customer_number, customer_type, company_name, first_name, last_name,
      street, address_supplement, postal_code, city, country, phone, email,
      website, vat_id, birth_date, revision, created_by, created_at, updated_by, updated_at
    ) VALUES (
      $id, $accountNumber, $customerNumber, $customerType, $companyName, $firstName, $lastName,
      $street, $addressSupplement, $postalCode, $city, $country, $phone, $email,
      $website, $vatId, $birthDate, 1, $actor, $timestamp, $actor, $timestamp
    )
  `),
  entry(S.update, `
    UPDATE crm_customers SET
      account_number = $accountNumber,
      customer_number = $customerNumber,
      customer_type = $customerType,
      company_name = $companyName,
      first_name = $firstName,
      last_name = $lastName,
      street = $street,
      address_supplement = $addressSupplement,
      postal_code = $postalCode,
      city = $city,
      country = $country,
      phone = $phone,
      email = $email,
      website = $website,
      vat_id = $vatId,
      birth_date = $birthDate,
      revision = revision + 1,
      updated_by = $actor,
      updated_at = $timestamp
    WHERE id = $id AND revision = $expectedRevision
  `),
  entry(S.deleteCustomFields, `
    DELETE FROM crm_customer_custom_fields WHERE customer_id = $customerId
  `),
  entry(S.insertCustomField, `
    INSERT INTO crm_customer_custom_fields (
      id, customer_id, title, value, sort_order, revision,
      created_by, created_at, updated_by, updated_at
    ) VALUES (
      $id, $customerId, $title, $value, $sortOrder, $revision,
      $actor, $timestamp, $actor, $timestamp
    )
  `),
  entry(S.getPhoto, `
    SELECT
      customer_id AS customerId,
      storage_key AS storageKey,
      content_sha256 AS contentSha256,
      byte_size AS byteSize,
      media_type AS mediaType,
      original_filename AS originalFilename,
      revision,
      updated_by AS updatedBy,
      updated_at AS updatedAt
    FROM crm_customer_photos
    WHERE customer_id = $customerId
    LIMIT 1
  `),
  entry(S.upsertPhoto, `
    INSERT INTO crm_customer_photos (
      customer_id, storage_key, content_sha256, byte_size, media_type,
      original_filename, revision, created_by, created_at, updated_by, updated_at
    ) VALUES (
      $customerId, $storageKey, $contentSha256, $byteSize, $mediaType,
      $originalFilename, 1, $actor, $timestamp, $actor, $timestamp
    )
    ON CONFLICT(customer_id) DO UPDATE SET
      storage_key = excluded.storage_key,
      content_sha256 = excluded.content_sha256,
      byte_size = excluded.byte_size,
      media_type = excluded.media_type,
      original_filename = excluded.original_filename,
      revision = crm_customer_photos.revision + 1,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `),
  entry(S.deletePhoto, `
    DELETE FROM crm_customer_photos WHERE customer_id = $customerId
  `),
  entry(S.insertAudit, `
    INSERT INTO audit_log (actor, action, entity_type, entity_id, detail, created_at)
    VALUES ($actor, $action, $entityType, $entityId, $detail, $timestamp)
  `),
]);

module.exports = {
  SQLITE_CRM_CUSTOMERS_CATALOG,
};
