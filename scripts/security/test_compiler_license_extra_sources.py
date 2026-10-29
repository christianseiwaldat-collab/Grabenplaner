"""Typed evidence contracts, synthetic wiring and separate P3 byte regressions."""
import base64
import copy
import gzip
import io
import json
from pathlib import Path
import sys
import tempfile
import tarfile
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).parent
FIXTURES = HERE/'fixtures'/'license-extra-sources'
import compiler_license_ledger as ledger
import compiler_license_extra_sources as model
from test_compiler_license_ledger import fixture_ledger
from test_compiler_license_declaration import package_fixture as old_package_fixture

# Explicitly synthetic archive for unit wiring only. The real 6.3 MB OCaml
# archive remains outside Git and is checked with the actual offline dataset.
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode='w') as archive:
    payload = b'EXPLICITLY SYNTHETIC UNIT LICENSE FIXTURE; NOT AN UPSTREAM LICENSE\n'
    info = tarfile.TarInfo('synthetic-unit-ocaml/COPYING'); info.size = len(payload)
    archive.addfile(info, io.BytesIO(payload))
UNIT_ARCHIVE = gzip.compress(buffer.getvalue(), mtime=0)
REAL_COMPILER_ARCHIVE_POLICY = copy.deepcopy(model.POLICIES['ocaml-compiler.5.4.0']['archive'])


def package_fixture(identity):
    p = model.policy(identity)
    original = (FIXTURES/'metadata'/(identity+'.opam')).read_bytes()
    # Independent native observation is checked below; this is only a fixture
    # of OPAM's permitted lexical normalization, not an actual P3 image record.
    actual = ((FIXTURES/'actual-p3'/identity/'opam').read_bytes() if p.get('sourcePin') else
              original+b'\nname: "'+p['name'].encode()+b'"\nversion: "'+p['version'].encode()+b'"\n')
    install = ((FIXTURES/'extras/seq.base/seq.install').read_bytes() if identity == 'seq.base'
               else (FIXTURES/'extras/ocaml-compiler.5.4.0/ocaml-compiler.install').read_bytes()
               if identity == 'ocaml-compiler.5.4.0' else b'')
    return {'id': identity, 'name': p['name'], 'version': p['version'], 'sourcePin': p.get('sourcePin'),
            'sourceDirectory': p['name'] if p.get('sourcePin') else identity,
            'opam': base64.b64encode(actual).decode(), 'install': base64.b64encode(install).decode(),
            'changes': base64.b64encode(b'fixture-only installed changes\n').decode()}


def primary_download(url, maximum=ledger.MAX_FILE):
    for identity, p in model.POLICIES.items():
        if url == model.metadata_url(identity): return (FIXTURES/'metadata'/(identity+'.opam')).read_bytes()
        for spec in p['extraSources']:
            if url == spec['url']: return (FIXTURES/'extras'/identity/spec['name']).read_bytes()
        if 'archive' in p and url == p['archive']['url']: return UNIT_ARCHIVE
    for key, spec in model.REFERENCES.items():
        if url == spec['url']: return (FIXTURES/'references'/(key+'.txt')).read_bytes()
    raise AssertionError('Unexpected source request: '+url)


