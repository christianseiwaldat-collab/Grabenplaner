"use strict";

// Synthetic loopback-only process. An uncaught decoder error must terminate it,
// so this fixture deliberately has no uncaughtException/error-swallowing hook.
const path = require("node:path");
const { createRequire } = require("node:module");
const graphRequire = createRequire(path.join(path.resolve(process.argv[2]), "package.json"));
const express = graphRequire("express");
const app = express();
const parsers = {
  json: express.json({ limit: "1kb" }),
  raw: express.raw({ type: "application/octet-stream", limit: "1kb" }),
  text: express.text({ limit: "1kb" }),
  urlencoded: express.urlencoded({ extended: false, limit: "1kb" }),
};
app.get("/health", (_request, response) => response.json({ ok: true }));
for (const [name, parser] of Object.entries(parsers)) {
  app.post(`/${name}`, parser, (request, response) => {
    response.json(Buffer.isBuffer(request.body) ? { hex: request.body.toString("hex") } : request.body);
  });
}
app.use((error, _request, response, _next) => {
  response.status(error.status || 500).json({ code: error.type || "parser.error" });
});
const server = app.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
