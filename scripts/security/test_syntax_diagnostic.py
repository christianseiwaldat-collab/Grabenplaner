import copy
from pathlib import Path
import unittest
from syntax_diagnostic import assess


class SyntaxDiagnosticTests(unittest.TestCase):
    def fixture(self):
        stage = Path.cwd() / 'synthetic-stage'
        return stage, {'version': '1.181.0', 'errors': [], 'results': [],
                       'paths': {'scanned': [str(stage / 'a.js')]},
                       'time': {'fixpoint_timeouts': []}, 'skipped_rules': []}

    def test_syntax_ready_never_claims_security_approval(self):
        stage, result = self.fixture()
        actual = assess(result, {'a.js'}, stage, 0)
        self.assertTrue(actual['syntaxReady'])
        self.assertFalse(actual['securityGatePassed'])
        result['results'] = [{'syntheticFinding': True}]
        actual = assess(result, {'a.js'}, stage, 1)
        self.assertEqual(actual['findingCount'], 1)
        self.assertFalse(actual['securityGatePassed'])

    def test_partial_parse_skips_fixpoints_version_and_exit_drift_fail_closed(self):
        stage, result = self.fixture()
        mutations = [
            lambda d: d.update(errors=[{'type': 'PartialParsing'}]),
            lambda d: d['paths'].update(scanned=[]),
            lambda d: d['paths'].update(skipped=[{'path': 'a.js'}]),
            lambda d: d.update(skipped_rules=['synthetic']),
            lambda d: d['time'].update(fixpoint_timeouts=['synthetic']),
            lambda d: d.update(version='unreviewed'),
            lambda d: d.update(results=[{'syntheticFinding': True}]),
        ]
        for change in mutations:
            changed = copy.deepcopy(result)
            change(changed)
            with self.assertRaises(ValueError):
                assess(changed, {'a.js'}, stage, 0)
        with self.assertRaises(ValueError):
            assess(result, {'a.js'}, stage, 2)


if __name__ == '__main__':
    unittest.main()
