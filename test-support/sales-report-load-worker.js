'use strict';
// Synthetic CPU load only, for verifying that the real worker client isolates HTTP.
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, input }) => {
  const end = performance.now() + input.milliseconds;
  while (performance.now() < end) Math.sqrt(12345);
  parentPort.postMessage({ id, result: { complete: true } });
});
