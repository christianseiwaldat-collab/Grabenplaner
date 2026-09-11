'use strict';
// Sales reporting group explicitly defined by the operator. Source 0/00 also
// denotes the central warehouse; no GP branch or import binding is rewritten.
const ONLINE_LOCATION = Object.freeze({ id: 'tradefoto-online', label: 'Online (00, 70, 90)', sourceIds: ['0', '00', '70', '90'] });
const isOnlineSource = value => ONLINE_LOCATION.sourceIds.includes(String(value ?? '').trim());
module.exports = { ONLINE_LOCATION, isOnlineSource };
