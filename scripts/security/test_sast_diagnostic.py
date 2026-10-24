import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from diagnose_sast_fixpoints import publish, result_summary


class DiagnosticBoundaryTests(unittest.TestCase):
    def test_warning_is_measurement_but_never_complete_analysis(self):
        with tempfile.TemporaryDirectory() as directory:
            stage=Path(directory);target=str(stage/'unsafe.js')
            result={'errors':[], 'paths':{'scanned':[target]}, 'results':[{'path':target}],
                    'time':{'fixpoint_timeouts':[{'error_type':'Fixpoint timeout','severity':'warn'}]}}
            summary=result_summary(result,{'unsafe.js'},stage,1)
            self.assertTrue(summary['executionEvidenceValid'])
            self.assertFalse(summary['analysisCompleteForCase'])
            self.assertEqual(summary['fixpointTimeoutCount'],1)
            result['time']['fixpoint_timeouts']=[]
            self.assertTrue(result_summary(result,{'unsafe.js'},stage,1)['analysisCompleteForCase'])
            for mutation in ({**result,'errors':[{'type':'Timeout'}]},
                             {**result,'paths':{'scanned':[]}},
                             {**result,'paths':{'scanned':[target],'skipped':[target]}}):
                self.assertFalse(result_summary(mutation,{'unsafe.js'},stage,1)['executionEvidenceValid'])
            self.assertFalse(result_summary(result,{'unsafe.js'},stage,0)['executionEvidenceValid'])
            result['time']={}
            with self.assertRaises(ValueError):result_summary(result,{'unsafe.js'},stage,1)

    def fixture(self,root):
        private=root/'private';public=root/'public';private.mkdir();public.mkdir()
        key=root/'public.pem';der=b'synthetic-public-key-not-used-for-encryption'
        key.write_text('-----BEGIN PUBLIC KEY-----\n'+base64.b64encode(der).decode()+'\n-----END PUBLIC KEY-----\n')
        receipt={'gate':'sast-diagnostic','diagnosticOnly':True,'securityGatePassed':False,
                 'complete':False,'passed':False,'diagnosticExecutionComplete':True,'controlsPassed':True,
                 'error':'PRIVATE_PATH_OR_DIAGNOSTIC_MUST_NOT_LEAK',
                 'cases':[{'name':'PRIVATE_FILENAME_MUST_NOT_LEAK','fixpointTimeoutCount':1}]}
        (private/'gate-result.json').write_text(json.dumps(receipt))
        envelope={'format':'gp-security-evidence-v1','recipientSha256':hashlib.sha256(der).hexdigest(),
                  **{name:base64.b64encode(bytes(size)).decode() for name,size in
                     [('wrappedKey',384),('iv',12),('tag',16),('ciphertext',16)]}}
        (public/'private-evidence.gpe').write_text(json.dumps(envelope))
        return private,public,key,receipt,envelope

    def environment(self):
        return patch.dict(os.environ,{'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1'})

    def test_publication_cannot_leak_raw_diagnostics_or_claim_security_success(self):
        with tempfile.TemporaryDirectory() as directory,self.environment():
            private,public,key,_,_=self.fixture(Path(directory))
            self.assertEqual(publish(private,public,key),0)
            self.assertEqual({p.name for p in public.iterdir()},
                             {'private-evidence.gpe','diagnostic-summary.json','diagnostic-upload-manifest.json'})
            summary=json.loads((public/'diagnostic-summary.json').read_text())
            self.assertTrue(summary['diagnosticOnly']);self.assertFalse(summary['securityGatePassed'])
            self.assertTrue(summary['executionComplete']);self.assertEqual(summary['fixpointTimeoutCount'],1)
            for filename in ('diagnostic-summary.json','diagnostic-upload-manifest.json'):
                self.assertNotIn('PRIVATE_',(public/filename).read_text())

    def test_gate_pass_or_wrong_gate_receipts_are_rejected(self):
        for key,value in [('securityGatePassed',True),('passed',True),('complete',True),('gate','sast')]:
            with self.subTest(key=key),tempfile.TemporaryDirectory() as directory,self.environment():
                private,public,public_key,receipt,_=self.fixture(Path(directory));receipt[key]=value
                (private/'gate-result.json').write_text(json.dumps(receipt))
                with self.assertRaises(ValueError):publish(private,public,public_key)
                self.assertFalse((public/'diagnostic-summary.json').exists())

    def test_extra_public_file_wrong_recipient_or_malformed_envelope_are_rejected(self):
        for mutation in ('extra-file','recipient','short-tag','invalid-run'):
            with self.subTest(mutation=mutation),tempfile.TemporaryDirectory() as directory,self.environment():
                private,public,key,_,envelope=self.fixture(Path(directory))
                if mutation=='extra-file':(public/'raw.json').write_text('PRIVATE')
                elif mutation=='recipient':envelope['recipientSha256']='b'*64
                elif mutation=='short-tag':envelope['tag']=base64.b64encode(bytes(15)).decode()
                else:os.environ['GITHUB_RUN_ID']='../private'
                (public/'private-evidence.gpe').write_text(json.dumps(envelope))
                with self.assertRaises(ValueError):publish(private,public,key)
                self.assertFalse((public/'diagnostic-summary.json').exists())


if __name__=='__main__':
    unittest.main()
