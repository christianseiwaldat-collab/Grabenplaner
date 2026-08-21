const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("Dienstplan-PDF trennt Wochentage deutlicher als interne Mitarbeiterspalten", () => {
  assert.match(serverSource, /const dayGap = 5;/);
  assert.match(serverSource, /const dayFrameWidth = 0\.55;/);
  assert.match(serverSource, /const daySeparatorWidth = 1\.1;/);
  assert.match(serverSource, /lineWidth\(0\.25\).*moveTo\(x, gridTop\).*lineTo\(x, gridBottom\)/s);
  assert.match(
    serverSource,
    /for \(let dayIndex = 0; dayIndex < dayCount - 1; dayIndex \+= 1\).*?const separatorX = dayX\(dayIndex\) \+ dayWidth \+ dayGap \/ 2;.*?moveTo\(separatorX, dayHeaderY\).*?lineTo\(separatorX, gridBottom\)/s,
  );
});
