"use strict";

const net = require("node:net");

const MAX_PORT = 65_535;
const MAX_ALLOWED_SOURCES = 64;
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{64}$/;
const ADMIN_USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

function requireStrictText(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function parseIpv4Value(address) {
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(address)) {
    throw new TypeError("IP address is invalid.");
  }
  const octets = address.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) throw new TypeError("IP address is invalid.");
  return octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function parseIpv6Value(address) {
  let expanded = address;
  if (expanded.includes(".")) {
    const separator = expanded.lastIndexOf(":");
    if (separator < 0) throw new TypeError("IP address is invalid.");
    const ipv4 = expanded.slice(separator + 1);
    const ipv4Value = parseIpv4Value(ipv4);
    const upper = Number((ipv4Value >> 16n) & 0xffffn).toString(16);
    const lower = Number(ipv4Value & 0xffffn).toString(16);
    expanded = `${expanded.slice(0, separator + 1)}${upper}:${lower}`;
  }

  const compressed = expanded.includes("::");
  const halves = expanded.split("::");
  if (halves.length > 2) throw new TypeError("IP address is invalid.");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((!compressed && missing !== 0) || (compressed && missing < 1)) {
    throw new TypeError("IP address is invalid.");
  }
  const groups = compressed ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    throw new TypeError("IP address is invalid.");
  }
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function parseIpAddress(input) {
  const address = requireStrictText(input, "IP address");
  const family = net.isIP(address);
  if (family === 4) {
    return Object.freeze({ family: 4, bits: 32, value: parseIpv4Value(address) });
  }
  if (family === 6) {
    return Object.freeze({ family: 6, bits: 128, value: parseIpv6Value(address) });
  }
  throw new TypeError("IP address is invalid.");
}

function parseCidr(input) {
  const cidr = requireStrictText(input, "CIDR source");
  const separator = cidr.indexOf("/");
  if (separator <= 0 || separator !== cidr.lastIndexOf("/") || separator === cidr.length - 1) {
    throw new TypeError("CIDR source is invalid.");
  }
  const address = parseIpAddress(cidr.slice(0, separator));
  const prefixText = cidr.slice(separator + 1);
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(prefixText)) throw new TypeError("CIDR source is invalid.");
  const prefixLength = Number(prefixText);
  if (prefixLength > address.bits) throw new TypeError("CIDR source is invalid.");

  const hostBits = BigInt(address.bits - prefixLength);
  const allBits = (1n << BigInt(address.bits)) - 1n;
  const mask = prefixLength === 0 ? 0n : allBits ^ ((1n << hostBits) - 1n);
  return Object.freeze({
    family: address.family,
    bits: address.bits,
    prefixLength,
    network: address.value & mask,
    mask,
  });
}

function isIpInCidr(clientIp, source) {
  const client = parseIpAddress(clientIp);
  const cidr = parseCidr(source);
  return client.family === cidr.family && (client.value & cidr.mask) === cidr.network;
}

function validateAllowedSources(allowedSources, options = {}) {
  if (!Array.isArray(allowedSources) || allowedSources.length > MAX_ALLOWED_SOURCES
    || (options.requireNonEmpty === true && allowedSources.length === 0)) {
    throw new TypeError("Allowed sources are invalid.");
  }
  const parsed = allowedSources.map(parseCidr);
  const unique = new Set();
  for (const source of parsed) {
    const key = `${source.family}:${source.prefixLength}:${source.network.toString(16)}`;
    if (unique.has(key)) throw new TypeError("Allowed sources are invalid.");
    unique.add(key);
  }
  return Object.freeze(parsed);
}

function canonicalSource(input) {
  if (["any", "anywhere", "0.0.0.0/0", "::/0"].includes(String(input).toLowerCase())) return "any";
  if (String(input).includes("/")) {
    const source = parseCidr(input);
    return `${source.family}:${source.prefixLength}:${source.network.toString(16)}`;
  }
  const address = parseIpAddress(input);
  return `${address.family}:${address.bits}:${address.value.toString(16)}`;
}

function parsePortSelector(value, protocol) {
  const match = /^(\d{1,5})(?::(\d{1,5}))?(?:\/(tcp|udp))?$/.exec(value || "");
  if (!match) return null;
  const first = parsePort(match[1]);
  const last = match[2] ? parsePort(match[2]) : first;
  if (last < first) throw new TypeError("UFW rule is invalid.");
  const resolvedProtocol = match[3] || protocol || null;
  if (resolvedProtocol !== null && !["tcp", "udp"].includes(resolvedProtocol)) {
    throw new TypeError("UFW rule is invalid.");
  }
  return Object.freeze({ first, last, protocol: resolvedProtocol });
}

