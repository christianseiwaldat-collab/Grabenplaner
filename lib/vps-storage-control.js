'use strict';
const net = require('node:net');
const lifecycle = require('./persistence/postgresql/lifecycle-control');
const C = require('./vps-storage-contract');
function requestControl(input) {
  const request = C.validateRequest({ format: C.FORMAT, ...input });
  if (!lifecycle.available()) throw new Error('VPS_STORAGE_CONTROL_UNAVAILABLE');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(lifecycle.SOCKET);
    let bytes = 0, body = '', done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('VPS_STORAGE_CONTROL_TIMEOUT')), 15000);
    socket.on('connect', () => socket.end(JSON.stringify(request) + '\n'));
    socket.on('error', () => finish(new Error('VPS_STORAGE_CONTROL_UNAVAILABLE')));
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 32768) return finish(new Error('VPS_STORAGE_RESPONSE_INVALID'));
      body += chunk.toString('utf8'); if (!body.includes('\n')) return;
      try {
        const value = JSON.parse(body.trim());
        if (value.format !== C.FORMAT || value.requestId !== request.requestId || value.action !== request.action
            || value.accepted !== true) throw new Error(value.code || 'VPS_STORAGE_RESPONSE_INVALID');
        finish(null, value);
      } catch (error) { finish(error); }
    });
    socket.on('end', () => { if (!done) finish(new Error('VPS_STORAGE_RESPONSE_INVALID')); });
  });
}
module.exports = { requestControl };
