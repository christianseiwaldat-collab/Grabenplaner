"""Qualify a second upstream engine without granting security gate approval.

The unchanged Semgrep run remains authoritative about its own incompleteness.
This experiment is deliberately separate from gates.py and the disposition file.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

from gates import read, sha, source_files, stage_sources, write
from sast_profile import build_rule_profiles
from diagnose_sast_fixpoints import REQUIRE_RULE, SQL_RULE, SMALL_TARGET

VERSION = '1.32.0'
URL = 'https://github.com/opengrep/opengrep/releases/download/v1.32.0/opengrep_manylinux_x86'
SIZE = 46513552
SHA256 = '7360d60174880bd9214f2dfbe439b7bce82b7a3d44cfe945ba833c85cc8bda75'


def install(destination):
    # Release asset metadata was independently retrieved from upstream GitHub
    # API. This is hash verification, not a detached-signature verification claim.
    with urllib.request.urlopen(URL, timeout=60) as response:
        content = response.read(SIZE + 1)
    if len(content) != SIZE or hashlib.sha256(content).hexdigest() != SHA256 or content[:4] != b'\x7fELF':
        raise ValueError('Unqualified diagnostic engine bytes')
    destination.write_bytes(content)
    destination.chmod(0o700)


def summarize(result, expected, stage, exit_code):
    scanned = [Path(p).resolve().relative_to(stage.resolve()).as_posix()
               for p in result.get('paths', {}).get('scanned', [])]
    coverage = len(scanned) == len(expected) and set(scanned) == set(expected)
    errors = result.get('errors')
    findings = result.get('results')
    skipped = result.get('paths', {}).get('skipped', [])
    skipped_rules = result.get('skipped_rules', [])
    fixpoints = result.get('time', {}).get('fixpoint_timeouts')
    # Opengrep removed the inner fixpoint timeout. Absence is measured explicitly
    # here; it does NOT satisfy the Semgrep gate's required diagnostic field.
    fixpoint_shape = fixpoints is None or isinstance(fixpoints, list)
    consistent = isinstance(findings, list) and exit_code in (0, 1) and ((exit_code == 1) == bool(findings))
    valid = coverage and errors == [] and not skipped and not skipped_rules and fixpoint_shape and consistent
    return {'targetCoverageComplete': coverage, 'executionEvidenceValid': valid,
            'analysisCompleteForCase': bool(valid and not fixpoints),
            'topLevelErrors': len(errors) if isinstance(errors, list) else -1,
            'skippedTargets': len(skipped), 'skippedRules': len(skipped_rules),
            'fixpointFieldPresent': fixpoints is not None,
            'fixpointTimeoutCount': len(fixpoints) if isinstance(fixpoints, list) else 0,
            'findingCount': len(findings) if isinstance(findings, list) else -1}


def run(root, tools, output):
    if output.exists():
        raise ValueError('Diagnostic output directory must be new')
    output.mkdir(parents=True)
    began = time.monotonic()
    binary = output / 'opengrep'
    install(binary)
    version = subprocess.run([str(binary), '--version'], capture_output=True, timeout=30, check=True).stdout.decode().strip()
    if version != VERSION:
        raise ValueError('Unexpected upstream diagnostic version')
    help_result = subprocess.run([str(binary), 'scan', '--help'], capture_output=True, timeout=30, check=True)
    write(output / 'engine-provenance.json', {'engine': 'opengrep', 'version': version,
          'release': 'https://github.com/opengrep/opengrep/releases/tag/v1.32.0',
          'url': URL, 'bytes': SIZE, 'sha256': sha(binary),
          'integrityBasis': 'Pinned upstream GitHub release asset digest over HTTPS; no detached signature claim.',
          'scanHelp': help_result.stdout.decode('utf8', errors='replace')})
    config = read(root / 'scripts/security/tools.json')
    upstream = read(tools / 'rules-manifest.json')
    if upstream['commit'] != config['rules']['commit'] or upstream['archiveSha256'] != config['rules']['sha256']:
        raise ValueError('Unpinned diagnostic rules')
    profiles = build_rule_profiles(tools, output / 'profiles', upstream)
    inventory = {row['path']: row for row in source_files(root)}
    rules = {row['path']: row for rows in profiles['groups'].values() for row in rows}
    controls = [
        ('controls-require', [rules[REQUIRE_RULE]], {
            'unsafe.js': 'function load(input) { return require(input); }\n',
            'safe.js': "function load(input) { return require('node:fs'); }\n"}),
        ('controls-sql', [rules[SQL_RULE]], {
            'unsafe.js': 'const express = require("express"); const { Client } = require("pg"); const db = new Client(); const app = express();\n'
                         'app.get("/entries", function unsafe(req, res) { const sql = "SELECT * FROM entries WHERE id=" + req.query.id; db.query(sql); res.send("ok"); });\n',
            'safe.js': 'const express = require("express"); const { Client } = require("pg"); const db = new Client(); const app = express();\n'
                       'app.get("/entries", function safe(req, res) { db.query("SELECT * FROM entries WHERE id=$1", [req.query.id]); res.send("ok"); });\n'})]
    cases = [(name, [], rows, control) for name, rows, control in controls]
    cases.extend((f'{label}-{profile}', [target], profiles['groups'][profile], None)
                 for label, target, profile in [('small', SMALL_TARGET, 'common'),
                                                ('server', 'server.js', 'express'),
                                                ('server', 'server.js', 'common')])
    write(output / 'diagnostic-plan.json', {'engine': 'opengrep', 'diagnosticOnly': True,
          'securityGatePassed': False, 'sourceTargets': [inventory[p] for p in (SMALL_TARGET, 'server.js')],
          'ruleManifestSha256': sha(tools / 'rules-manifest.json'),
          'cases': [{'name': name, 'targets': names, 'rules': rows, 'syntheticControl': control is not None}
                    for name, names, rows, control in cases]})
    records = []
    for name, names, rows, control in cases:
        stage = output / 'stages' / name
        if control:
            stage.mkdir(parents=True)
            for filename, text in control.items():
                (stage / filename).write_text(text, encoding='utf8')
            expected = set(control)
        else:
            stage_sources(root, stage, [inventory[p] for p in names])
            expected = set(names)
        rule_dir = output / 'case-rules' / name
        for row in rows:
            destination = rule_dir / row['path']
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(tools / 'rules' / row['path'], destination)
            if sha(destination) != row['sha256']:
                raise ValueError('Diagnostic rule copy drift')
        result_path = output / (name + '.json')
        command = [str(binary), 'scan', '--config', str(rule_dir), '--json', '--output', str(result_path),
                   '--metrics', 'off', '--disable-version-check', '--disable-nosem', '--no-git-ignore',
                   '--max-target-bytes', '0', '--timeout', '300', '--timeout-threshold', '0',
                   '--max-memory', '4096', '--jobs', '1', '--strict', '--error', str(stage)]
        started = time.monotonic()
        try:
            completed = subprocess.run(command, capture_output=True, timeout=600, check=False)
            write(output / (name + '-process.json'), {'exitCode': completed.returncode,
                  'stdout': completed.stdout.decode('utf8', errors='replace'),
                  'stderr': completed.stderr.decode('utf8', errors='replace')})
            raw = read(result_path)
            summary = summarize(raw, expected, stage, completed.returncode)
            detected = {Path(finding['path']).name for finding in raw.get('results', [])}
            records.append({'name': name, 'argv': command, 'exitCode': completed.returncode,
                            'elapsedSeconds': time.monotonic() - started, 'resultSha256': sha(result_path),
                            'ruleFiles': rows, 'controlPassed': summary['analysisCompleteForCase'] and detected == {'unsafe.js'} if control else None,
                            **summary})
        except Exception as error:
            records.append({'name': name, 'executionEvidenceValid': False, 'analysisCompleteForCase': False,
                            'diagnosticError': str(error)})
    complete = len(records) == len(cases) and all(row['analysisCompleteForCase'] for row in records)
    controls_passed = all(next((r.get('controlPassed') is True for r in records if r['name'] == name), False)
                          for name, _, _ in controls)
    write(output / 'gate-result.json', {'schemaVersion': 1, 'gate': 'sast-diagnostic', 'diagnosticOnly': True,
          'complete': False, 'passed': False, 'securityGatePassed': False, 'status': 'diagnostic_only',
          'diagnosticExecutionComplete': complete, 'controlsPassed': controls_passed,
          'scanner': 'opengrep', 'scannerVersion': version, 'ruleCommit': upstream['commit'],
          'elapsedSeconds': time.monotonic() - began, 'cases': records,
          'scope': 'Second engine qualification with complete unchanged source files and unchanged rules. No production security gate or disposition changes.'})
    print(json.dumps({'diagnosticOnly': True, 'securityGatePassed': False, 'executionComplete': complete,
                      'controlsPassed': controls_passed, 'cases': len(records)}))
    return 0 if complete and controls_passed else 2


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--tools', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        raise SystemExit(run(args.root.resolve(), args.tools.resolve(), args.output.resolve()))
    except Exception as error:
        args.output.mkdir(parents=True, exist_ok=True)
        write(args.output / 'gate-result.json', {'schemaVersion': 1, 'gate': 'sast-diagnostic', 'diagnosticOnly': True,
              'complete': False, 'passed': False, 'securityGatePassed': False, 'status': 'diagnostic_only',
              'diagnosticExecutionComplete': False, 'controlsPassed': False, 'error': str(error), 'cases': []})
        print('Second engine qualification incomplete; private evidence retained.')
        raise SystemExit(2)
