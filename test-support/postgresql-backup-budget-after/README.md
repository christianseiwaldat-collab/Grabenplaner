# Historical backup-budget bridge fixture

Source: commit `e4cf9fde0ab91ec459ada98d3223b1f561587c19`. The original frozen module files match the unchanged `after` hashes in `server-tools/linux/lib/postgresql-backup-budget-contract.json`; `package.json.txt` preserves the historical dependency, engine and package-manager metadata, also checked against predecessor commit `503106fa24da31b8194f96b98b4f05fcab269a5a`.

The frozen `lib/persistence/sqlite/data-import-catalog.js` and `lib/persistence/statements/data-import.js` come directly from predecessor commit `503106fa24da31b8194f96b98b4f05fcab269a5a`. Their normalized SHA-256 hashes are respectively `f389eac40d8b6f36ee45f2bacf2f44d188fa5bf7d2c52e8aa9227f1b76613143` and `11a895fc6e5d6fb13ae4b487ab232d5ccf259572d684a0437e8053f3a869037c`, matching both unchanged before/after pins. They isolate this historical bridge from later source-count approval imports.

Only modules that have since changed are duplicated here. The existing `before` fixture and the unchanged pinned dependency files complete the isolated trees. The test verifies every assembled file against the original before/after contract before exercising the bridge. These text files are test data, never product modules or an expanded release bridge. Future incompatible source changes need their original pinned text fixture rather than new bridge pins.
