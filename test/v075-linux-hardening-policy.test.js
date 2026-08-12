"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const helperPath = path.join(root, "server-tools", "linux", "hardening", "lib", "hardening-policy.js");
const policy = require(helperPath);
const journaldTemplate = fs.readFileSync(path.join(
  root,
  "server-tools", "linux", "hardening", "templates", "60-grabenplaner-journald.conf",
), "utf8");
const journaldManagedPath = "/etc/systemd/journald.conf.d/zz-grabenplaner-journald.conf";

function mergedJournald(...fragments) {
  return fragments.map(({ source, body }) => `# ${source}\n${body.trim()}\n`).join("\n");
}

test("v0.75 hardening policy strictly parses IPv4 and IPv6 addresses", () => {
  assert.equal(policy.parseIpAddress("192.0.2.17").family, 4);
  assert.equal(policy.parseIpAddress("2001:db8::17").family, 6);
  assert.equal(policy.parseIpAddress("::ffff:192.0.2.17").family, 6);

  for (const invalid of [
    " 192.0.2.17", "192.0.2.17 ", "192.00.2.17", "192.0.2.256",
    "192.0.2", "2001:db8:::17", "2001:db8::17%eth0", "", null,
  ]) assert.throws(() => policy.parseIpAddress(invalid), /invalid/);
});

test("v0.75 CIDR matching covers both address families without cross-family matches", () => {
  assert.equal(policy.isIpInCidr("192.0.2.42", "192.0.2.99/24"), true);
  assert.equal(policy.isIpInCidr("192.0.3.42", "192.0.2.0/24"), false);
  assert.equal(policy.isIpInCidr("2001:db8:1::42", "2001:db8:1::99/64"), true);
  assert.equal(policy.isIpInCidr("2001:db8:2::42", "2001:db8:1::/64"), false);
  assert.equal(policy.isIpInCidr("192.0.2.42", "::ffff:192.0.2.0/120"), false);
  assert.equal(policy.isIpInCidr("::ffff:192.0.2.42", "::ffff:192.0.2.0/120"), true);

  for (const invalid of [
    "192.0.2.0", "192.0.2.0/", "192.0.2.0/033", "192.0.2.0/33",
    "2001:db8::/129", "2001:db8:://64", " 2001:db8::/64",
  ]) assert.throws(() => policy.parseCidr(invalid), /invalid/);
});

test("v0.75 validates every configured source before evaluating the allowlist", () => {
  assert.equal(policy.isClientAllowed("203.0.113.8", ["192.0.2.0/24", "203.0.113.8/32"]), true);
  assert.equal(policy.isClientAllowed("203.0.113.8", ["192.0.2.0/24", "2001:db8::/32"]), false);
  assert.equal(policy.isClientAllowed("203.0.113.8", []), false);
  assert.throws(
    () => policy.isClientAllowed("203.0.113.8", ["203.0.113.8/32", "not-a-source"]),
    /invalid/,
  );
  assert.throws(
    () => policy.validateAllowedSources(["203.0.113.0/24", "203.0.113.99/24"]),
    /invalid/,
    "Semantisch gleiche Netze muessen als Duplikat abgewiesen werden.",
  );
  assert.equal(policy.validateAllowedSources(Array.from({ length: 64 }, (_, index) => `10.0.${index}.0/24`)).length, 64);
  assert.throws(
    () => policy.validateAllowedSources(Array.from({ length: 65 }, (_, index) => `10.0.${index}.0/24`)),
    /invalid/,
  );
});

test("v0.75 restricts ports, administrative usernames and transaction identifiers", () => {
  for (const port of [1, 22, 65_535, "1", "443", "65535"]) assert.equal(policy.isValidPort(port), true);
  for (const port of [0, 65_536, 1.5, "0", "01", "65536", " 22", null]) {
    assert.equal(policy.isValidPort(port), false);
  }
  for (const port of [22, 2222, "22", "2222"]) assert.equal(policy.isValidSshPort(port), true);
  for (const port of [80, 443, 3000, "80", "443", "3000"]) assert.equal(policy.isValidSshPort(port), false);

  for (const username of ["admin", "grabenplaner-admin", "it_admin", "_service1"]) {
    assert.equal(policy.isValidAdminUsername(username), true);
  }
  for (const username of ["root", "Root", "9admin", "admin.name", "admin$", "a".repeat(33), " admin"] ) {
    assert.equal(policy.isValidAdminUsername(username), false);
  }

  const transactionId = "0123456789abcdef".repeat(4);
  assert.equal(policy.isValidTransactionId(transactionId), true);
  for (const invalid of [transactionId.toUpperCase(), transactionId.slice(1), `${transactionId}0`, "g".repeat(64), null]) {
    assert.equal(policy.isValidTransactionId(invalid), false);
  }
});

