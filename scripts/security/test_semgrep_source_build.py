from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from build_semgrep_source import (approved_patch, assert_delta, control_sources, digest,
                                 ALPINE, LIMITS, LIMITS_AFTER, LIMITS_BEFORE, PATCH_FROM,
                                 PATCH_TO, pinned_recipe, replace_venv_core, validate_result)


class SourceBuildQualificationTests(unittest.TestCase):
    def setUp(self):
        self.original = (Path(__file__).parent / 'fixtures/semgrep-1.181.0-Limits_semgrep.ml').read_bytes()

    def test_only_the_single_budget_line_changes_and_every_scope_limit_stays(self):
        self.assertEqual(digest(self.original), LIMITS_BEFORE)
        changed = approved_patch(self.original)
        self.assertEqual(digest(changed), LIMITS_AFTER)
        self.assertEqual(changed.replace(PATCH_TO, PATCH_FROM), self.original)
        self.assertEqual(len(changed.splitlines()), len(self.original.splitlines()))
        assert_delta([LIMITS], changed)

    def test_changed_variable_set_or_other_limits_and_repeat_patch_fail_closed(self):
        self.assertIn(b'let taint_MAX_TAINTED_VARS = 50', self.original)
        for value in (self.original + b'\n', self.original.replace(b'taint_MAX_TAINTED_VARS = 50', b'taint_MAX_TAINTED_VARS = 1000'),
                      self.original.replace(b'= 25', b'= 50'),
                      self.original.replace(PATCH_FROM, PATCH_TO),
                      self.original + PATCH_FROM):
            with self.subTest(sha=digest(value)), self.assertRaises(ValueError):
                approved_patch(value)

    def test_additional_source_paths_or_wrong_budget_cannot_be_qualified(self):
        changed = approved_patch(self.original)
        for names, value in (([], changed), ([LIMITS, 'src/analyzing/Dataflow_core.ml'], changed),
                             ([LIMITS], changed.replace(b'= 30.0', b'= 120.0'))):
            with self.subTest(paths=names), self.assertRaises(ValueError):
                assert_delta(names, value)

    def test_derived_official_recipe_only_pins_the_reviewed_base_image(self):
        original = (Path(__file__).parent / 'fixtures/semgrep-1.181.0-Dockerfile').read_bytes()
        changed = pinned_recipe(original)
        self.assertEqual(changed.replace(ALPINE.encode(), b'alpine:3.23'), original)
        self.assertEqual(changed.count(('FROM ' + ALPINE + ' ').encode()), 2)
        with self.assertRaises(ValueError):
            pinned_recipe(original + b'\nRUN unexpected-command\n')

    def test_missing_fixpoint_field_and_all_partial_results_remain_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            target = str(stage / 'unsafe.js')
            valid = {'version': '1.181.0', 'errors': [], 'paths': {'scanned': [target]},
                     'results': [{'path': target}], 'time': {'fixpoint_timeouts': []}}
            self.assertEqual(validate_result(valid, {'unsafe.js'}, stage, 1), 1)
            values = [
                {**valid, 'errors': None}, {**valid, 'errors': [{'type': 'Timeout'}]},
                {**valid, 'time': {}}, {**valid, 'time': {'fixpoint_timeouts': None}},
                {**valid, 'time': {'fixpoint_timeouts': ['interrupted']}},
                {**valid, 'results': None}, {**valid, 'version': '1.182.0'},
                {**valid, 'paths': {'scanned': []}},
                {**valid, 'paths': {'scanned': [target, target]}},
                {**valid, 'paths': {'scanned': [target], 'skipped': [target]}},
                {**valid, 'paths': {'scanned': [target], 'skipped': None}},
                {**valid, 'skipped_rules': ['omitted']}, {**valid, 'skipped_rules': {}},
            ]
            for value in values:
                with self.subTest(value=value), self.assertRaises((ValueError, TypeError)):
                    validate_result(value, {'unsafe.js'}, stage, 1)
            for code in (0, 2, 3, -9):
                with self.subTest(code=code), self.assertRaises(ValueError):
                    validate_result(valid, {'unsafe.js'}, stage, code)

    def test_synthetic_loop_and_async_controls_do_not_replace_application_files(self):
        controls = control_sources()
        self.assertEqual({name for name, _, _ in controls}, {'require', 'sql', 'loop', 'async'})
        loop = next(files for name, _, files in controls if name == 'loop')
        self.assertIn('a8=a7;a7=a6;a6=a5', loop['unsafe.js'])
        self.assertIn('for(let i=0;i<12;i++)', loop['unsafe.js'])
        self.assertIn('id=$1', loop['safe.js'])

    def test_global_python_installation_is_never_modified(self):
        with patch('build_semgrep_source.sys.prefix', '/same'), patch('build_semgrep_source.sys.base_prefix', '/same'):
            with self.assertRaisesRegex(ValueError, 'virtual environment'):
                replace_venv_core(Path('/unused'), Path('/unused'), None)


if __name__ == '__main__':
    unittest.main()
