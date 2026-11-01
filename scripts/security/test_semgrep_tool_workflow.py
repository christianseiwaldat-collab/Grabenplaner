"""Contract for the separate, deliberately narrow public compiler producer."""
from pathlib import Path
import re
import unittest


def field(block, key, indent):
    """Read our explicit workflow scalars; reject missing or aliased boundaries.

    This deliberately does not emulate general YAML (anchors, merge keys, tags
    or complex scalars). Those forms cannot replace the exact upload contract.
    """
    expression = r'(?m)^' + ' ' * indent + re.escape(key) + r':\s*([^\n]*)$'
    matches = list(re.finditer(expression, block))
    if len(matches) != 1:
        raise AssertionError('Missing or duplicate explicit workflow field: ' + key)
    match = matches[0]
    value = match.group(1).strip()
    if value not in ('|', '>-'):
        return value
    rows = []
    for line in block[match.end():].splitlines()[1:]:
        if line.strip() and not line.startswith(' ' * (indent + 2)):
            break
        rows.append(line[indent + 2:])
    return '\n'.join(rows).rstrip('\n')


def mapping(block, indent):
    keys = re.findall(r'(?m)^' + ' ' * indent + r'([a-z][a-z0-9_-]*):', block)
    if len(keys) != len(set(keys)):
        raise AssertionError('Duplicate workflow mapping key')
    return {key: field(block, key, indent) for key in keys}


class CompilerProducerWorkflowTests(unittest.TestCase):
    def setUp(self):
        file = Path(__file__).resolve().parents[2] / '.github/workflows/sast-source-build.yml'
        self.source = file.read_text(encoding='utf8')
        self.steps = ['      - ' + item for item in self.source.split('      - ')[1:]]

    def step(self, name):
        return next(item for item in self.steps if item.startswith('      - name: ' + name + '\n'))

    def top(self, name):
        result = re.search(r'(?m)^' + re.escape(name) + r':\n((?:[ \t].*\n|\n)*)', self.source)
        self.assertIsNotNone(result)
        return result.group(1)

    def test_tool_production_requires_explicit_dispatch_and_stays_read_only(self):
        self.assertEqual(set(mapping(self.top('on'), 2)), {'workflow_dispatch'})
        option = mapping(self.top('on'), 8)
        self.assertEqual((option['type'], option['default'], option['required']), ('boolean', 'false', 'true'))
        self.assertEqual(mapping(self.top('permissions'), 2), {'contents': 'read'})
        self.assertEqual(field(self.top('concurrency'), 'cancel-in-progress', 2), 'false')
        checkout = self.steps[0]
        self.assertRegex(checkout.splitlines()[0], r'^      - uses: actions/checkout@[a-f0-9]{40} ')
        self.assertEqual(field(checkout, 'persist-credentials', 10), 'false')

    def test_actual_license_collection_follows_one_cold_build_and_precedes_publication(self):
        build = self.step('Build the official upstream target and qualify whole files and controls')
        self.assertIn('--cold-build', field(build, 'run', 8))
        collector = self.step('Collect actual built-image dependency closure and verified licenses/sources')
        publisher = self.step('Package only the qualified upstream tool and complete corresponding source')
        verifier = self.step('Verify the exact public tool set before upload')
        for step in (collector, publisher, verifier):
            self.assertEqual(field(step, 'if', 8), 'inputs.publish_tool == true && success()')
        self.assertLess(self.steps.index(build), self.steps.index(collector))
        self.assertLess(self.steps.index(collector), self.steps.index(publisher))
        self.assertLess(self.steps.index(publisher), self.steps.index(verifier))
        for exact in ('--image-id-file "$RUNNER_TEMP/semgrep-source-work/image-id"',
                '--binary "$RUNNER_TEMP/semgrep-source-work/semgrep-core-1.181.0-budget30"',
                '--source "$RUNNER_TEMP/semgrep-source-work/upstream"',
                '--qualification "$RUNNER_TEMP/semgrep-source-private"'):
            self.assertIn(exact, field(collector, 'run', 8))
        self.assertIn('--ledger "$RUNNER_TEMP/semgrep-core-license-review/ledger.json"', field(publisher, 'run', 8))
        self.assertIn('--dependency-sources "$RUNNER_TEMP/semgrep-core-license-review/dependency-sources"', field(publisher, 'run', 8))
        self.assertIn('--verify-upload "$RUNNER_TEMP/semgrep-core-tool-public"', field(verifier, 'run', 8))

    def test_tool_artifact_is_one_explicit_archive_separate_from_encrypted_gp_findings(self):
        uploads = [step for step in self.steps if re.search(r'(?m)^        uses: actions/upload-artifact@', step)]
        tool = next(step for step in uploads if field(step, 'id', 8) == 'upload-tool')
        self.assertEqual(field(tool, 'if', 8), 'inputs.publish_tool == true && success()')
        self.assertRegex(field(tool, 'uses', 8), r'^actions/upload-artifact@[a-f0-9]{40} ')
        actual = mapping(tool, 10)
        self.assertEqual(actual, {
            'name': 'semgrep-core-tool-${{ github.run_id }}-${{ github.run_attempt }}',
            'path': '${{ runner.temp }}/semgrep-core-tool-public/semgrep-core-tool.tar.xz',
            'if-no-files-found': 'error', 'retention-days': '90', 'archive': 'true',
            'overwrite': 'false', 'include-hidden-files': 'false'})
        private = next(step for step in uploads if field(step, 'id', 8) == 'upload')
        self.assertEqual(field(private, 'path', 10).splitlines(), [
            '${{ runner.temp }}/semgrep-source-public/diagnostic-summary.json',
            '${{ runner.temp }}/semgrep-source-public/private-evidence.gpe',
            '${{ runner.temp }}/semgrep-source-public/diagnostic-upload-manifest.json'])
        for upload in uploads:
            self.assertNotIn('*', field(upload, 'path', 10))
            self.assertNotIn('upstream', field(upload, 'path', 10))
            self.assertNotIn('semgrep-source-private', field(upload, 'path', 10))

    def test_failed_license_review_retains_only_validated_capture_and_never_authorizes_tool_upload(self):
        checker = self.step('Verify bounded upstream-only license capture even after a collection failure')
        self.assertEqual(field(checker, 'if', 8),
                         "always() && inputs.publish_tool == true && steps.build-core.outcome == 'success'")
        self.assertIn('--verify-capture "$RUNNER_TEMP/semgrep-core-license-review"', field(checker, 'run', 8))
        capture = self.step('Retain exact upstream-only license capture without another compiler build')
        self.assertEqual(field(capture, 'if', 8),
                         "always() && inputs.publish_tool == true && steps.verify-license-capture.outcome == 'success'")
        self.assertEqual(field(capture, 'path', 10).splitlines(), [
            '${{ runner.temp }}/semgrep-core-license-review/capture.tar.xz',
            '${{ runner.temp }}/semgrep-core-license-review/capture-receipt.json'])
        self.assertEqual(field(capture, 'retention-days', 10), '14')
        self.assertEqual(field(capture, 'overwrite', 10), 'false')
        publication = self.step('Package only the qualified upstream tool and complete corresponding source')
        self.assertEqual(field(publication, 'if', 8), 'inputs.publish_tool == true && success()')


if __name__ == '__main__':
    unittest.main()
