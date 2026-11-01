"use strict";

// Keep the historical entrypoint name for installed task references. It always
// uses the qualified PostgreSQL pair and cannot open a SQLite database file.
require("./persistence/postgresql/reporting/worker");
