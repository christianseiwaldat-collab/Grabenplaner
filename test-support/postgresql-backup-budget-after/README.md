# Historical backup-budget bridge fixture

Source: commit `e4cf9fde0ab91ec459ada98d3223b1f561587c19`. The two frozen module files match the unchanged `after` hashes in `server-tools/linux/lib/postgresql-backup-budget-contract.json`; `package.json.txt` preserves the historical dependency, engine and package-manager metadata, also checked against predecessor commit `503106fa24da31b8194f96b98b4f05fcab269a5a`.

Only modules that have since changed are duplicated here. The existing `before` fixture and the unchanged pinned dependency files complete the isolated trees. The test verifies every assembled file against the original before/after contract before exercising the bridge. These text files are test data, never product modules or an expanded release bridge. Future incompatible source changes need their original pinned text fixture rather than new bridge pins.
