from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from diagnose_opengrep import install, summarize


class SecondEngineDiagnosticTests(unittest.TestCase):
    def test_incomplete_or_inconsistent_results_never_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            target = str(stage / 'unsafe.js')
            result = {'errors': [], 'paths': {'scanned': [target]}, 'results': [{'path': target}]}
            self.assertTrue(summarize(result, {'unsafe.js'}, stage, 1)['analysisCompleteForCase'])
            mutations = [
                {**result, 'errors': None}, {**result, 'errors': [{'type': 'Timeout'}]},
                {**result, 'paths': {'scanned': []}},
                {**result, 'paths': {'scanned': [target, target]}},
                {**result, 'paths': {'scanned': [target], 'skipped': [target]}},
                {**result, 'skipped_rules': ['unparsed']},
                {**result, 'time': {'fixpoint_timeouts': ['warning']}},
                {**result, 'time': {'fixpoint_timeouts': 'malformed'}},
                {**result, 'results': None}]
            for mutation in mutations:
                with self.subTest(mutation=mutation):
                    self.assertFalse(summarize(mutation, {'unsafe.js'}, stage, 1)['analysisCompleteForCase'])
            self.assertFalse(summarize(result, {'unsafe.js'}, stage, 0)['analysisCompleteForCase'])

    def test_unqualified_download_is_never_executable(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, maximum): return b'\x7fELFunqualified'
        with tempfile.TemporaryDirectory() as directory, patch('diagnose_opengrep.urllib.request.urlopen', return_value=Response()):
            destination = Path(directory) / 'opengrep'
            with self.assertRaises(ValueError): install(destination)
            self.assertFalse(destination.exists())


if __name__ == '__main__':
    unittest.main()
