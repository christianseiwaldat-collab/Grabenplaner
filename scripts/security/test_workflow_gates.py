"""Exercise the actual completion-job shell; missing or skipped scans must fail."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]


class WorkflowGateTests(unittest.TestCase):
    def test_every_action_reference_is_an_immutable_commit(self):
        for path in (ROOT / '.github/workflows').glob('*.yml'):
            for reference in re.findall(r'^\s*-?\s*uses:\s*(\S+)', path.read_text(encoding='utf8'), re.M):
                with self.subTest(workflow=path.name, reference=reference):
                    self.assertRegex(reference, r'^[\w.-]+/[\w./-]+@[a-f0-9]{40}$')

    def test_required_security_job_fails_closed_for_every_non_success(self):
        workflow = (ROOT / '.github/workflows/security.yml').read_text(encoding='utf8')
        gate = workflow.split('\n  security-gates:\n')[1]
        self.assertIn('if: always()', gate)
        self.assertIn('needs: [security-sca, security-sast, security-secrets, security-sbom]', gate)
        self.assertIn('permissions: {}', gate)
        self.assertNotIn('continue-on-error', workflow)
        script = textwrap.dedent(gate.split('run: |\n', 1)[1])
        bash = shutil.which('bash')
        if not bash and os.name == 'nt':
            candidate = Path('C:/Program Files/Git/bin/bash.exe')
            if candidate.is_file():
                bash = str(candidate)
        self.assertTrue(bash, 'The completion-job negative controls require Bash')
        keys = ('SCA', 'SAST', 'SECRETS', 'SBOM')
        successful = dict.fromkeys(keys, 'success')
        def run(values):
            return subprocess.run([bash, '--noprofile', '--norc', '-c', script],
                env={**os.environ, **values}, capture_output=True, timeout=10).returncode
        self.assertEqual(run(successful), 0)
        for key in keys:
            for result in ('failure', 'cancelled', 'skipped', '', 'unknown'):
                with self.subTest(job=key, result=result):
                    self.assertNotEqual(run({**successful, key: result}), 0)


if __name__ == '__main__':
    unittest.main()