function selectorContains(selector, port) {
  return selector.first <= port && selector.last >= port;
}

function selectorCanAffectTcp(selector, ports) {
  return selector.protocol !== "udp" && ports.some((port) => selectorContains(selector, port));
}

function tokenizeUfwCommand(line) {
  const tokens = line.match(/'[^']*'|"[^"]*"|\S+/g) || [];
  return tokens.map((token) => {
    if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function requireSafeMultiline(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function classifyInboundGrant({ selector, source, destination }, sshPort, allowedSourceKeys) {
  if (!selector) throw new TypeError("UFW rule is invalid.");
  const protectedPorts = [sshPort, 80, 443, 3000];
  if (!selectorCanAffectTcp(selector, protectedPorts)) return null;
  if (selector.first !== selector.last || selector.protocol !== "tcp") {
    throw new TypeError("UFW managed-port rule is invalid.");
  }
  const resolvedPort = selector.first;
  if (!protectedPorts.includes(resolvedPort)) return null;
  if (!['any', 'Anywhere'].includes(destination || "any")) {
    throw new TypeError("UFW managed destination is invalid.");
  }
  const sourceKey = canonicalSource(source || "any");
  if (resolvedPort === 80 || resolvedPort === 443) {
    if (sourceKey !== "any") throw new TypeError("UFW web rule is invalid.");
    return `web:${resolvedPort}`;
  }
  if (resolvedPort === sshPort && allowedSourceKeys.has(sourceKey)) return `ssh:${sourceKey}`;
  throw new TypeError("UFW inbound grant is not allowed.");
}

function indexExactlyOnce(tokens, value) {
  const first = tokens.indexOf(value);
  if (first >= 0 && tokens.indexOf(value, first + 1) >= 0) throw new TypeError("UFW rule is invalid.");
  return first;
}

function configuredRuleDetails(ruleTokens, actionIndex) {
  const portIndex = indexExactlyOnce(ruleTokens, "port");
  const protoIndex = indexExactlyOnce(ruleTokens, "proto");
  const fromIndex = indexExactlyOnce(ruleTokens, "from");
  const toIndex = indexExactlyOnce(ruleTokens, "to");
  const protocol = protoIndex >= 0 ? ruleTokens[protoIndex + 1] : null;
  if (protoIndex >= 0 && !["tcp", "udp"].includes(protocol)) throw new TypeError("UFW rule is invalid.");
  let portToken = portIndex >= 0 ? ruleTokens[portIndex + 1] : null;
  if (!portToken) {
    const candidate = ruleTokens[actionIndex + 1];
    if (candidate && !["in", "out", "from", "to", "proto", "log", "on"].includes(candidate)) {
      portToken = candidate;
    }
  }
  return Object.freeze({
    selector: parsePortSelector(portToken, protocol),
    source: fromIndex >= 0 ? ruleTokens[fromIndex + 1] : "any",
    destination: toIndex >= 0 ? ruleTokens[toIndex + 1] : "any",
  });
}

function analyzeAddedRules(output, sshPort, allowedSourceKeys) {
  const found = new Set();
  const foreign = [];
  for (const rawLine of requireSafeMultiline(output, "UFW added rules").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("ufw ")) continue;
    const tokens = tokenizeUfwCommand(line);
    if (tokens[0] !== "ufw") throw new TypeError("UFW rule is invalid.");
    let index = 1;
    let routed = false;
    if (tokens[index] === "route") { routed = true; index += 1; }
    const action = tokens[index];
    if (!["allow", "limit", "deny", "reject"].includes(action)) throw new TypeError("UFW rule is invalid.");
    const commentIndex = indexExactlyOnce(tokens, "comment");
    if (commentIndex >= 0 && commentIndex !== tokens.length - 2) throw new TypeError("UFW rule is invalid.");
    const ruleTokens = commentIndex >= 0 ? tokens.slice(0, commentIndex) : tokens;
    const signature = JSON.stringify(ruleTokens);
    const details = configuredRuleDetails(ruleTokens, index);
    if (action === "deny" || action === "reject") {
      if (routed || !ruleTokens.includes("out")) {
        if (!details.selector || selectorCanAffectTcp(details.selector, [sshPort, 80, 443])) {
          throw new TypeError("Conflicting UFW rule is invalid.");
        }
      }
      foreign.push(signature);
      continue;
    }
    if (routed || ruleTokens.includes("out")) {
      if (routed) throw new TypeError("UFW routed grant is not allowed.");
      foreign.push(signature);
      continue;
    }
    if (action === "limit") {
      if (!details.selector || selectorCanAffectTcp(details.selector, [sshPort, 80, 443, 3000])) {
        throw new TypeError("UFW limited inbound grant is invalid.");
      }
      foreign.push(signature);
      continue;
    }
    if (action !== "allow") throw new TypeError("UFW grant is invalid.");
    if (!details.selector) {
      // Application profiles and other opaque selectors can contain SSH,
      // public web ports or the internal app port. They are never inferred.
      throw new TypeError("UFW opaque inbound grant is invalid.");
    }
    const classification = classifyInboundGrant(details, sshPort, allowedSourceKeys);
    if (classification === null) { foreign.push(signature); continue; }
    if (found.has(classification)) throw new TypeError("Duplicate UFW grant is invalid.");
    found.add(classification);
  }
  return { managed: found, foreign };
}

function validateUfwDefaultPolicies(output) {
  const defaults = requireSafeMultiline(output, "UFW defaults");
  const expected = new Map([
    ["DEFAULT_INPUT_POLICY", "DROP"],
    ["DEFAULT_OUTPUT_POLICY", "ACCEPT"],
    ["DEFAULT_FORWARD_POLICY", "DROP"],
  ]);
  for (const [key, value] of expected) {
    const assignments = defaults.split(/\r?\n/).filter((line) => new RegExp(`^[ \\t]*${key}[ \\t]*=`).test(line));
    if (assignments.length !== 1
      || !new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*"${value}"[ \\t]*(?:#.*)?$`).test(assignments[0])) {
      throw new TypeError("UFW default policy file is invalid.");
    }
  }
}

function analyzeStatusRules(output, sshPort, allowedSourceKeys, requireComplete) {
  const status = requireSafeMultiline(output, "UFW status");
  const active = /^Status:\s+active$/m.test(status);
  // UFW 0.36.2 reports "disabled (routed)" when kernel forwarding is
  // disabled. That is an equally fail-closed effective state; when routing is
  // enabled, the managed DROP policy is reported as "deny (routed)" instead.
  const defaultMatch = /^Default:\s+deny\s+\(incoming\),\s+allow\s+\(outgoing\),\s+(deny|disabled)\s+\(routed\)$/m.exec(status);
  if (requireComplete && (!active
    || !/^Logging:\s+on\s+\(low\)$/m.test(status)
    || !defaultMatch)) {
    throw new TypeError("UFW effective policy is invalid.");
  }
  const found = new Set();
  if (!active) return Object.freeze({ found, routedDisabled: false });
  for (const rawLine of status.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+\(v6\)/g, "").trim();
    const match = /^(\S+)\s+(ALLOW|LIMIT|DENY|REJECT)\s+(IN|OUT|FWD)\s+(.+?)(?:\s+#.*)?$/.exec(line);
    if (!match) continue;
    if (match[3] === "OUT") continue;
    const selector = parsePortSelector(match[1], null);
    if (match[2] === "DENY" || match[2] === "REJECT") {
      if (!selector || selectorCanAffectTcp(selector, [sshPort, 80, 443])) {
        throw new TypeError("Conflicting UFW rule is invalid.");
      }
      continue;
    }
    if (!selector) throw new TypeError("UFW opaque effective grant is invalid.");
    if (match[2] === "LIMIT") {
      if (selectorCanAffectTcp(selector, [sshPort, 80, 443, 3000])) {
        throw new TypeError("UFW limited effective grant is invalid.");
      }
      continue;
    }
    if (match[3] !== "IN" || match[2] !== "ALLOW") throw new TypeError("UFW effective grant is invalid.");
    const source = match[4].trim().split(/\s+/)[0];
    const classification = classifyInboundGrant({
      selector,
      source,
      destination: "any",
    }, sshPort, allowedSourceKeys);
    if (classification !== null) found.add(classification);
  }
  return Object.freeze({ found, routedDisabled: defaultMatch?.[1] === "disabled" });
}

function validateUfwPolicy({ addedRules, status, sshPort, allowedSources, requireComplete = false, baselineAddedRules = null, ufwDefaults = null }) {
  const port = parsePort(sshPort);
  const sources = validateAllowedSources(allowedSources, { requireNonEmpty: true });
  const allowedSourceKeys = new Set(sources.map((source) => (
    `${source.family}:${source.prefixLength}:${source.network.toString(16)}`
  )));
  const addedAnalysis = analyzeAddedRules(addedRules, port, allowedSourceKeys);
  const added = addedAnalysis.managed;
  const effectiveAnalysis = analyzeStatusRules(status, port, allowedSourceKeys, requireComplete);
  const effective = effectiveAnalysis.found;
  if (requireComplete && effectiveAnalysis.routedDisabled) validateUfwDefaultPolicies(ufwDefaults);
  const expected = new Set(["web:80", "web:443", ...[...allowedSourceKeys].map((source) => `ssh:${source}`)]);
  for (const rule of added) if (!expected.has(rule)) throw new TypeError("UFW configured rule is invalid.");
  for (const rule of effective) if (!expected.has(rule) || !added.has(rule)) throw new TypeError("UFW effective rule is invalid.");
  if (baselineAddedRules !== null) {
    const baseline = analyzeAddedRules(baselineAddedRules, port, allowedSourceKeys);
    if (baseline.foreign.length !== addedAnalysis.foreign.length
      || baseline.foreign.some((rule, index) => rule !== addedAnalysis.foreign[index])
      || [...baseline.managed].some((rule) => !added.has(rule))) {
      throw new TypeError("Foreign UFW rules changed during the transaction.");
    }
  }
  if (requireComplete) {
    for (const rule of expected) {
      if (!added.has(rule) || !effective.has(rule)) throw new TypeError("UFW required rule is missing.");
    }
  }
  return Object.freeze({ configuredCount: added.size, effectiveCount: effective.size, complete: requireComplete });
}

function journaldTemplateAssignments(template) {
  const text = requireSafeMultiline(template, "Journald template");
  const expected = new Map();
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) { section = sectionMatch[1]; continue; }
    if (section !== "Journal") continue;
    const assignment = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(\S(?:.*\S)?)$/.exec(line);
    if (!assignment || expected.has(assignment[1])) throw new TypeError("Journald template is invalid.");
    expected.set(assignment[1], assignment[2]);
  }
  if (expected.size === 0) throw new TypeError("Journald template is invalid.");
  return expected;
}

function validateJournaldConfiguration({ mergedConfig, template, managedPath }) {
  const merged = requireSafeMultiline(mergedConfig, "Journald merged configuration");
  if (typeof managedPath !== "string" || managedPath.trim() !== managedPath
    || !managedPath.startsWith("/") || managedPath.includes("//")
    || managedPath.split("/").some((part, index) => index > 0 && (!part || part === "." || part === ".."))
    || /[\u0000-\u001f\u007f]/.test(managedPath)) {
    throw new TypeError("Journald managed path is invalid.");
  }
  const expected = journaldTemplateAssignments(template);
  const managedCounts = new Map([...expected.keys()].map((key) => [key, 0]));
  const lastAssignments = new Map();
  let source = "";
  let section = "";
  let managedMarkers = 0;

  for (const rawLine of merged.split(/\r?\n/)) {
    const sourceMatch = /^#\s+(\/\S+)\s*$/.exec(rawLine);
    if (sourceMatch) {
      source = sourceMatch[1];
      section = "";
      if (source === managedPath) managedMarkers += 1;
      continue;
    }
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) { section = sectionMatch[1]; continue; }
    if (section !== "Journal") continue;
    const assignment = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(\S(?:.*\S)?)$/.exec(line);
    if (!assignment || !expected.has(assignment[1])) continue;
    lastAssignments.set(assignment[1], { value: assignment[2], source });
    if (source === managedPath) managedCounts.set(assignment[1], managedCounts.get(assignment[1]) + 1);
  }

  if (managedMarkers !== 1) throw new TypeError("Journald managed fragment is missing or duplicated.");
  for (const [key, value] of expected) {
    const actual = lastAssignments.get(key);
    if (managedCounts.get(key) !== 1 || actual?.source !== managedPath || actual.value !== value) {
      throw new TypeError("Journald effective policy is invalid or overridden later.");
    }
  }
  return Object.freeze({ configuredCount: expected.size, managedAssignmentsLast: true });
}

function isClientAllowed(clientIp, allowedSources) {
  const client = parseIpAddress(clientIp);
  // Validate every configured source before deciding. A matching first entry must
  // never hide a malformed later entry in a security-relevant allowlist.
  const sources = validateAllowedSources(allowedSources);
  return sources.some((source) => (
    source.family === client.family && (client.value & source.mask) === source.network
  ));
}

function parsePort(value) {
  let port;
  if (typeof value === "number") {
    port = value;
  } else if (typeof value === "string" && /^(?:[1-9][0-9]{0,4})$/.test(value)) {
    port = Number(value);
  } else {
    throw new TypeError("Port is invalid.");
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > MAX_PORT) throw new TypeError("Port is invalid.");
  return port;
}

function isValidPort(value) {
  try {
    parsePort(value);
    return true;
  } catch {
    return false;
  }
}

function isValidSshPort(value) {
  try {
    return !new Set([80, 443, 3000]).has(parsePort(value));
  } catch {
    return false;
  }
}

function isValidAdminUsername(value) {
  return typeof value === "string"
    && value !== "root"
    && ADMIN_USERNAME_PATTERN.test(value);
}

function isValidTransactionId(value) {
  return typeof value === "string" && TRANSACTION_ID_PATTERN.test(value);
}

function validateSession({ clientIp, allowedSources }) {
  const sources = validateAllowedSources(allowedSources, { requireNonEmpty: true });
  const client = parseIpAddress(clientIp);
  return Object.freeze({
    sourceCount: allowedSources.length,
    clientMatched: sources.some((source) => (
      source.family === client.family && (client.value & source.mask) === source.network
    )),
  });
}

function parseValidateSessionArguments(argv) {
  if (!Array.isArray(argv) || argv[0] !== "validate-session") {
    throw new TypeError("CLI command is invalid.");
  }
  let clientIp = null;
  const allowedSources = [];

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--client") {
      if (clientIp !== null || index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
        throw new TypeError("CLI arguments are invalid.");
      }
      clientIp = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--client=")) {
      if (clientIp !== null || argument.length === "--client=".length) {
        throw new TypeError("CLI arguments are invalid.");
      }
      clientIp = argument.slice("--client=".length);
      continue;
    }
    if (argument === "--source") {
      const firstSourceIndex = index + 1;
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        allowedSources.push(argv[index + 1]);
        index += 1;
      }
      if (index < firstSourceIndex) throw new TypeError("CLI arguments are invalid.");
      continue;
    }
    if (argument.startsWith("--source=")) {
      if (argument.length === "--source=".length) throw new TypeError("CLI arguments are invalid.");
      allowedSources.push(argument.slice("--source=".length));
      continue;
    }
    throw new TypeError("CLI arguments are invalid.");
  }

  if (clientIp === null || allowedSources.length === 0) throw new TypeError("CLI arguments are invalid.");
  return { clientIp, allowedSources };
}

