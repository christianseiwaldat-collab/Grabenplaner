"use strict";
const {execFile} = require("node:child_process");

function executeUpdateCommand(command, args, {signal, timeout = 15000, execute = execFile} = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let result, failure;
    const child = execute(command, args, {
      signal, timeout, windowsHide: true, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout) => { failure = error; result = stdout; });
    // AbortError can reach execFile's callback before the process has exited.
    // The request drain owns the process and its pipes until close, not merely
    // until the callback rejects the command.
    child.once("close", () => {
      if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else resolve(result);
    });
  });
}

module.exports = {executeUpdateCommand};
