# Synthetic authentication and session audit probe

Run explicitly from the repository root with Node.js and the installed project dependencies:

```powershell
node test-support/security-audit/session-audit.probe.cjs <absolute-output-json-path-outside-the-repository>
```

The probe creates a fresh temporary SQLite application fixture with synthetic people and credentials. It replaces inherited application/persistence configuration in its own process, binds only to `127.0.0.1` on an ephemeral port, and removes its owned temporary directory afterwards. It never needs production data, real credentials, a VPS connection, or a PostgreSQL server.

The local HTTP requests carry the application's trusted-proxy HTTPS header. This verifies application behavior in configured server mode; it does not verify TLS, a real reverse proxy, or production deployment configuration. The scanner fixture is synthetic and does not test an antivirus engine.

The output records sanitized observations, statuses and counters, without passwords, cookies, token values, or personal data. Exit code zero means the probe completed. An `observed_gap` describes a difference from the stated probe expectation; it is not automatically an ASVS requirement failure. In particular, rotation of a copied current-session cookie after password change must be distinguished from terminating **other** sessions under ASVS 7.4.3.

The session-age probe backdates the fixture's database timestamps. It is a deterministic age-boundary check, not a long-duration soak. The failed-login concurrency probe sends eight simultaneous requests against one synthetic account; it does not establish that all other throttling layers are absent or bypassed.

This is an opt-in audit instrument, not a product behavior fix and not part of the default passing-test claim. Infrastructure/fixture failures exit nonzero. Keep result JSON and audit findings in a private output directory and assess them against the pinned ASVS version and the exact tested commit.

## Audit register and browser verification

The application exposes the register at **Datenschutz > Security Audits**. Personal admin/IT-admin accounts require explicit `security_audits:read` and, for import or finding updates, `security_audits:manage`; the developer role retains its existing all-permissions semantics. Local-system and organization accounts cannot access it. API authorization is revalidated inside each persistence transaction.

The unmodified, attributed ASVS 5.0.0 catalogue is public standard content. Actual assessments are **not** bundled with the application. Import a privately prepared report through the UI after reviewing its preview. `lib/security-audit-core.js` validates the version-bound schema; `test-support/security-audit-fixture.js` contains a synthetic example. The ledger is encrypted using existing AMU storage, excluded from public settings, and paired with an atomic value-free audit receipt. Its hash chain detects inconsistent history; it is not an external signature or independent proof of assessment accuracy. Keep ordinary protected backups and their key-recovery process in place.

An import is immutable. Later finding decisions append history and do not rewrite the original ASVS results. Closing a finding requires a retest reference; risk acceptance requires a responsible person, a reason and a future expiry date. It remains valid through that date in Europe/Vienna; after midnight the display marks it expired. A corrected assessment is a new, uniquely identified report. There is no silent overwrite or deletion command.

Run the isolated full-app browser probe explicitly with an available Playwright installation and Chrome/Chromium:

```powershell
$env:GP_BROWSER_TEST_MODULE = '<absolute-path-to-playwright>'
$env:GP_BROWSER_EXECUTABLE = '<absolute-path-to-chrome>'
node test-support/security-audit/ui-audit.probe.cjs <absolute-private-output-directory> [absolute-private-report-json]
```

Without the optional report argument it uses synthetic findings. It creates and removes its own synthetic SQLite database and browser context, imports through the real UI, and writes screenshots outside the repository. The optional report is imported **only into this temporary fixture**, never into an existing application installation. Screenshots containing a real report are confidential. These checks do not prove production deployment or PostgreSQL runtime behavior.

Focused feature checks:

```powershell
node --test --test-concurrency=1 test/security-audit-core.test.js test/security-audit-integration.test.js test/security-audits-ui.test.js test/privacy-organization-navigation.test.js
```

The ops header and dependency reachability probes in this directory are also opt-in. `ops-lockfile-advisories.js` queries public registry advisory metadata; its result needs manual applicability review and is not an exploitability verdict. Run external lookups only as an explicit audit step, not when someone opens the register.

```powershell
node --test test-support/security-audit/ops-headers.probe.cjs test-support/security-audit/ops-dependency-reachability.probe.cjs
```

The `.probe.cjs` suffix deliberately excludes these observation probes from automatic product-test discovery. A successful probe may reproduce a known weakness; it must not be interpreted as a passing security requirement.

## Atomic login regression checks

The regular regression tests exercise the current conditional login statements and their transaction boundaries:

```powershell
node --test --test-concurrency=1 test/portal-login-security.test.js test/portal-login-concurrency.test.js test/portal-login-multiconnection.test.js test/portal-login-concurrency-api.test.js test/authentication-catalog-qualification.test.js
```

SQLite tests use fresh synthetic databases. The multiconnection test starts eight independent native connections to one temporary database. The HTTP test retains real scrypt calculations and coordinates callback delivery to reproduce overlapping requests deterministically. These tests cover account-wide counters shared by browser and mobile, active and expired locks, successful login resets, credential changes, transaction rollback, and session creation/revocation.

The PostgreSQL variants require the existing isolated development Core/Sales fixture (`GP_CORE_APP_URL`, `GP_CORE_READER_URL`, `GP_CORE_MIGRATOR_URL` and their `GP_SALES_*` counterparts). They run against the real provider, reviewed SQL catalogue and versioned migrations. Only use a fresh, owned local development cluster: the fixture verifies its development identity and empty tables, seeds synthetic records, and removes its own records afterward. Without that environment the PostgreSQL cases are explicitly skipped, not counted as PostgreSQL evidence.

Failed attempts increment the current database counter only for the verified credential generation. Active locks remain unchanged; the first failure after expiry starts a new window. Success and session writes share a serializable transaction. A later committed failure can therefore become the first failure after success. Password reset replaces the hash and invalidates old in-flight attempts; administrative unlock without a password change does not create a new credential generation. Retry is limited to transactions explicitly classified as rolled back; uncertain connection outcomes are not retried automatically.

## Linux runtime qualification

Use a fresh, owned Linux x64 glibc test environment with synthetic data. Copy the reviewed source and lockfile without production configuration or an existing `node_modules` directory. The installation must match the server's dependency layout:

```sh
pnpm install --prod --frozen-lockfile --config.node-linker=hoisted --store-dir /absolute/owned/store --package-import-method=copy
node test-support/security-audit/linux-native-runtime.probe.cjs --output /absolute/private-output/linux-native-runtime.json
node --test --test-concurrency=1 test-support/security-audit/ops-dependency-remediation.probe.cjs
```

Use the package manager version pinned in `package.json`. Record the guest OS, kernel, CPU architecture, libc, Node ABI, installed native library versions, source hashes, lockfile hash, test exit codes and cleanup. The native probe requires actual Linux native modules; a WASM fallback is not equivalent evidence. Run the existing image/PDF and authentication regressions in the same installation. PostgreSQL cases without the isolated database fixture remain explicitly skipped and cannot be counted as Linux PostgreSQL validation.

Keep each qualification receipt outside the repository. A passing local Linux run establishes the tested candidate's behavior in that guest; production rollout and production verification remain separate states. Earlier audit snapshots remain immutable.