test("v0.75 journald policy accepts Ubuntu 24 and Ubuntu 26 vendor ordering only when the managed values win", () => {
  const managed = { source: journaldManagedPath, body: journaldTemplate };
  const ubuntu24 = mergedJournald(
    { source: "/etc/systemd/journald.conf", body: "[Journal]\nStorage=auto" },
    managed,
  );
  assert.deepEqual(policy.validateJournaldConfiguration({
    mergedConfig: ubuntu24,
    template: journaldTemplate,
    managedPath: journaldManagedPath,
  }), { configuredCount: 10, managedAssignmentsLast: true });

  const ubuntu26 = mergedJournald(
    { source: "/etc/systemd/journald.conf", body: "[Journal]\nStorage=auto" },
    {
      source: "/usr/lib/systemd/journald.conf.d/syslog.conf",
      body: "[Journal]\nForwardToSyslog=yes",
    },
    managed,
    {
      source: "/etc/systemd/journald.conf.d/zzz-unrelated.conf",
      body: "[Journal]\nMaxLevelStore=info",
    },
  );
  assert.doesNotThrow(() => policy.validateJournaldConfiguration({
    mergedConfig: ubuntu26,
    template: journaldTemplate,
    managedPath: journaldManagedPath,
  }));
});

test("v0.75 journald policy rejects later overrides and malformed managed fragments", () => {
  const prefix = [
    { source: "/etc/systemd/journald.conf", body: "[Journal]\nStorage=auto" },
    {
      source: "/usr/lib/systemd/journald.conf.d/syslog.conf",
      body: "[Journal]\nForwardToSyslog=yes",
    },
  ];
  const managed = { source: journaldManagedPath, body: journaldTemplate };
  const validate = (mergedConfig, template = journaldTemplate, managedPath = journaldManagedPath) => (
    policy.validateJournaldConfiguration({ mergedConfig, template, managedPath })
  );

  for (const value of ["yes", "no"]) {
    assert.throws(() => validate(mergedJournald(
      ...prefix,
      managed,
      {
        source: "/etc/systemd/journald.conf.d/zzz-foreign.conf",
        body: `[Journal]\nForwardToSyslog=${value}`,
      },
    )), /overridden later/);
  }

  assert.throws(() => validate(mergedJournald(...prefix)), /missing or duplicated/);
  assert.throws(() => validate(mergedJournald(...prefix, managed, managed)), /missing or duplicated/);
  assert.throws(() => validate(
    mergedJournald(...prefix, {
      source: journaldManagedPath,
      body: journaldTemplate.replace("ForwardToSyslog=no", "ForwardToSyslog=yes"),
    }),
  ), /invalid or overridden/);
  assert.throws(() => validate(
    mergedJournald(...prefix, managed),
    `${journaldTemplate}\nForwardToSyslog=no\n`,
  ), /template is invalid/);
  for (const invalidPath of ["relative.conf", "/etc/../bad.conf", "/etc//bad.conf", `${journaldManagedPath}\n`]) {
    assert.throws(() => validate(mergedJournald(...prefix, managed), journaldTemplate, invalidPath), /path is invalid/);
  }
});

