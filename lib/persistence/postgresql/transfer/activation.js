"use strict";

const staging = require("./staging");
const runtime = require("../runtime-binding");
const application = require("../productive-configuration");

function documents({ configuration, promotion, transfer, applicationSha256, activatedAt = new Date().toISOString() }) {
  staging.validateConfiguration(configuration);
  const binding = runtime.validateBinding(promotion?.binding);
  if (promotion.promoted !== true || transfer?.verified !== true || transfer.tables?.length !== 248
      || promotion.contentSha256 !== transfer.contentSha256 || promotion.sourceSha256 !== transfer.sourceSha256
      || binding.clusterId !== configuration.clusterId || !/^[a-f0-9]{64}$/.test(applicationSha256 || "")) {
    throw new Error("PG_ACTIVATION_EVIDENCE_BINDING");
  }
  const app = { format: application.FORMAT, productActivation: true, host: '127.0.0.1', port: 55486,
    binding, sourceSha256: transfer.sourceSha256, applicationSha256, activatedAt,
    accounts: Object.fromEntries(['core', 'sales'].flatMap(domain => ['app', 'reader'].map(purpose => {
      const name = `gp_${domain}_${purpose}`; return [name, configuration.accounts[name]];
    }))) };
  const anchor = { format: 'grabenplaner-postgresql-pair-v1', environmentId: binding.environmentId,
    clusterId: binding.clusterId, sourceSha256: transfer.sourceSha256, applicationSha256 };
  application.resolveDocument(app, anchor);
  const operations = { format: 'grabenplaner-postgresql-operations-v1', mode: 'productive', binding,
    clusterId: binding.clusterId, host: '127.0.0.1', port: 55486,
    sourceFiles: '/var/lib/grabenplaner', environmentFile: '/etc/grabenplaner/grabenplaner.env',
    backupDirectory: '/var/backups/grabenplaner-postgresql', workDirectory: '/var/lib/grabenplaner-postgresql/operations',
    activationReceipt: { productActivation: true, applicationSha256, sourceSha256: transfer.sourceSha256, activatedAt },
    administrator: { role: 'gp_migration_admin', password: configuration.accounts.gp_migration_admin },
    monitor: { role: 'gp_operations_monitor', password: configuration.accounts.gp_operations_monitor },
    recoveryAccounts: { ...configuration.accounts },
    domains: ['core', 'sales'].map(domain => ({ domain, database: 'grabenplaner_' + domain,
      role: `gp_${domain}_migrator`, password: configuration.accounts[`gp_${domain}_migrator`],
      profile: binding.profile, environmentId: binding.environmentId })),
  };
  return { application: app, anchor, operations };
}

module.exports = { documents };
