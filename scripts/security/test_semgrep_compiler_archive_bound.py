"""Conditional pinnedcompiler artifact1.5GiB routing; noGiB allocation."""
import copy
import io
import lzma
from pathlib import Path
import tarfile
import unittest
from unittest.mock import patch

import semgrep_core_tool as tool
import compiler_license_ledger as ledger
import publish_semgrep_core_tool as publisher
from test_semgrep_core_tool import fixture,metadata

MIB=1024**2
OLD=1024*MIB
NEW=1536*MIB


class ConditionalArchiveCapTests(unittest.TestCase):
    def setUp(self):self.data,self.pin,_=fixture()
    def sized_pin(self,size):
        pin=copy.deepcopy(self.pin);pin['artifact']['bytes']=size;pin['archive']['bytes']=size
        return pin
    def test_exact_external_pin_metadata_between_old_and_new_caps_is_accepted(self):
        for size in (OLD+1,NEW-1,NEW):
            pin=self.sized_pin(size);tool.validate_pin(pin)
            run,artifact=metadata(pin);tool.validate_metadata(pin,run,artifact)
        self.assertEqual(tool.MAX_ARCHIVE,NEW)
    def test_one_byte_over_new_outer_or_inner_bound_rejected_before_extraction(self):
        for key in ('artifact','archive'):
            pin=copy.deepcopy(self.pin);pin[key]['bytes']=NEW+1
            with self.subTest(key=key),patch.object(tool.zipfile,'ZipFile') as extract,self.assertRaisesRegex(ValueError,'Invalid pinned file identity'):
                tool.verify_zip(self.data,pin)
            extract.assert_not_called()
    def test_larger_pinned_identity_never_waives_actual_byte_or_digest_binding(self):
        pin=self.sized_pin(OLD+1)
        with patch.object(tool.zipfile,'ZipFile') as extract,self.assertRaisesRegex(ValueError,'identity mismatch'):
            tool.verify_zip(self.data,pin)
        extract.assert_not_called()
        pin=copy.deepcopy(self.pin);pin['artifact']['sha256']='f'*64
        with self.assertRaisesRegex(ValueError,'identity mismatch'):tool.verify_zip(self.data,pin)
    def test_download_retains_four_mib_metadata_and_exact_pinned_binary_limit(self):
        pin=self.sized_pin(OLD+1);run,artifact=metadata(pin)
        replies=[tool.canonical(run),tool.canonical(artifact),b'EXPLICITSYNTHETICDOWNLOADEDPROBE']
        with patch.object(tool,'github_request',side_effect=replies) as download,patch.object(tool,'verify_zip',return_value=('syntheticcore',{})) as verify:
            tool.fetch(pin,'synthetic-unit-token')
        self.assertEqual([call.args[2] for call in download.call_args_list],[4*MIB,4*MIB,OLD+1])
        self.assertTrue(download.call_args_list[-1].args[0].endswith('/zip'));verify.assert_called_once()
    def test_invalid_over_cap_or_wrong_producer_stops_before_artifact_download(self):
        for invalid in ('over-cap','wrong-head'):
            pin=self.sized_pin(NEW+1 if invalid=='over-cap' else OLD+1);run,artifact=metadata(pin)
            if invalid=='wrong-head':run['head_sha']='b'*40
            with patch.object(tool,'github_request',side_effect=[tool.canonical(run),tool.canonical(artifact)]) as download,patch.object(tool,'verify_zip') as extract,self.assertRaises(ValueError):
                tool.fetch(pin,'synthetic-unit-token')
            self.assertEqual(len(download.call_args_list),0 if invalid=='over-cap' else 2);self.assertFalse(any(call.args[0].endswith('/zip') for call in download.call_args_list));extract.assert_not_called()
    def test_native_source_file_expansion_and_all_json_bounds_stay_independent(self):
        self.assertEqual(tool.MAX_TOTAL,2*1024**3);self.assertEqual(tool.MAX_JSON,4*MIB)
        self.assertEqual(ledger.MAX_JSON,4*MIB);self.assertEqual(ledger.MAX_LEDGER_JSON,8*MIB)
        self.assertEqual(ledger.MAX_FILE,512*MIB);self.assertEqual(ledger.MAX_SOURCE,2*1024**3)
        self.assertEqual(publisher.MAX_SOURCE_FILE,512*MIB);self.assertEqual(publisher.MAX_SOURCE_TOTAL,2*1024**3)
        self.assertEqual(publisher.MAX_CORE,256*MIB)
        header=tarfile.TarInfo('COPYING');header.size=512*MIB+1
        data=lzma.compress(header.tobuf(format=tarfile.USTAR_FORMAT)+b'\0'*1024)
        with self.assertRaisesRegex(ValueError,'inventory exceeds bound'):ledger.source_notice_hashes(data)
        with self.assertRaises(ValueError):ledger.source_relative('../escape')
    def test_unpinned_arbitrary_zip_members_remain_rejected(self):
        def entries(archive,data):
            archive.writestr(tool.ARCHIVE,data);archive.writestr('arbitrary-unreviewed.bin',b'notallowed')
        data,pin,_=fixture(zip_entries=entries)
        with self.assertRaisesRegex(ValueError,'Unexpected Actions ZIP members'):tool.verify_zip(data,pin)


if __name__=='__main__':unittest.main()
