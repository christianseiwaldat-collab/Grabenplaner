"use strict";

const { definePersistenceStatement } = require("../contract");

const UI_PREFERENCES_STATEMENTS = Object.freeze({
  list: definePersistenceStatement({
    id: "ui-preferences.list-by-employee",
    operation: "queryAll",
    parameters: {
      employeeNumber: "text",
    },
    columns: {
      preferenceKey: "text",
      value: "text",
    },
  }),
  get: definePersistenceStatement({
    id: "ui-preferences.get",
    operation: "queryOne",
    parameters: {
      employeeNumber: "text",
      preferenceKey: "text",
    },
    columns: {
      preferenceKey: "text",
      value: "text",
    },
  }),
  upsert: definePersistenceStatement({
    id: "ui-preferences.upsert",
    operation: "execute",
    parameters: {
      employeeNumber: "text",
      preferenceKey: "text",
      value: "text",
    },
  }),
  delete: definePersistenceStatement({
    id: "ui-preferences.delete",
    operation: "execute",
    parameters: {
      employeeNumber: "text",
      preferenceKey: "text",
    },
  }),
});

module.exports = {
  UI_PREFERENCES_STATEMENTS,
};
