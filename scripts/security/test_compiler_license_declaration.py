import base64
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import compiler_license_declaration as model
import compiler_license_ledger as ledger

FIXTURES=Path(__file__).parent/'fixtures/license-declarations'


def package_fixture(identity):
    policy=model.POLICIES[identity]
    original=(FIXTURES/(identity+'.opam')).read_bytes()
    # Simulated installed serialization is intentionally byte-distinct. The
    # native OPAM formatter/capture contract has its own real Linux evidence.
    normalized=original+b'\nname: "'+policy['name'].encode()+b'"\nversion: "'+policy['version'].encode()+b'"\n'
    package={'id':identity,'name':policy['name'],'version':policy['version'],'opam':base64.b64encode(normalized).decode(),
        'install':base64.b64encode(b'lib: ["actual-installed-file"]\n').decode(),'changes':base64.b64encode(b'actual-install-change-fixture').decode(),
        'sourceDirectory':identity,'sourcePin':None}
    if identity=='ocaml-config.3':
        original_source=(Path(__file__).parent/'fixtures/ocaml-config.3/gen_ocaml_config.ml.in').read_bytes()
        installed=original_source.replace(b'%{ocaml-system:installed}%',b'false').replace(b'%%',b'%')
        package['installedSource']={'imagePath':model.INSTALLED_PATH,**model._record(installed),'content':base64.b64encode(installed).decode()}
        package['install']=base64.b64encode(b'share: ["gen_ocaml_config.ml"]\n').decode()
    return package


def primary_download(url,maximum=ledger.MAX_FILE):
    for identity,policy in model.POLICIES.items():
        if url==model._metadata_url(identity): return (FIXTURES/(identity+'.opam')).read_bytes()
    for key,spec in model.REFERENCES.items():
        if url==spec['url']:
            name={'OCaml-atomic-origin':'reference-OCaml-atomic.mli.txt'}.get(key,'reference-'+key+'.txt')
            return (FIXTURES/name).read_bytes()
    for name,source,*_ in model.CONFIG_ORIGINALS:
        if url==source:return (Path(__file__).parent/'fixtures/ocaml-config.3'/name).read_bytes()
    raise AssertionError('Unexpected source URL '+url)


class ReviewedDeclarationModelTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name)
        self.output=self.root/'out';self.output.mkdir()
        self.download=patch.object(ledger,'download',side_effect=primary_download);self.download.start();self.addCleanup(self.download.stop)
        for name in ['ambient-context-0.2','trace-0.12']:
            data=base64.b64decode((FIXTURES/(name+'.archive.base64')).read_bytes())
            digest=model.sha(data);path=self.root/'opam-download-cache/sha256'/digest[:2]/digest;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)

    def collect(self,identity):
        package=package_fixture(identity)
        tree=self.root/'opam-sources'/identity;tree.mkdir(parents=True,exist_ok=True)
        (tree/'actual-retained-marker.ml').write_bytes(b'actual captured source file retained verbatim\n')
        component=model.collect_component(package,self.root,self.output)
        data=(self.output/component['correspondingSource']['filename']).read_bytes()
        files=ledger.declaration_source_files(data)
        native={'opamPackages':package['name']+' '+package['version']+'\n',
            'opamSourceEvidence':model.actual_source_evidence({'opamPackages':[package],'opamListing':package['name']+' '+package['version']+'\n'})}
        return package,component,files,native

    def test_all_five_exact_packages_keep_original_normalized_and_complete_actual_sources(self):
        self.assertEqual(len(model.DECLARATION_IDS),5)
        for identity in sorted(model.DECLARATION_IDS):
            with self.subTest(identity=identity):
                package,component,files,native=self.collect(identity)
                model.validate_declaration(component,files,native)
                self.assertNotEqual(files['metadata/original-opam'],files['metadata/installed-opam'])
                self.assertEqual(files['source/captured/actual-retained-marker.ml'],b'actual captured source file retained verbatim\n')
                self.assertEqual(native['opamSourceEvidence'][identity]['opam'],model._record(files['metadata/installed-opam']))
                self.assertIn('metadata/install',files);self.assertIn('metadata/changes',files)
                if 'archive' in model.POLICIES[identity]:self.assertEqual(model.sha(files['source/original-archive']),model.POLICIES[identity]['archive']['sha256'])
                if identity=='ocaml-config.3':self.assertNotEqual(files['source/installed/gen_ocaml_config.ml'],files['source/original/gen_ocaml_config.ml.in'])

    def test_reference_placeholders_are_unchanged_and_never_claimed_as_original_notices(self):
        for identity,expected in [('ocaml-config.3',b'<year> <owner>'),('trace.0.12',b'<year> <copyright holders>')]:
            package,component,files,native=self.collect(identity)
            self.assertEqual(component['notices'],[])
            self.assertIn(expected,files[component['licenseEvidence']['referenceTerms'][0]['path']])
            forged=copy.deepcopy(component);forged['notices']=[ledger.notice('LICENSE',files[forged['licenseEvidence']['referenceTerms'][0]['path']])]
            with self.assertRaisesRegex(ValueError,'reference claimed as original'):model.validate_declaration(forged,files,native)

    def test_ambient_original_mit_readme_and_both_lgpl_file_notices_are_byte_exact_and_separate(self):
        package,component,files,native=self.collect('ambient-context.0.2')
        self.assertEqual(component['licenseExpression'],'LicenseRef-Reviewed-Ambient-Context-0.2-Per-File')
        self.assertEqual(len(component['notices']),3)
        notices={n['path']:n for n in component['notices']}
        for spec in model._notice_specs('ambient-context.0.2'):
            self.assertEqual(notices[spec['memberPath']]['sourceBytesSha256'],spec['sha256'])
        readme=notices['ambient-context-0.2/README.md']['text']
        self.assertIn('Copyright',readme);self.assertIn('2023 ELLIOTTCABLE',readme);self.assertIn('Permission is hereby granted',readme)
        for name in ['atomic.pre412.mli','atomic.post412.mli']:
            self.assertIn('GNU Lesser General Public License version 2.1',next(n['text'] for p,n in notices.items() if p.endswith(name)))
        forged=copy.deepcopy(component);forged['licenseExpression']='MIT'
        with self.assertRaises(ValueError):model.validate_declaration(forged,files,native)
        forged=copy.deepcopy(component);forged['notices'].pop()
        with self.assertRaises(ValueError):model.validate_declaration(forged,files,native)

    def test_altered_metadata_licensing_authors_sources_and_checksums_are_rejected_even_with_fresh_hashes(self):
        identity='trace.0.12';package=package_fixture(identity)
        for before,after in [(b'license: "MIT"',b'license: "ISC"'),(b'"Simon Cruanes"',b'"Invented Author"'),
                (b'https://github.com/ocaml-tracing/ocaml-trace/releases/download/v0.12/trace-0.12.tbz',b'https://example.org/other'),
                (model.POLICIES[identity]['archive']['sha256'].encode(),b'0'*64)]:
            changed=copy.deepcopy(package);raw=base64.b64decode(changed['opam']);self.assertIn(before,raw)
            changed['opam']=base64.b64encode(raw.replace(before,after)).decode()
            with self.subTest(before=before),self.assertRaises(ValueError):model.collect_component(changed,self.root,self.output)

    def test_altered_original_declaration_extra_source_and_installed_source_bytes_fail(self):
        package,component,files,native=self.collect('ocaml-config.3')
        for path in ['metadata/original-opam','metadata/installed-opam','metadata/install','metadata/changes',
                'source/original/gen_ocaml_config.ml.in','source/installed/gen_ocaml_config.ml','reference/ISC.txt']:
            altered=dict(files);altered[path]+=b'changed'
            with self.subTest(path=path),self.assertRaisesRegex(ValueError,'bytes differ'):model.validate_declaration(component,altered,native)
        altered=copy.deepcopy(package);altered['installedSource']['content']=base64.b64encode(b'changed source').decode()
        with self.assertRaisesRegex(ValueError,'bytes differ'):model.collect_component(altered,self.root,self.output)
        altered=copy.deepcopy(component);altered['licenseEvidence']['originalSources'][0]['url']='https://example.org/elsewhere'
        with self.assertRaises(ValueError):model.validate_declaration(altered,files,native)

    def test_actual_normalized_metadata_and_generated_source_need_independent_native_binding(self):
        package,component,files,native=self.collect('ocaml-config.3')
        for mutate in [lambda n:n.pop('opamSourceEvidence'),lambda n:n['opamSourceEvidence']['ocaml-config.3']['opam'].update(sha256='0'*64),
                lambda n:n['opamSourceEvidence']['ocaml-config.3']['installedSource'].update(sha256='0'*64)]:
            altered=copy.deepcopy(native);mutate(altered)
            with self.assertRaisesRegex(ValueError,'fresh qualified image'):model.validate_declaration(component,files,altered)
        with self.assertRaisesRegex(ValueError,'omitted'):model.actual_source_evidence({'opamPackages':[],'opamListing':'ocaml-config 3'})

    def test_no_other_package_version_unknown_license_or_reference_role_can_inherit_model(self):
        package,component,files,native=self.collect('trace.0.12')
        mutations=[lambda c:c.update(packageIds=['trace.0.13']),lambda c:c.update(name='opam/other'),lambda c:c.update(version='0.13'),
            lambda c:c.update(licenseExpression='UNKNOWN'),lambda c:c['licenseEvidence']['referenceTerms'][0].update(role='original-upstream-notice'),
            lambda c:c['licenseEvidence']['referenceTerms'][0].update(text=c['licenseEvidence']['referenceTerms'][0]['text'].replace('<year>','2026')),
            lambda c:c['licenseEvidence']['originalDeclaration'].update(authors=['Invented Author'])]
        for mutation in mutations:
            altered=copy.deepcopy(component);mutation(altered)
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):model.validate_declaration(altered,files,native)

    def test_publisher_and_independent_consumer_accept_config_ambient_and_trace_models(self):
        import io
        import zipfile
        import build_semgrep_source as build
        import publish_semgrep_core_tool as publisher
        import semgrep_core_tool as consumer
        import source_core_identity as identity_module
        from test_publish_semgrep_core_tool import PublisherTests
        for identity in ['ocaml-config.3','ambient-context.0.2','trace.0.12']:
            with self.subTest(identity=identity):
                package,component,files,native=self.collect(identity)
                case=PublisherTests();case.setUp();self.addCleanup(case.doCleanups)
                case.native['opamPackages']=native['opamPackages'];case.write('sourcebuild-native-provenance.json',case.native)
                case.actual_closure.update(opamSourceEvidence=native['opamSourceEvidence'])
                case.license_value['closure']['opamInstalled']=[identity];case.license_value['components'][0]=component
                filename=component['correspondingSource']['filename']
                (case.dependencies/filename).write_bytes((self.output/filename).read_bytes())
                case.ledger.write_bytes(publisher.encoded(case.license_value))
                receipt=case.prepare()
                data=(case.root/'tool-output'/consumer.ARCHIVE).read_bytes();buffer=io.BytesIO()
                with zipfile.ZipFile(buffer,'w') as archive:archive.writestr(consumer.ARCHIVE,data)
                outer=buffer.getvalue()
                pin={'format':consumer.FORMAT,'repository':{'fullName':'synthetic/gp','id':1},
                    'run':{'id':2,'attempt':1,'headSha':'a'*40,'workflowId':3,'workflowPath':'.github/workflows/sast-source-build.yml'},
                    'artifact':{'id':4,'name':'semgrep-core-tool-2-1','bytes':len(outer),'sha256':publisher.sha(outer)},
                    'archive':{'name':consumer.ARCHIVE,'bytes':len(data),'sha256':publisher.sha(data)},
                    'manifestSha256':receipt['manifest']['sha256'],'native':receipt['core'],
                    'wrapper':{'version':build.VERSION,'requirementsSha256':case.build_inputs['requirementsSha256']},
                    'toolsConfigurationSha256':case.build_inputs['toolsConfigurationSha256'],'source':consumer.UPSTREAM,
                    'buildInputs':case.build_inputs,'buildInputsSha256':identity_module.digest(identity_module.canonical(case.build_inputs))}
                actual,_=consumer.verify_zip(outer,pin)
                self.assertEqual(actual,case.core.read_bytes())
                # An independently changed actual metadata digest cannot publish.
                case.actual_closure['opamSourceEvidence'][identity]['opam']['sha256']='0'*64
                with self.assertRaisesRegex(ValueError,'fresh qualified image'):case.prepare('wrong-actual-metadata')

    def test_native_fake_opam252_write_regression_preserves_semantics_without_runtime_qualification(self):
        identity='ocaml-config.3'
        original=(FIXTURES/(identity+'.opam')).read_bytes()
        installed=(FIXTURES/'FAKE-opam2.5.2-config3-installed.opam').read_bytes()
        self.assertEqual(model._record(original),{'bytes':1265,'sha256':'eac491c01bd4de3e78443d55bd9948e107c9ad4c80b5d0f4c63de778b601aae3'})
        self.assertEqual(model._record(installed),{'bytes':1262,'sha256':'adf9c0f51afc068b891ce9277ee5c46c9cd79e578265d6e2432ebd635f33583b'})
        self.assertNotEqual(original,installed)
        self.assertEqual(model._semantics(original,identity),model._semantics(installed,identity))
        # Only these installed metadata bytes are native --fake output. The
        # generated runtime source below is still a synthetic unit fixture.
        package=package_fixture(identity);package['opam']=base64.b64encode(installed).decode()
        component=model.collect_component(package,self.root,self.output)
        files=ledger.declaration_source_files((self.output/component['correspondingSource']['filename']).read_bytes())
        native={'opamPackages':'ocaml-config 3','opamSourceEvidence':model.actual_source_evidence({'opamPackages':[package],'opamListing':'ocaml-config 3'})}
        model.validate_declaration(component,files,native)
        self.assertEqual(files['metadata/installed-opam'],installed)
        self.assertEqual(files['metadata/original-opam'],original)

    def test_duplicate_critical_fields_are_rejected_instead_of_firstmatch(self):
        original=(FIXTURES/'ocaml-config.3.opam').read_bytes()
        with self.assertRaisesRegex(ValueError,'Duplicate critical OPAM field: license'):
            model._semantics(original+b'\nlicense: "ISC"\n','ocaml-config.3')
        for key,line in [('name',b'name: "ocaml-config"'),('version',b'version: "3"'),('authors',b'authors: ["author"]'),
                ('patches',b'patches: ["patch"]'),('substs',b'substs: "file"')]:
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'Duplicate critical OPAM field: '+key):
                model._semantics(original+b'\n'+line+b' '+line+b'\n','ocaml-config.3')

    def test_duplicate_counter_ignores_quoted_commented_and_nested_field_lookalikes(self):
        original=(FIXTURES/'ocaml-config.3.opam').read_bytes()
        prefix=b'# license: "MIT"\ndescription: """\nlicense: "MIT"\nauthors: ["not a top-level author"]\n"""\n'
        self.assertEqual(model._semantics(prefix+original,'ocaml-config.3'),model._semantics(original,'ocaml-config.3'))
        # A fake expected license inside description cannot hide a different actual field.
        changed=original.replace(b'license: "ISC"',b'license: "MIT"')
        fake=b'description: """\nlicense: "ISC"\n"""\n'
        with self.assertRaisesRegex(ValueError,'license/authors differ'):model._semantics(fake+changed,'ocaml-config.3')

    def test_known_ambient_model_cannot_be_relabelled_as_ordinary_mit_notice_component(self):
        from test_compiler_license_ledger import fixture_ledger
        package,component,files,native=self.collect('ambient-context.0.2')
        value,sources,full_native=fixture_ledger('b'*64)
        value['closure']['opamInstalled']=['ambient-context.0.2'];value['components'][0]=component
        full_native.update(native)
        ledger.validate_ledger(value,'b'*64,full_native)
        component.pop('licenseEvidence');component['licenseExpression']='MIT'
        with self.assertRaisesRegex(ValueError,'reviewed|license evidence|typed|declaration'):
            ledger.validate_ledger(value,'b'*64,full_native)

    def test_omitted_original_archive_reference_or_installed_evidence_is_rejected(self):
        package,component,files,native=self.collect('ambient-context.0.2')
        for path in ['source/original-archive','metadata/original-opam','metadata/installed-opam','metadata/install','reference/OCaml-LICENSE.txt','reference/OCaml-atomic.mli.txt']:
            altered=dict(files);del altered[path]
            with self.subTest(path=path),self.assertRaises(ValueError):model.validate_declaration(component,altered,native)


if __name__=='__main__':unittest.main()
