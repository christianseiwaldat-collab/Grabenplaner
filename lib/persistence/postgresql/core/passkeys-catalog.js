'use strict';
const crypto = require('node:crypto');
const { S, SUBJECT, CREDENTIAL, CHALLENGE } = require('../../statements/passkeys');
const snake = key => key.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
const project = (columns, alias = '') => Object.keys(columns).map(key => `${alias}${snake(key)} AS "${key}"`).join(',');
const entry = (statement, sql, order, returning = false) => Object.freeze({ statement, sql, parameterOrder: order, returning });
const subject = project(SUBJECT), credential = project(CREDENTIAL), challenge = project(CHALLENGE);
const ENTRIES = Object.freeze([
  entry(S.available, `SELECT (to_regclass('gp.passkey_subjects') IS NOT NULL AND to_regclass('gp.passkey_credentials') IS NOT NULL
    AND to_regclass('gp.passkey_challenges') IS NOT NULL AND to_regclass('gp.passkeys_migration_history') IS NOT NULL) AS available`, []),
  entry(S.subjectForPrincipal, `SELECT ${subject} FROM gp.passkey_subjects WHERE principal_kind=$1 AND principal_id=$2`, ['kind', 'principalId']),
  entry(S.subjectForHandle, `SELECT ${subject} FROM gp.passkey_subjects WHERE user_handle=$1`, ['userHandle']),
  entry(S.subjectById, `SELECT ${subject} FROM gp.passkey_subjects WHERE id=$1`, ['id']),
  entry(S.ensureSubject, `INSERT INTO gp.passkey_subjects(id,principal_kind,employee_number,account_id,user_handle,auth_revision,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,1,$6,$6) ON CONFLICT(principal_kind,principal_id) DO NOTHING RETURNING ${subject}`,
  ['id', 'kind', 'employeeNumber', 'accountId', 'userHandle', 'now'], true),
  entry(S.listCredentials, `SELECT ${credential} FROM gp.passkey_credentials WHERE subject_id=$1 AND ($2 OR (revoked_at IS NULL
    AND auth_revision=(SELECT auth_revision FROM gp.passkey_subjects WHERE id=$1)))
    ORDER BY created_at,id LIMIT $3`, ['subjectId', 'includeRevoked', 'limit']),
  entry(S.credential, `SELECT ${credential} FROM gp.passkey_credentials WHERE credential_id=$1`, ['credentialId']),
  entry(S.credentialById, `SELECT ${credential} FROM gp.passkey_credentials WHERE id=$1 AND subject_id=$2`, ['id', 'subjectId']),
  entry(S.registerCredential, `INSERT INTO gp.passkey_credentials(id,subject_id,auth_revision,credential_id,public_key,counter,authority_hash,device_type,backed_up,transports,label,revision,created_at)
    SELECT $1,$2,$12,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,1,$11
    WHERE EXISTS(SELECT 1 FROM gp.passkey_subjects WHERE id=$2 AND auth_revision=$12)
      AND (SELECT count(*) FROM gp.passkey_credentials WHERE subject_id=$2 AND auth_revision=$12 AND revoked_at IS NULL)<10
    RETURNING ${credential}`, ['id', 'subjectId', 'credentialId', 'publicKey', 'counter', 'authorityHash', 'deviceType', 'backedUp', 'transports', 'label', 'now', 'expectedAuthRevision'], true),
  entry(S.updateCredentialUse, `UPDATE gp.passkey_credentials SET counter=$1,backed_up=$2,last_used_at=$3,revision=revision+1
    WHERE id=$4 AND subject_id=$5 AND auth_revision=$9 AND revision=$6 AND counter=$7 AND authority_hash=$8 AND revoked_at IS NULL
      AND ($1>counter OR ($1=0 AND counter=0)) AND (device_type='multiDevice' OR $2=FALSE)
      AND EXISTS(SELECT 1 FROM gp.passkey_subjects WHERE id=$5 AND auth_revision=$9)
    RETURNING ${credential}`, ['newCounter', 'backedUp', 'now', 'id', 'subjectId', 'expectedRevision', 'expectedCounter', 'expectedAuthorityHash', 'expectedAuthRevision'], true),
  entry(S.revokeCredential, `UPDATE gp.passkey_credentials SET revoked_at=$1,revision=revision+1
    WHERE id=$2 AND subject_id=$3 AND revision=$4 AND revoked_at IS NULL RETURNING ${credential}`,
  ['now', 'id', 'subjectId', 'expectedRevision'], true),
  entry(S.revokePrincipal, `WITH changed AS (
      UPDATE gp.passkey_subjects SET auth_revision=auth_revision+1,updated_at=$1 WHERE principal_kind=$2 AND principal_id=$3 RETURNING *
    ), revoked AS (
      UPDATE gp.passkey_credentials SET revoked_at=$1,revision=revision+1 WHERE subject_id IN(SELECT id FROM changed) AND revoked_at IS NULL RETURNING id
    ), consumed AS (
      UPDATE gp.passkey_challenges SET consumed_at=$1 WHERE subject_id IN(SELECT id FROM changed) AND consumed_at IS NULL RETURNING id
    ) SELECT ${project(SUBJECT, 'changed.')},(SELECT count(*) FROM revoked) AS "revokedCredentials" FROM changed`, ['now', 'kind', 'principalId'], true),
  entry(S.issueChallenge, `INSERT INTO gp.passkey_challenges(id,subject_id,purpose,challenge,binding_hash,session_hash,authority_hash,expected_auth_revision,rp_id,origin,payload,created_at,expires_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13
    WHERE (SELECT count(*) FROM gp.passkey_challenges WHERE binding_hash=$5 AND consumed_at IS NULL AND expires_at>$12)<100
      AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM gp.passkey_subjects WHERE id=$2 AND auth_revision=$8))
    RETURNING ${challenge}`, ['id', 'subjectId', 'purpose', 'challenge', 'bindingHash', 'sessionHash', 'authorityHash', 'expectedAuthRevision', 'rpId', 'origin', 'payload', 'createdAt', 'expiresAt'], true),
  entry(S.consumeChallenge, `UPDATE gp.passkey_challenges c SET consumed_at=$1
    WHERE c.id=$2 AND c.purpose=$3 AND c.binding_hash=$4 AND c.consumed_at IS NULL AND c.expires_at>$1
      AND c.created_at<=$1 AND (c.subject_id IS NULL OR EXISTS(SELECT 1 FROM gp.passkey_subjects s WHERE s.id=c.subject_id AND s.auth_revision=c.expected_auth_revision))
    RETURNING ${project(CHALLENGE, 'c.')}`, ['now', 'id', 'purpose', 'bindingHash'], true),
  entry(S.purgeChallenges, `DELETE FROM gp.passkey_challenges WHERE id IN(SELECT id FROM gp.passkey_challenges
    WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT $2)`, ['now', 'limit']),
]);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function assertPasskeysCatalog() {
  const pinned = require('../contracts/passkeys-catalog-v1.json');
  if (pinned.version !== 1 || pinned.schemaDigest !== require('./passkeys').digest || pinned.entries.length !== ENTRIES.length || new Set(pinned.entries.map(e => e.id)).size !== ENTRIES.length
    || ENTRIES.some(entry => !pinned.entries.some(item => item.id === entry.statement.id && item.sha256 === sha(JSON.stringify(entry))))) throw new Error('PG_PASSKEYS_CATALOG_CONTRACT');
  return ENTRIES;
}
module.exports = { CATALOG: ENTRIES, assertPasskeysCatalog };