function writeCliResult(stream, result) {
  stream.write(`${JSON.stringify({
    sourceCount: result.sourceCount,
    clientMatched: result.clientMatched,
  })}\n`);
}

function runValidateSessionCli(argv, stdout, stderr) {
  let parsed = null;
  try {
    parsed = parseValidateSessionArguments(argv);
    writeCliResult(stdout, validateSession(parsed));
    return 0;
  } catch {
    writeCliResult(stderr, {
      sourceCount: parsed?.allowedSources?.length || 0,
      clientMatched: false,
    });
    return 1;
  }
}

function writeTransactionResult(stream, transactionValid) {
  stream.write(`${JSON.stringify({ transactionValid })}\n`);
}

function runValidateTransactionCli(argv, stdout, stderr) {
  if (argv.length === 2 && isValidTransactionId(argv[1])) {
    writeTransactionResult(stdout, true);
    return 0;
  }
  writeTransactionResult(stderr, false);
  return 1;
}

function runCli(argv, streams = {}) {
  const stdout = streams.stdout || process.stdout;
  const stderr = streams.stderr || process.stderr;
  if (Array.isArray(argv) && argv[0] === "validate-transaction") {
    return runValidateTransactionCli(argv, stdout, stderr);
  }
  return runValidateSessionCli(argv, stdout, stderr);
}

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));

module.exports = {
  isClientAllowed,
  isIpInCidr,
  isValidAdminUsername,
  isValidPort,
  isValidSshPort,
  isValidTransactionId,
  parseCidr,
  parseIpAddress,
  parsePort,
  runCli,
  validateAllowedSources,
  validateJournaldConfiguration,
  validateUfwPolicy,
  validateSession,
};
