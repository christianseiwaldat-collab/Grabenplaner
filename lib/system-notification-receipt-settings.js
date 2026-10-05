"use strict";
const PREFIX = "system_notification_receipt_";
const KEY = `${PREFIX}email_v1`;
const isSystemNotificationReceiptSettingKey = key => typeof key === "string" && key.startsWith(PREFIX);
module.exports = {KEY, isSystemNotificationReceiptSettingKey};
