'use strict';
try { require('../../lib/security-release-inventory').cli(); }
catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
