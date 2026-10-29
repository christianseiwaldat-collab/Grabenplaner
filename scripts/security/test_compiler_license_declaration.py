import base64
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import compiler_license_ledger as ledger
import compiler_license_declaration as declaration
from test_compiler_license_ledger import fixture_ledger


class ExactConfigDeclarationTests(unittest.TestCase):
    def setUp(self):
        fixtures = Path(__file__).parent / 'fixtures' / 'ocaml-config.3'
        self.metadata = (fixtures / 'opam').read_bytes()
        self.originals = {name: (fixtures / name).read_bytes() for name, *_ in declaration.ORIGINALS}
        # A test generated-file example with explicit simulated image binding.
        # Real publication binds this to a fresh read of the exact built image.
        self.installed = self.originals['gen_ocaml_config.ml.in'].replace(b'%{ocaml-system:installed}%', b'false').replace(b'%%', b'%')
        self.package = {'id': declaration.PACKAGE, 'name': 'ocaml-config', 'version': '3', 'sourceDirectory': None, 'sourcePin': None,
            'opam': base64.b64encode(self.metadata).decode(), 'install': base64.b64encode(self.originals['ocaml-config.install']).decode(), 'changes': '',
            'installedSource': {'imagePath': declaration.INSTALLED_PATH, 'bytes': len(self.installed), 'sha256': ledger.digest(self.installed),
                'content': base64.b64encode(self.installed).decode()}}
        self.evidence, self.files = declaration.build_evidence(self.package, self.metadata, self.originals, {})
        self.component = {'name': 'opam/ocaml-config', 'version': '3', 'packageIds': [declaration.PACKAGE], 'licenseExpression': 'ISC',
            'notices': [], 'licenseEvidence': self.evidence, 'correspondingSource': {'url': declaration.DECLARATION_URL}}
        self.native = {'opamSourceEvidence': declaration.actual_source_evidence({'opamPackages': [self.package], 'opamListing': 'ocaml-config 3'})}

    def validate(self):
        return declaration.validate_declaration(self.component, self.files, self.native)

    def test_exact_original_declaration_sources_installed_bytes_and_reference_are_separate(self):
        self.validate()
        self.assertEqual(self.component['notices'], [])
        self.assertIn(b'<year> <owner>', declaration.REFERENCE_BYTES)
        self.assertNotEqual(self.files['source/installed/gen_ocaml_config.ml'], self.files['source/original/gen_ocaml_config.ml.in'])
        self.assertEqual(declaration.standard_reference()['role'], 'standard-license-reference')

    def test_changed_declaration_sources_url_hash_isc_or_reference_placeholders_are_rejected(self):
        mutations = [
            lambda c: c['licenseEvidence']['originalDeclaration'].update(sha256='0' * 64),
            lambda c: c['licenseEvidence']['originalSources'][0].update(url='https://example.org/elsewhere'),
            lambda c: c['licenseEvidence']['originalSources'][1].update(sha256='0' * 64),
            lambda c: c.update(licenseExpression='MIT'),
            lambda c: c['licenseEvidence']['standardLicenseReference'].update(text=declaration.REFERENCE_BYTES.decode().replace('<owner>', 'Invented Owner')),
            lambda c: c['licenseEvidence']['standardLicenseReference'].update(role='original-upstream-notice'),
            lambda c: c['licenseEvidence']['originalDeclaration'].update(authors=['Invented Author']),
            lambda c: c['correspondingSource'].update(url='https://example.org/source'),
        ]
        for change in mutations:
            with self.subTest(change=change):
                component = copy.deepcopy(self.component); change(component)
                with self.assertRaises(ValueError): declaration.validate_declaration(component, self.files, self.native)
        for name in ['metadata/opam', 'source/original/gen_ocaml_config.ml.in', 'reference/ISC.txt', 'source/installed/gen_ocaml_config.ml']:
            with self.subTest(name=name):
                files = dict(self.files); files[name] += b'changed'
                with self.assertRaisesRegex(ValueError, 'bytes differ'): declaration.validate_declaration(self.component, files, self.native)

    def test_unknown_package_version_and_claimed_original_notice_do_not_inherit_model(self):
        for key,value in [('name','opam/other'),('version','4'),('packageIds',['other.3']),('notices',[ledger.notice('LICENSE',declaration.REFERENCE_BYTES)])]:
            component=copy.deepcopy(self.component);component[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError): declaration.validate_declaration(component,self.files,self.native)
        files=dict(self.files);files['source/captured/LICENSE']=b'genuine new upstream notice must be preserved'
        with self.assertRaisesRegex(ValueError,'normal notice model'): declaration.validate_declaration(self.component,files,self.native)

    def test_missing_installed_image_binding_or_original_source_fails(self):
        with self.assertRaisesRegex(ValueError,'actual qualified image'): declaration.validate_declaration(self.component,self.files,{})
        with self.assertRaisesRegex(ValueError,'omitted'): declaration.actual_source_evidence({'opamPackages':[],'opamListing':'ocaml-config 3'})
        for name in ['source/original/ocaml-config.install','metadata/install','source/installed/gen_ocaml_config.ml']:
            files=dict(self.files);del files[name]
            with self.subTest(name=name),self.assertRaises(ValueError): declaration.validate_declaration(self.component,files,self.native)

    def test_shared_full_ledger_validation_keeps_all_other_original_notices_strict(self):
        value,sources,native=fixture_ledger('b'*64)
        value['closure']['opamInstalled']=['ocaml-config.3'];native.update(opamPackages='ocaml-config 3',**self.native)
        data=ledger.source_archive(self.files)
        component=copy.deepcopy(self.component);component['correspondingSource'].update(filename='config.tar.xz',bytes=len(data),sha256=ledger.digest(data))
        value['components'][0]=component;sources['config.tar.xz']=data
        ledger.validate_ledger(value,'b'*64,native);ledger.validate_sources(value,sources.__getitem__)
        value['components'][1]['notices']=[]
        with self.assertRaisesRegex(ValueError,'Missing primary'):ledger.validate_ledger(value,'b'*64,native)

    def test_publisher_and_independent_consumer_verify_exact_declaration_model(self):
        import io
        import zipfile
        import build_semgrep_source as build
        import publish_semgrep_core_tool as publisher
        import semgrep_core_tool as consumer
        import source_core_identity as identity
        from test_publish_semgrep_core_tool import PublisherTests
        case = PublisherTests(); case.setUp(); self.addCleanup(case.doCleanups)
        case.native['opamPackages'] = 'ocaml-config 3'
        case.write('sourcebuild-native-provenance.json', case.native)
        case.actual_closure.update(self.native)
        case.license_value['closure']['opamInstalled'] = ['ocaml-config.3']
        data = ledger.source_archive(self.files)
        component = copy.deepcopy(self.component)
        component['correspondingSource'].update(filename='config.tar.xz', bytes=len(data), sha256=ledger.digest(data))
        case.license_value['components'][0] = component
        (case.dependencies / 'config.tar.xz').write_bytes(data)
        case.ledger.write_bytes(publisher.encoded(case.license_value))
        receipt = case.prepare()
        archive_data = (case.root / 'tool-output' / consumer.ARCHIVE).read_bytes()
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive: archive.writestr(consumer.ARCHIVE, archive_data)
        outer = buffer.getvalue()
        pin = {'format': consumer.FORMAT, 'repository': {'fullName': 'synthetic/gp', 'id': 1},
            'run': {'id': 2, 'attempt': 1, 'headSha': 'a' * 40, 'workflowId': 3, 'workflowPath': '.github/workflows/sast-source-build.yml'},
            'artifact': {'id': 4, 'name': 'semgrep-core-tool-2-1', 'bytes': len(outer), 'sha256': publisher.sha(outer)},
            'archive': {'name': consumer.ARCHIVE, 'bytes': len(archive_data), 'sha256': publisher.sha(archive_data)},
            'manifestSha256': receipt['manifest']['sha256'], 'native': receipt['core'],
            'wrapper': {'version': build.VERSION, 'requirementsSha256': case.build_inputs['requirementsSha256']},
            'toolsConfigurationSha256': case.build_inputs['toolsConfigurationSha256'], 'source': consumer.UPSTREAM,
            'buildInputs': case.build_inputs, 'buildInputsSha256': identity.digest(identity.canonical(case.build_inputs))}
        actual, _ = consumer.verify_zip(outer, pin)
        self.assertEqual(actual, case.core.read_bytes())
        # Publisher rereads installed source evidence independently of the ledger.
        case.actual_closure['opamSourceEvidence'] = {declaration.PACKAGE: {'bytes': len(self.installed), 'sha256': '0' * 64}}
        with self.assertRaisesRegex(ValueError, 'actual qualified image'): case.prepare('wrong-image-source')

    def test_collector_preserves_actual_sources_and_uses_exact_source_hashes(self):
        def download(url,maximum=ledger.MAX_FILE):
            for name,source_url,*_ in declaration.ORIGINALS:
                if url==source_url:return self.originals[name]
            return b'CC0 original metadata reference fixture'
        with tempfile.TemporaryDirectory() as directory,patch.object(ledger,'download',side_effect=download):
            root=Path(directory);output=root/'out';output.mkdir()
            components=ledger.collect_opam({'opamPackages':[self.package]},root,output)
            ledger.validate_sources({'components':components},lambda name:(output/name).read_bytes())
            self.assertEqual(components[0]['notices'],[])
            with self.assertRaisesRegex(ValueError,'declaration differs'):
                bad=copy.deepcopy(self.package);bad['opam']=base64.b64encode(self.metadata+b'changed').decode()
                ledger.collect_opam({'opamPackages':[bad]},root,output)


class InlineOpamBlockTests(unittest.TestCase):
    def test_inline_brace_strings_escaped_braces_comments_and_fake_header(self):
        text='description: """fake\nurl {\n src: \"not a URL\"\n}\n"""\nurl {\n src: "https://example.org/src-{ok}.tbz" # } ignored\n checksum: "sha512='+'f'*128+'"}\n'
        self.assertEqual(ledger.source_url(text),('https://example.org/src-{ok}.tbz',['sha512='+'f'*128]))
        for invalid in [text+'url {\n src: "https://example.org/b"\n checksum: "sha256='+'a'*64+'"}\n', 'url {\n src: "unterminated']:
            with self.subTest(invalid=invalid),self.assertRaises(ValueError):ledger.source_url(invalid)


if __name__=='__main__':unittest.main()