test("v0.75 UFW policy accepts only exact managed ingress and preserves foreign semantics", () => {
  const source = "203.0.113.0/24";
  const base = "Added user rules (see 'ufw status' for running firewall):\nufw allow 9100/tcp";
  const added = `${base}\nufw allow proto tcp from ${source} to any port 22 comment 'Grabenplaner managed SSH'\nufw allow 80/tcp comment 'Grabenplaner managed HTTP'\nufw allow 443/tcp comment 'Grabenplaner managed HTTPS'`;
  const status = `Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), deny (routed)\n\n22/tcp ALLOW IN ${source}\n80/tcp ALLOW IN Anywhere\n443/tcp ALLOW IN Anywhere\n9100/tcp ALLOW IN Anywhere`;
  assert.equal(policy.validateUfwPolicy({
    addedRules: added, status, sshPort: 22, allowedSources: [source], requireComplete: true,
    baselineAddedRules: base,
  }).complete, true);

  const partial = `${base}\nufw allow proto tcp from ${source} to any port 22 comment 'Grabenplaner managed SSH'`;
  assert.equal(policy.validateUfwPolicy({
    addedRules: partial, status: "Status: inactive", sshPort: 22, allowedSources: [source],
    baselineAddedRules: base,
  }).configuredCount, 1, "Der Zustand direkt nach der ersten UFW-Mutation bleibt beweisbar.");

  for (const unsafe of [
    `${added}\nufw allow 3000/tcp`,
    `${added}\nufw allow 22/tcp`,
    `${added}\nufw allow proto tcp from 198.51.100.0/24 to any port 22`,
    `${added}\nufw deny 22/tcp`,
    `${added}\nufw allow 9200/tcp`,
  ]) assert.throws(() => policy.validateUfwPolicy({
    addedRules: unsafe, status, sshPort: 22, allowedSources: [source], baselineAddedRules: base,
  }), /invalid|changed|not allowed/);
});

test("v0.75 UFW policy accepts Ubuntu 26.04's fail-closed disabled routed state", () => {
  const source = "178.165.178.81/32";
  const added = `Added user rules (see 'ufw status' for running firewall):
ufw allow from 178.165.178.81 to any port 22 proto tcp comment 'Grabenplaner managed SSH'
ufw allow 80/tcp comment 'Grabenplaner managed HTTP'
ufw allow 443/tcp comment 'Grabenplaner managed HTTPS'`;
  const status = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    178.165.178.81             # Grabenplaner managed SSH
80/tcp                     ALLOW IN    Anywhere                   # Grabenplaner managed HTTP
443/tcp                    ALLOW IN    Anywhere                   # Grabenplaner managed HTTPS
80/tcp (v6)                ALLOW IN    Anywhere (v6)              # Grabenplaner managed HTTP
443/tcp (v6)               ALLOW IN    Anywhere (v6)              # Grabenplaner managed HTTPS`;
  const ufwDefaults = `IPV6=yes
DEFAULT_INPUT_POLICY="DROP"
DEFAULT_OUTPUT_POLICY="ACCEPT"
DEFAULT_FORWARD_POLICY="DROP"
DEFAULT_APPLICATION_POLICY="SKIP"`;

  assert.deepEqual(policy.validateUfwPolicy({
    addedRules: added,
    status,
    sshPort: 22,
    allowedSources: [source],
    requireComplete: true,
    ufwDefaults,
  }), { configuredCount: 3, effectiveCount: 3, complete: true });

  for (const routedPolicy of ["allow", "reject", "skip"]) {
    assert.throws(() => policy.validateUfwPolicy({
      addedRules: added,
      status: status.replace("disabled (routed)", `${routedPolicy} (routed)`),
      sshPort: 22,
      allowedSources: [source],
      requireComplete: true,
      ufwDefaults,
    }), /invalid/);
  }

  for (const invalidDefaults of [
    ufwDefaults.replace('DEFAULT_FORWARD_POLICY="DROP"', 'DEFAULT_FORWARD_POLICY="ACCEPT"'),
    ufwDefaults.replace('DEFAULT_FORWARD_POLICY="DROP"\n', ""),
    `${ufwDefaults}\nDEFAULT_FORWARD_POLICY="DROP"`,
  ]) {
    assert.throws(() => policy.validateUfwPolicy({
      addedRules: added,
      status,
      sshPort: 22,
      allowedSources: [source],
      requireComplete: true,
      ufwDefaults: invalidDefaults,
    }), /invalid/);
  }
});

