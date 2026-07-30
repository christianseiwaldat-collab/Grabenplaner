"use strict";

const {
  UI_PREFERENCES_STATEMENTS,
} = require("../statements/ui-preferences");

const SQLITE_UI_PREFERENCES_CATALOG = Object.freeze([
  Object.freeze({
    statement: UI_PREFERENCES_STATEMENTS.list,
    sql: `
      SELECT preference_key AS preferenceKey, value
      FROM portal_user_preferences
      WHERE employee_number = $employeeNumber
      ORDER BY preference_key COLLATE NOCASE
    `,
    returning: false,
  }),
  Object.freeze({
    statement: UI_PREFERENCES_STATEMENTS.get,
    sql: `
      SELECT preference_key AS preferenceKey, value
      FROM portal_user_preferences
      WHERE employee_number = $employeeNumber
        AND preference_key = $preferenceKey
      LIMIT 1
    `,
    returning: false,
  }),
  Object.freeze({
    statement: UI_PREFERENCES_STATEMENTS.upsert,
    sql: `
      INSERT INTO portal_user_preferences (
        employee_number,
        preference_key,
        value,
        updated_at
      )
      VALUES (
        $employeeNumber,
        $preferenceKey,
        $value,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(employee_number, preference_key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `,
    returning: false,
  }),
  Object.freeze({
    statement: UI_PREFERENCES_STATEMENTS.delete,
    sql: `
      DELETE FROM portal_user_preferences
      WHERE employee_number = $employeeNumber
        AND preference_key = $preferenceKey
    `,
    returning: false,
  }),
]);

module.exports = {
  SQLITE_UI_PREFERENCES_CATALOG,
};