class ExactExtraSourceTests(unittest.TestCase):
    def test_unreviewed_extra_files_are_rejected_for_known_and_unknown_packages(self):
        extension = b'\nextra-files: [["unreviewed.c" "sha256=' + b'0' * 64 + b'"]]\n'
        for identity in model.REVIEWED_SOURCE_IDS:
            original = (FIXTURES/'metadata'/(identity+'.opam')).read_bytes()
            with self.subTest(identity=identity), self.assertRaisesRegex(ValueError, 'extra-files'):
                model.semantics(original + extension, identity)
        for identity in ('unreviewed.1', 'conf-gmp.5', 'ocaml-config.3', 'ambient-context.0.2'):
            with self.subTest(identity=identity), self.assertRaisesRegex(ValueError, 'extra-files'):
                model.ensure_reviewed_extensions(identity, extension.decode())
        from compiler_license_declaration import DECLARATION_IDS, _semantics
        for identity in DECLARATION_IDS:
            original = base64.b64decode(old_package_fixture(identity)['opam'])
            with self.subTest(original_model=identity), self.assertRaisesRegex(ValueError, 'extra-files'):
                _semantics(original + extension, identity)
        model.ensure_reviewed_extensions('unreviewed.1', 'description: """\nextra-files: [["text"]]\n"""\n')

    def test_seq_install_normalizes_only_between_tokens_and_keeps_exact_filenames(self):
        for valid in (b'lib: ["META.seq" {"META"}]',
                b'opam-version: "2.0"\nlib: "META.seq" {"META"}\n',
                b'\tlib\n:\t[ "META.seq"\n{ "META" }\n]\r\n'):
            with self.subTest(valid=valid): self.assertTrue(model.valid_seq_install(valid))
        for invalid in (b'lib: ["M E T A . s e q" {"M E T A"}]',
                b'lib: ["META.\nseq" {"META"}]', b'lib: ["META.seq" {"ME\tTA"}]',
                b'lib: ["META.seq" {"META"}]\nshare: ["extra"]',
                b'opam-version: "2.0"\nopam-version: "2.0"\nlib: "META.seq" {"META"}'):
            with self.subTest(invalid=invalid): self.assertFalse(model.valid_seq_install(invalid))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.output = self.root/'output'; self.output.mkdir()
        self.download = patch.object(ledger, 'download', side_effect=primary_download)
        self.download.start(); self.addCleanup(self.download.stop)
        # No production policy changes: this patch is local to one unit test.
        # Original URL/checksums and OPAM source semantics remain unchanged.
        p = copy.deepcopy(model.POLICIES['ocaml-compiler.5.4.0'])
        p['archive'].update(model.record(UNIT_ARCHIVE))
        p['noticeSpecs'] = [{key: item[key] for key in ('path', 'sha256', 'sourceBytesSha256', 'encoding')}
                            for item in ledger.archive_notices(UNIT_ARCHIVE)]
        self.policy_patch = patch.dict(model.POLICIES, {'ocaml-compiler.5.4.0': p})
        self.policy_patch.start(); self.addCleanup(self.policy_patch.stop)
        checked = ledger.checked_download
        def unit_checked(url, checksums, cache):
            if url == REAL_COMPILER_ARCHIVE_POLICY['url']:
                self.assertEqual(checksums, REAL_COMPILER_ARCHIVE_POLICY['checksums'])
                return UNIT_ARCHIVE
            return checked(url, checksums, cache)
        self.checked_patch = patch.object(ledger, 'checked_download', side_effect=unit_checked)
        self.checked_patch.start(); self.addCleanup(self.checked_patch.stop)

    def collect(self, identity):
        package = package_fixture(identity)
        tree = self.root/'opam-sources'/package['sourceDirectory']; tree.mkdir(parents=True, exist_ok=True)
        (tree/'retained-actual-marker.ml').write_bytes(b'actual complete source tree fixture\n')
        if identity in model.PINNED_SOURCE_IDS:
            for spec in model.policy(identity)['originalNotices']:
                target = tree/spec['sourcePath']; target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((FIXTURES/'pinned-opentelemetry'/spec['sourcePath']).read_bytes())
        # Current collector's real checked_download still verifies every source
        # checksum, including MD5 aliases, against these primary fixture bytes.
        component = model.collect_component(package, self.root, self.output)
        data = (self.output/component['correspondingSource']['filename']).read_bytes()
        files = model.source_files(data)
        native = {'opamPackages': package['name']+' '+package['version']+'\n',
                  'opamSourceEvidence': model.actual_source_evidence({'opamListing': package['name']+' '+package['version']+'\n', 'opamPackages': [package]})}
        return package, component, files, native

    def test_all_six_exact_identities_keep_original_extras_and_full_actual_tree(self):
        self.assertEqual(len(model.EXTRA_SOURCE_IDS), 6)
        self.assertEqual(sum(len(p['extraSources']) for p in model.POLICIES.values()), 8)
        for identity in sorted(model.EXTRA_SOURCE_IDS):
            with self.subTest(identity=identity):
                package, component, files, native = self.collect(identity)
                model.validate_component(component, files, native)
                model.validate_component(component, native=native)
                self.assertIn('source/captured/retained-actual-marker.ml', files)
                self.assertEqual(files['metadata/original-opam'], (FIXTURES/'metadata'/(identity+'.opam')).read_bytes())
                self.assertNotEqual(files['metadata/original-opam'], files['metadata/installed-opam'])
                for spec in model.extra_specs(identity): self.assertEqual(model.record(files[spec['path']]), {x: spec[x] for x in ('bytes', 'sha256')})

    def test_seq_original_metadata_files_are_complete_and_nonempty_install_is_valid(self):
        package, component, files, native = self.collect('seq.base')
        self.assertEqual(component['licenseEvidence']['originalDeclaration']['license'], [])
        self.assertEqual(component['licenseEvidence']['originalDeclaration']['authors'], [' '])
        self.assertIn(b'"META.seq"', files['metadata/install'])
        for key, name in [('SEQ-META-origin', 'META.seq'), ('SEQ-install-origin', 'seq.install')]:
            self.assertEqual(files[model.REFERENCES[key]['path']], files['source/extra/'+name])
        self.assertIn(b'All the metadata contained in this repository', files[model.REFERENCES['SEQ-README']['path']])
        for bad in (b'', b'lib: ["other.ml"]', b'lib: ["META.seq" {"META"}]\nshare: ["unreviewed"]'):
            altered = copy.deepcopy(package); altered['install'] = base64.b64encode(bad).decode()
            with self.subTest(install=bad), self.assertRaises(ValueError): model.collect_component(altered, self.root, self.output)

    def test_conf_libev_original_header_and_declared_package_license_remain_separate(self):
        _, component, files, native = self.collect('conf-libev.4-13')
        self.assertEqual(component['licenseEvidence']['originalDeclaration']['license'], ['BSD-2-Clause'])
        self.assertIn('Per-File', component['licenseExpression'])
        self.assertIn(b'Copyright (C) 2010', files['source/extra/discover.ml'])
        self.assertIn(b'linking exceptions', files['source/extra/discover.ml'])
        self.assertIn(b'additional exemption', files[model.REFERENCES['LWT-COPYING']['path']])
        self.assertEqual(component['notices'][0]['path'], 'source/extra/discover.ml')
        for expression in ('BSD-2-Clause', 'CC0-1.0', 'LGPL-2.1-only WITH OCaml-LGPL-linking-exception'):
            altered = copy.deepcopy(component); altered['licenseExpression'] = expression
            with self.subTest(expression=expression), self.assertRaises(ValueError): model.validate_component(altered, files, native)

    def test_original_extra_payload_cannot_be_mutated_or_omitted(self):
        for identity in ('conf-gmp.5', 'conf-libev.4-13', 'seq.base'):
            _, component, files, native = self.collect(identity)
            for spec in model.extra_specs(identity):
                altered = dict(files); altered[spec['path']] += b'changed'
                with self.subTest(identity=identity, path=spec['path']), self.assertRaises(ValueError): model.validate_component(component, altered, native)
                altered = dict(files); altered.pop(spec['path'])
                with self.assertRaises(ValueError): model.validate_component(component, altered, native)

    def test_actual_metadata_requires_independent_native_binding(self):
        _, component, files, native = self.collect('conf-gmp.5')
        for mutation in ('missing', 'changed', 'unknown'):
            altered = copy.deepcopy(native)
            if mutation == 'missing': altered.pop('opamSourceEvidence')
            if mutation == 'changed': altered['opamSourceEvidence']['conf-gmp.5']['opam']['sha256'] = '0'*64
            if mutation == 'unknown': altered['opamSourceEvidence']['conf-gmp.6'] = altered['opamSourceEvidence']['conf-gmp.5']
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): model.validate_component(component, files, altered)

    def test_actual_native_merge_keeps_existing_config_source_and_all_eleven_known_ids(self):
        old = old_package_fixture('ocaml-config.3'); new = package_fixture('conf-gmp.5')
        listing = 'ocaml-config 3\nconf-gmp 5\n'
        value = model.actual_source_evidence({'opamListing': listing, 'opamPackages': [old, new]})
        self.assertEqual(set(value), {'ocaml-config.3', 'conf-gmp.5'})
        self.assertIn('installedSource', value['ocaml-config.3'])
        with self.assertRaises(ValueError): model.actual_source_evidence({'opamListing': listing, 'opamPackages': [old]})
        self.assertEqual(len(model.all_reviewed_ids()), 16)

    def test_unknown_identity_cannot_take_an_extra_source_or_metadata_waiver(self):
        package = package_fixture('conf-gmp.5'); package['id'] = 'conf-gmp.6'; package['version'] = '6'
        with self.assertRaises(ValueError): model.collect_component(package, self.root, self.output)
        for text in ('patches: ["fix.patch"]\n', 'substs: "x"\n', 'extra-source "x" { src: "https://example.org/x" checksum: "sha256='+('0'*64)+'" }\n'):
            with self.subTest(text=text), self.assertRaises(ValueError): model.ensure_reviewed_extensions('unknown.1', text)
        model.ensure_reviewed_extensions('unknown.1', 'description: """\nextra-source "x" { src: "fake" }\npatches: ["fake"]\n"""\n')

    def test_duplicate_fields_extra_names_and_changed_source_metadata_fail(self):
        identity = 'conf-gmp.5'; original = (FIXTURES/'metadata'/(identity+'.opam')).read_bytes()
        cases = [original+b'\nlicense: "GPL-1.0-or-later"\n', original+b'\npatches: ["x.patch"]\n',
                 original.replace(b'sha256=54a307', b'sha256=00a307'), original.replace(b'test.c.4"', b'test.c.5"'),
                 original.replace(b'authors: "nbraud"', b'authors: "Someone else"'),
                 original+b'\nextra-source "test.c" { src: "https://example.org/a" checksum: "sha256='+b'0'*64+b'" }\n']
        for data in cases:
            with self.subTest(data=data[-100:]), self.assertRaises(ValueError): model.semantics(data, identity)
        description = b'\ndescription: """\nextra-source "test.c" { src: "fake" }\n"""\n'
        model.semantics(original+description, identity)

    def test_standard_terms_preserve_placeholders_and_never_become_original_notices(self):
        _, component, files, native = self.collect('conf-rust-2024.1')
        self.assertEqual(component['notices'], [])
        mit = next(x for x in component['licenseEvidence']['referenceTerms'] if x['id'] == 'MIT')
        self.assertIn('<year>', mit['text']); self.assertIn('<copyright holders>', mit['text'])
        for mutate in (lambda c: c['licenseEvidence']['referenceTerms'][-1].update(role='original-upstream-notice'),
                       lambda c: c['licenseEvidence']['referenceTerms'][-1].update(text=mit['text'].replace('<year>', '2026')),
                       lambda c: c.update(notices=[ledger.notice(mit['path'], files[mit['path']])])):
            altered = copy.deepcopy(component); mutate(altered)
            with self.assertRaises(ValueError): model.validate_component(altered, files, native)

    def test_publisher_and_consumer_ledger_dispatch_keep_required_evidence_and_sources(self):
        _, component, files, native = self.collect('conf-gmp.5')
        value, sources, full_native = fixture_ledger('b'*64)
        value['components'][0] = component; value['closure']['opamInstalled'] = ['conf-gmp.5']
        full_native.update(native); sources[component['correspondingSource']['filename']] = (self.output/component['correspondingSource']['filename']).read_bytes()
        ledger.validate_ledger(value, 'b'*64, full_native); ledger.validate_sources(value, sources.__getitem__)
        altered = copy.deepcopy(value); altered['components'][0].pop('licenseEvidence'); altered['components'][0]['licenseExpression'] = 'CC0-1.0'
        with self.assertRaises(ValueError): ledger.validate_ledger(altered, 'b'*64, full_native)
        altered = copy.deepcopy(value); altered['components'][0]['licenseEvidence']['format'] = 'unknown-waiver/v1'
        with self.assertRaises(ValueError): ledger.validate_ledger(altered, 'b'*64, full_native)

    def test_original_archive_and_extra_source_alias_are_both_retained(self):
        self.assertEqual(REAL_COMPILER_ARCHIVE_POLICY['sha256'], '6fcf1b192e389e54c4f5cb51306ab2baee2a54a25b1770366de5a8b42695996e')
        self.assertEqual(REAL_COMPILER_ARCHIVE_POLICY['bytes'], 6314659)
        _, component, files, native = self.collect('ocaml-compiler.5.4.0')
        self.assertIn('source/original-archive', files)
        self.assertEqual(files['source/original-archive'], UNIT_ARCHIVE)
        self.assertEqual(len(files['source/extra/ocaml-compiler.install']), 98)
        altered = dict(files); altered['source/original-archive'] += b'changed'
        with self.assertRaises(ValueError): model.validate_component(component, altered, native)

    def test_authenticated_actual_p3_metadata_preserves_six_source_semantics(self):
        # Genuine native OPAM serialization from authenticated P3 GPE. This
        # regression proves metadata equivalence, not complete image sources.
        directory = FIXTURES/'actual-p3'; binding = json.loads((directory/'binding.json').read_bytes())
        self.assertEqual(binding['runId'], 40821968979)
        self.assertEqual(binding['headSha'], '372abb23b3fcbc23b6d4402cfff9b92d02502d62')
        self.assertEqual(binding['captureSha256'], '86e9ca5c91c6501311cc70b4c8a45552174bf7164b6dce71448b27e48628e7c5')
        for identity in sorted(model.REVIEWED_SOURCE_IDS):
            with self.subTest(identity=identity):
                package = package_fixture(identity)
                for key in ('opam', 'install', 'changes'):
                    data = (directory/identity/key).read_bytes()
                    self.assertEqual(model.record(data), binding['records'][identity][key])
                    package[key] = base64.b64encode(data).decode()
                if identity in model.PINNED_SOURCE_IDS:
                    tree = self.root/'opam-sources'/package['sourceDirectory']; tree.mkdir(parents=True, exist_ok=True)
                    for spec in model.policy(identity)['originalNotices']:
                        target = tree/spec['sourcePath']; target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes((FIXTURES/'pinned-opentelemetry'/spec['sourcePath']).read_bytes())
                model.semantics(base64.b64decode(package['opam']), identity)
                component = model.collect_component(package, self.root, self.output)
                files = model.source_files((self.output/component['correspondingSource']['filename']).read_bytes())
                native = {'opamPackages': package['name']+' '+package['version'],
                          'opamSourceEvidence': {identity: binding['records'][identity]}}
                model.validate_component(component, files, native)
                if identity == 'seq.base':
                    self.assertTrue(model.valid_seq_install(base64.b64decode(package['install'])))
                    self.assertIn(b'lib: "META.seq"', base64.b64decode(package['install']))

    def test_exact_five_opentelemetry_pins_keep_original_readme_and_atomic_directives(self):
        self.assertEqual(len(model.PINNED_SOURCE_IDS), 5)
        for identity in sorted(model.PINNED_SOURCE_IDS):
            with self.subTest(identity=identity):
                package, component, files, native = self.collect(identity)
                model.validate_component(component, files, native)
                self.assertEqual(component['licenseEvidence']['originalDeclaration']['license'], ['MIT'])
                self.assertIn('Per-File', component['licenseExpression'])
                self.assertEqual(component['licenseEvidence']['originalPinnedSource']['sourcePin'], model.policy(identity)['sourcePin'])
                self.assertIn(b'## License\n\nMIT', files['source/captured/README.md'])
                self.assertIn(b'GNU Lesser General Public License', files['source/captured/src/atomic/atomic.pre412.mli'])
                self.assertIn('<copyright holders>', next(x['text'] for x in component['licenseEvidence']['referenceTerms'] if x['id'] == 'MIT'))
                self.assertEqual(len(component['notices']), 3)
                self.assertNotIn('source/captured/LICENSE', files)

    def test_opentelemetry_other_commits_blanket_mit_or_missing_original_header_fail(self):
        identity = 'opentelemetry.0.91.1'
        package, component, files, native = self.collect(identity)
        altered = copy.deepcopy(package); altered['sourcePin'] = package['sourcePin'].replace('c3a03b', '00a03b')
        with self.assertRaises(ValueError): model.collect_component(altered, self.root, self.output)
        original = (FIXTURES/'metadata'/(identity+'.opam')).read_bytes()
        bad = original+b'\nurl { src: "git+https://github.com/semgrep/ocaml-opentelemetry.git#'+b'0'*40+b'" }\n'
        with self.assertRaises(ValueError): model.semantics(bad, identity)
        for path in ('source/captured/README.md', 'source/captured/src/atomic/atomic.pre412.mli'):
            altered_files = dict(files); altered_files.pop(path)
            with self.subTest(path=path), self.assertRaises(ValueError): model.validate_component(component, altered_files, native)
        altered_component = copy.deepcopy(component); altered_component['licenseExpression'] = 'MIT'
        with self.assertRaises(ValueError): model.validate_component(altered_component, files, native)
        altered_component = copy.deepcopy(component); altered_component['licenseEvidence']['originalPinnedSource']['sourceCommit'] = '0'*40
        with self.assertRaises(ValueError): model.validate_component(altered_component, files, native)

    def test_real_publisher_consumer_tool_roundtrip_requires_exact_native_extra_bindings(self):
        import build_semgrep_source as build
        import publish_semgrep_core_tool as publisher
        import semgrep_core_tool as consumer
        import source_core_identity as identity_module
        from test_publish_semgrep_core_tool import PublisherTests
        for identity in ('conf-libev.4-13', 'seq.base', 'ocaml-compiler.5.4.0', 'opentelemetry.0.91.1'):
            with self.subTest(identity=identity):
                _, component, files, native = self.collect(identity)
                case = PublisherTests(); case.setUp(); self.addCleanup(case.doCleanups)
                case.native['opamPackages'] = native['opamPackages']; case.write('sourcebuild-native-provenance.json', case.native)
                case.actual_closure.update(opamSourceEvidence=native['opamSourceEvidence'])
                case.license_value['closure']['opamInstalled'] = [identity]; case.license_value['components'][0] = component
                filename = component['correspondingSource']['filename']
                (case.dependencies/filename).write_bytes((self.output/filename).read_bytes())
                case.ledger.write_bytes(publisher.encoded(case.license_value))
                receipt = case.prepare()
                archive_bytes = (case.root/'tool-output'/consumer.ARCHIVE).read_bytes(); buffer = io.BytesIO()
                with zipfile.ZipFile(buffer, 'w') as archive: archive.writestr(consumer.ARCHIVE, archive_bytes)
                outer = buffer.getvalue()
                pin = {'format': consumer.FORMAT, 'repository': {'fullName': 'synthetic/gp', 'id': 1},
                    'run': {'id': 2, 'attempt': 1, 'headSha': 'a'*40, 'workflowId': 3, 'workflowPath': '.github/workflows/sast-source-build.yml'},
                    'artifact': {'id': 4, 'name': 'semgrep-core-tool-2-1', 'bytes': len(outer), 'sha256': publisher.sha(outer)},
                    'archive': {'name': consumer.ARCHIVE, 'bytes': len(archive_bytes), 'sha256': publisher.sha(archive_bytes)},
                    'manifestSha256': receipt['manifest']['sha256'], 'native': receipt['core'],
                    'wrapper': {'version': build.VERSION, 'requirementsSha256': case.build_inputs['requirementsSha256']},
                    'toolsConfigurationSha256': case.build_inputs['toolsConfigurationSha256'], 'source': consumer.UPSTREAM,
                    'buildInputs': case.build_inputs, 'buildInputsSha256': identity_module.digest(identity_module.canonical(case.build_inputs))}
                actual, _ = consumer.verify_zip(outer, pin)
                self.assertEqual(actual, case.core.read_bytes())
                case.actual_closure['opamSourceEvidence'][identity]['opam']['sha256'] = '0'*64
                with self.assertRaises(ValueError): case.prepare('wrong-actual-extra-metadata')


if __name__ == '__main__': unittest.main()