test("hardening v3 UFW policy adopts exact host maintenance sources and the Tailscale SSH interface", () => {
  const baseSources = ["203.0.113.10/32", "203.0.113.11/32"];
  const maintenanceSources = ["198.51.100.20/32"];
  const added = `Added user rules (see 'ufw status' for running firewall):
ufw allow in on tailscale0 to any port 22 proto tcp comment 'private overlay SSH'
ufw allow from 203.0.113.10 to any port 22 proto tcp comment 'Grabenplaner managed SSH'
ufw allow 80/tcp comment 'Grabenplaner managed HTTP'
ufw allow 443/tcp comment 'Grabenplaner managed HTTPS'
ufw allow from 203.0.113.11 to any port 22 proto tcp
ufw allow from 198.51.100.20 to any port 22 proto tcp`;
  const status = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), deny (routed)

22/tcp on tailscale0 ALLOW IN Anywhere
22/tcp ALLOW IN 203.0.113.10
80/tcp ALLOW IN Anywhere
443/tcp ALLOW IN Anywhere
22/tcp ALLOW IN 203.0.113.11
22/tcp ALLOW IN 198.51.100.20
80/tcp (v6) ALLOW IN Anywhere (v6)
443/tcp (v6) ALLOW IN Anywhere (v6)
22/tcp (v6) on tailscale0 ALLOW IN Anywhere (v6)`;

  assert.deepEqual(policy.validateUfwPolicy({
    addedRules: added,
    status,
    sshPort: 22,
    allowedSources: baseSources,
    maintenanceSources,
    allowedSshInterfaces: ["tailscale0"],
    requireComplete: true,
  }), { configuredCount: 6, effectiveCount: 6, complete: true });

  assert.equal(policy.validateMaintenanceSources(maintenanceSources, { requireNonEmpty: true }).length, 1);
  assert.deepEqual(policy.validateSshInterfaces(["tailscale0"], { requireNonEmpty: true }), ["tailscale0"]);

  for (const invalidSource of ["198.51.100.0/24", "2001:db8::/64", "198.51.100.20"]) {
    assert.throws(() => policy.validateMaintenanceSources([invalidSource]), /invalid|exact host/);
  }
  for (const invalidInterface of ["eth0", "tailscale1", "tailscale0;bad", " tailscale0", ""]) {
    assert.throws(() => policy.validateSshInterfaces([invalidInterface]), /invalid/);
  }

  for (const unsafeAdded of [
    added.replace("on tailscale0", "on eth0"),
    added.replace("allow in on tailscale0", "allow in on tailscale0 from 198.51.100.9"),
    `${added}\nufw allow 22/tcp`,
  ]) {
    assert.throws(() => policy.validateUfwPolicy({
      addedRules: unsafeAdded,
      status,
      sshPort: 22,
      allowedSources: baseSources,
      maintenanceSources,
      allowedSshInterfaces: ["tailscale0"],
      requireComplete: true,
    }), /invalid|not allowed/);
  }

  assert.throws(() => policy.validateUfwPolicy({
    addedRules: added,
    status: status.replace(/^22\/tcp(?: \(v6\))? on tailscale0.*(?:\n|$)/gm, ""),
    sshPort: 22,
    allowedSources: baseSources,
    maintenanceSources,
    allowedSshInterfaces: ["tailscale0"],
    requireComplete: true,
  }), /missing/);
});

test("v0.75 UFW denial fixtures fail closed for broad, intersecting ranges and profiles", () => {
  const source = "203.0.113.0/24";
  const safeBase = "Added user rules (see 'ufw status' for running firewall):\nufw deny 25/tcp";
  const managed = `ufw allow proto tcp from ${source} to any port 22\nufw allow 80/tcp\nufw allow 443/tcp`;
  const safeStatus = `Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), deny (routed)\n22/tcp ALLOW IN ${source}\n80/tcp ALLOW IN Anywhere\n443/tcp ALLOW IN Anywhere\n25/tcp DENY IN Anywhere`;
  assert.doesNotThrow(() => policy.validateUfwPolicy({
    addedRules: `${safeBase}\n${managed}`,
    status: safeStatus,
    sshPort: 22,
    allowedSources: [source],
    baselineAddedRules: safeBase,
    requireComplete: true,
  }));

  for (const configuredRule of [
    "ufw deny from any",
    "ufw reject 1:100/tcp",
    "ufw deny proto tcp from any to any port 400:500",
    "ufw deny 'OpenSSH'",
    "ufw reject 'WWW Full' comment 'harmless 9100'",
  ]) {
    const baseline = `Added user rules (see 'ufw status' for running firewall):\n${configuredRule}`;
    assert.throws(() => policy.validateUfwPolicy({
      addedRules: `${baseline}\n${managed}`,
      status: safeStatus,
      sshPort: 22,
      allowedSources: [source],
      baselineAddedRules: baseline,
    }), /invalid/);
  }

  for (const effectiveRule of [
    "Anywhere DENY IN Anywhere",
    "1:100/tcp REJECT IN Anywhere",
    "400:500/tcp DENY IN Anywhere",
    "OpenSSH DENY IN Anywhere",
  ]) assert.throws(() => policy.validateUfwPolicy({
    addedRules: `${safeBase}\n${managed}`,
    status: `${safeStatus}\n${effectiveRule}`,
    sshPort: 22,
    allowedSources: [source],
    baselineAddedRules: safeBase,
  }), /invalid/);
});

test("v0.75 UFW baseline preserves ordered foreign signatures but ignores comments", () => {
  const source = "203.0.113.0/24";
  const header = "Added user rules (see 'ufw status' for running firewall):";
  const baseline = `${header}\nufw allow 9100/tcp comment 'Grabenplaner managed HTTPS'\nufw deny 25/tcp comment 'first'`;
  const managed = `ufw allow proto tcp from ${source} to any port 22 comment 'anything'\nufw allow 80/tcp\nufw allow 443/tcp`;
  const status = `Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), deny (routed)\n22/tcp ALLOW IN ${source}\n80/tcp ALLOW IN Anywhere\n443/tcp ALLOW IN Anywhere\n9100/tcp ALLOW IN Anywhere\n25/tcp DENY IN Anywhere`;

  const commentsChanged = `${header}\nufw allow 9100/tcp comment 'not a managed rule'\nufw deny 25/tcp comment 'second'\n${managed}`;
  assert.equal(policy.validateUfwPolicy({
    addedRules: commentsChanged,
    status,
    sshPort: 22,
    allowedSources: [source],
    baselineAddedRules: baseline,
    requireComplete: true,
  }).configuredCount, 3, "Comments must neither classify rules nor create foreign drift.");

  const reordered = `${header}\nufw deny 25/tcp\nufw allow 9100/tcp\n${managed}`;
  assert.throws(() => policy.validateUfwPolicy({
    addedRules: reordered,
    status,
    sshPort: 22,
    allowedSources: [source],
    baselineAddedRules: baseline,
  }), /changed/);
});

test("v0.75 first-rule SIGKILL transition is accepted only with an unchanged foreign baseline", () => {
  const source = "203.0.113.0/24";
  const baseline = "Added user rules (see 'ufw status' for running firewall):\nufw allow 9100/tcp\nufw deny 25/tcp";
  const firstManagedRule = `ufw allow proto tcp from ${source} to any port 22 comment 'Grabenplaner managed SSH'`;
  assert.equal(policy.validateUfwPolicy({
    addedRules: `${baseline}\n${firstManagedRule}`,
    status: "Status: inactive",
    sshPort: 22,
    allowedSources: [source],
    baselineAddedRules: baseline,
  }).configuredCount, 1);

  const drifted = `Added user rules (see 'ufw status' for running firewall):\nufw deny 25/tcp\nufw allow 9100/tcp\n${firstManagedRule}`;
  assert.throws(() => policy.validateUfwPolicy({
    addedRules: drifted,
    status: "Status: inactive",
    sshPort: 22,
    allowedSources: [source],
    baselineAddedRules: baseline,
  }), /changed/);
});

test("v0.75 validate-session CLI emits only redacted session facts", () => {
  const client = "203.0.113.41";
  const firstSource = "192.0.2.0/24";
  const matchingSource = "203.0.113.0/24";
  const result = spawnSync(process.execPath, [
    helperPath, "validate-session", "--client", client,
    "--source", firstSource, matchingSource,
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { sourceCount: 2, clientMatched: true });
  assert.equal(result.stderr, "");
  for (const sensitive of [client, firstSource, matchingSource]) {
    assert.equal(result.stdout.includes(sensitive), false);
    assert.equal(result.stderr.includes(sensitive), false);
  }
});

test("v0.75 validate-session CLI fails closed without echoing malformed input", () => {
  const malformed = "SECRET-invalid-source";
  const result = spawnSync(process.execPath, [
    helperPath, "validate-session", "--client=203.0.113.41", `--source=${malformed}`,
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), { sourceCount: 1, clientMatched: false });
  assert.equal(result.stderr.includes(malformed), false);
});

test("v0.75 validate-transaction CLI is redacted and fails closed", () => {
  const transactionId = "0123456789abcdef".repeat(4);
  const accepted = spawnSync(process.execPath, [helperPath, "validate-transaction", transactionId], { encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), { transactionValid: true });
  assert.equal(accepted.stderr, "");
  assert.equal(accepted.stdout.includes(transactionId), false);

  const malformed = "SECRET-not-a-transaction";
  const rejected = spawnSync(process.execPath, [helperPath, "validate-transaction", malformed], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stdout, "");
  assert.deepEqual(JSON.parse(rejected.stderr), { transactionValid: false });
  assert.equal(rejected.stderr.includes(malformed), false);
});
