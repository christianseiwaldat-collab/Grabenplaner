import copy
import datetime as dt
import hashlib
from pathlib import Path
import tempfile
import unittest

from sast_dispositions import canonical_rule_id, finding_identity, apply_dispositions, newline_hash_variants, scanner_position


class DispositionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);(self.root/'server.js').write_bytes(b'validated render source')
        (self.root/'encoder.js').write_bytes(b'context escaping contract')
        self.finding={'rule':'javascript.lang.security.example','path':'server.js','start':{'line':1,'column':2},'end':{'line':1,'column':8},'sourceSha256':self.sha('server.js')}
        self.finding['fingerprint']=finding_identity(self.finding['rule'],self.finding['path'],self.finding['start'],self.finding['end'])
        self.row={**self.finding,'sourceSha256Variants':[self.finding['sourceSha256']],'classification':'reviewed_false_positive','priority':'P2','reason':'The exact reviewed interpolation passes through the dedicated HTML encoder, whose bytes and calling context are bound below.','reviewer':'independent-reviewer','reviewedOn':'2026-10-18','expiresOn':'2026-11-01','context':[{'path':p,'sha256':self.sha(p),'sha256Variants':[self.sha(p)],'reason':'Exact source and encoder boundary reviewed together.'} for p in ('server.js','encoder.js')]}
        self.policy={'schemaVersion':1,'dispositions':[self.row]}

    def sha(self,path):return hashlib.sha256((self.root/path).read_bytes()).hexdigest()
    def apply(self,policy=None,findings=None):return apply_dispositions(policy or self.policy,findings if findings is not None else [self.finding],self.root,dt.date(2026,10,18))

    def test_canonical_identity_is_independent_of_profile_platform_prefix(self):
        rule=self.finding['rule']
        for prefix in ('','tmp.run.sast-profiles.common.rules.','C.tools.rules.','output.express.rules.'):
            self.assertEqual(canonical_rule_id(prefix+rule,[rule]),rule)
        for raw,allowed in [('unexpected',[rule]),(rule,[rule,'lang.security.example'])]:
            with self.assertRaises(ValueError):canonical_rule_id(raw,allowed)

    def test_columns_distinguish_findings_on_same_line(self):
        changed={**self.finding['start'],'column':3}
        self.assertNotEqual(self.finding['fingerprint'],finding_identity(self.finding['rule'],self.finding['path'],changed,self.finding['end']))

    def test_native_semgrep_json_col_maps_exactly_to_review_column(self):
        self.assertEqual(scanner_position({'line':125,'col':7,'offset':2704}),{'line':125,'column':7})
        for bad in ({'line':1,'column':2,'offset':0},{'line':1,'col':0,'offset':0},{'line':1,'col':True,'offset':0},{'line':1,'col':2,'offset':-1},{'line':1,'col':2}):
            with self.assertRaises(ValueError):scanner_position(bad)

    def test_exact_review_passes_and_empty_policy_keeps_findings(self):
        self.assertEqual(self.apply()['blockingFindings'],[])
        self.assertEqual(len(self.apply({'schemaVersion':1,'dispositions':[]})['blockingFindings']),1)

    def test_context_drift_missing_file_and_finding_source_drift_fail(self):
        for path in ('encoder.js','server.js'):
            original=(self.root/path).read_bytes();(self.root/path).write_bytes(original+b' changed')
            with self.assertRaises(ValueError):self.apply()
            (self.root/path).write_bytes(original)
        (self.root/'encoder.js').unlink()
        with self.assertRaises(ValueError):self.apply()

    def test_unreviewed_expired_future_or_overlong_decision_fails(self):
        for key,value in [('classification','accepted_risk'),('expiresOn','2026-10-17'),('expiresOn','2026-11-18'),('reviewedOn','2026-10-19'),('reviewer',''),('reason','looks safe')]:
            policy=copy.deepcopy(self.policy);policy['dispositions'][0][key]=value
            with self.subTest(key=key,value=value),self.assertRaises(ValueError):self.apply(policy)
        policy=copy.deepcopy(self.policy);policy['dispositions'][0].update(priority='P1',expiresOn='2026-11-02')
        with self.assertRaises(ValueError):self.apply(policy)

    def test_unmatched_duplicate_wildcard_and_incomplete_contract_fail(self):
        with self.assertRaises(ValueError):self.apply(findings=[])
        policy=copy.deepcopy(self.policy);policy['dispositions'].append(copy.deepcopy(self.row))
        with self.assertRaises(ValueError):self.apply(policy)
        for mutation in ('path','context','fingerprint','sourceSha256'):
            policy=copy.deepcopy(self.policy);row=policy['dispositions'][0]
            row[mutation]=[] if mutation=='context' else '*'
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.apply(policy)
        policy=copy.deepcopy(self.policy);policy['dispositions'][0]['context']=policy['dispositions'][0]['context'][1:]
        with self.assertRaises(ValueError):self.apply(policy)

    def test_unsafe_context_and_duplicate_findings_fail(self):
        for path in ('../encoder.js','C:\\encoder.js','/encoder.js'):
            policy=copy.deepcopy(self.policy);policy['dispositions'][0]['context'][0]['path']=path
            with self.subTest(path=path),self.assertRaises(ValueError):self.apply(policy)
        with self.assertRaises(ValueError):self.apply(findings=[self.finding,self.finding])

    def test_explicit_newline_variants_preserve_raw_finding_hash(self):
        reviewed=b'validated source\r\nsecond line\nthird line\r\n'
        (self.root/'server.js').write_bytes(reviewed)
        self.row['sourceSha256']=self.sha('server.js')
        self.row['sourceSha256Variants']=newline_hash_variants(reviewed)
        self.row['context'][0].update(sha256=self.row['sourceSha256'],sha256Variants=self.row['sourceSha256Variants'])
        encoder=b'context escaping\r\ncontract\r\n'
        (self.root/'encoder.js').write_bytes(encoder)
        self.row['context'][1].update(sha256=self.sha('encoder.js'),sha256Variants=newline_hash_variants(encoder))
        (self.root/'encoder.js').write_bytes(encoder.replace(b'\r\n',b'\n'))
        lf=reviewed.replace(b'\r\n',b'\n')
        for variant in (reviewed,lf,lf.replace(b'\n',b'\r\n')):
            (self.root/'server.js').write_bytes(variant);self.finding['sourceSha256']=self.sha('server.js')
            self.assertEqual(self.apply()['blockingFindings'],[])
        self.finding['sourceSha256']=self.row['sourceSha256']
        with self.assertRaises(ValueError):self.apply()
        (self.root/'server.js').write_bytes(lf.replace(b'source',b'changed'))
        self.finding['sourceSha256']=self.sha('server.js')
        with self.assertRaises(ValueError):self.apply()

    def test_variant_schema_and_context_variant_drift_fail_closed(self):
        for bad in ([],['*'],[self.sha('server.js')]*2,['a'*64],['a'*64,'b'*64,'c'*64,'d'*64]):
            policy=copy.deepcopy(self.policy);policy['dispositions'][0]['sourceSha256Variants']=bad
            with self.subTest(bad=bad),self.assertRaises(ValueError):self.apply(policy)
        policy=copy.deepcopy(self.policy);del policy['dispositions'][0]['sourceSha256Variants']
        with self.assertRaises(ValueError):self.apply(policy)
        (self.root/'encoder.js').write_bytes(b'context escaping contract\n')
        with self.assertRaises(ValueError):self.apply()

    def test_review_helper_changes_no_non_newline_bytes(self):
        raw=b'\xef\xbb\xbf x\rvalue\t \r\ny\n'
        lf=raw.replace(b'\r\n',b'\n')
        expected={hashlib.sha256(v).hexdigest() for v in (raw,lf,lf.replace(b'\n',b'\r\n'))}
        self.assertEqual(set(newline_hash_variants(raw)),expected)
        self.assertNotIn(hashlib.sha256(lf.strip()).hexdigest(),expected)
        with self.assertRaises(ValueError):newline_hash_variants('text')


if __name__=='__main__':unittest.main()
