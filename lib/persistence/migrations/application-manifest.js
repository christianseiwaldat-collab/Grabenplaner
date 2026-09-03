"use strict";

const {
  defineMigrationManifest,
} = require("./contract");

const APPLICATION_MIGRATION_OPERATION_CONTEXT_VERSION = 1;
const APPLICATION_MIGRATION_RUNTIME_CONTEXT_KEY = "applicationMigrations";

const APPLICATION_MIGRATION_MANIFEST = defineMigrationManifest({
  id: "grabenplaner.application",
  migrations: [
    {
      id: "stage.startup-compatibility",
      description: "Startkritische Schema- und Integritätsmigrationen ausführen",
      operations: ["application.startup-compatibility.run"],
      rollbackOperations: null,
    },
    {
      id: "stage.application-schema",
      description: "Kanonisches Anwendungsschema sicherstellen",
      operations: ["application.schema.ensure"],
      rollbackOperations: null,
    },
    {
      id: "stage.protected-records",
      description: "Geschützte Personal- und Urlaubshistorien migrieren",
      operations: ["application.protected-records.run"],
      rollbackOperations: null,
    },
    {
      id: "stage.historical-compatibility",
      description: "Historische Anwendungsstrukturen verlustfrei aktualisieren",
      operations: ["application.historical-compatibility.run"],
      rollbackOperations: null,
    },
    {
      id: "stage.application-defaults",
      description: "Providerunabhängige Anwendungsgrundwerte einspielen",
      operations: ["application.defaults.seed"],
      rollbackOperations: null,
    },
    {
      id: "stage.feature-compatibility",
      description: "Featurebezogene Kompatibilitätsmarker und Defaults aktualisieren",
      operations: ["application.feature-compatibility.run"],
      rollbackOperations: null,
    },
    {
      id: "stage.organization-schema",
      description: "Organisations- und Kostenstellenstruktur aktualisieren",
      operations: ["application.organization-schema.run"],
      rollbackOperations: null,
    },
    {
      id: "stage.optional-demo-profile",
      description: "Optionales synthetisches Demoprofil einspielen",
      operations: ["application.demo-profile.seed"],
      rollbackOperations: null,
    },
    {
      id: "stage.system-center-schema",
      description: "Schema für System-Center-Vertrauensmetriken sicherstellen",
      operations: ["application.system-center-schema.ensure"],
      rollbackOperations: null,
    },
    {
      id: "stage.branch-orders-schema",
      description: "Schema für Filialbestellungen sicherstellen",
      operations: ["application.branch-orders-schema.ensure"],
      rollbackOperations: null,
    },
  ],
});

const APPLICATION_MIGRATION_OPERATION_IDS = Object.freeze(
  APPLICATION_MIGRATION_MANIFEST.migrations
    .flatMap((migration) => migration.operations),
);

module.exports = {
  APPLICATION_MIGRATION_MANIFEST,
  APPLICATION_MIGRATION_OPERATION_IDS,
  APPLICATION_MIGRATION_OPERATION_CONTEXT_VERSION,
  APPLICATION_MIGRATION_RUNTIME_CONTEXT_KEY,
};
