"""Synthetic packaging-bound contracts, no producer/binary/publish authority."""
import ctypes
import ctypes.util
import io
import lzma
import os
from pathlib import Path
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import collect_p3_capture_diagnostic as diagnostic
import publish_semgrep_core_tool as publisher
import semgrep_core_tool as consumer


class BufferBound:
    def __call__(self,size):return size+4096


class PackagingBoundTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.sources=self.root/'source-bundles';self.sources.mkdir()
        self.upstream=self.root/'upstream';self.upstream.mkdir();(self.upstream/'LICENSE').write_bytes(b'Explicit synthetic license bytes\n')
        self.private=self.root/'private';self.private.mkdir()
        self.data=b'Explicit synthetic opaque dependency source archive bytes\n'
        (self.sources/'test.tar.xz').write_bytes(self.data)
        self.components=[{'correspondingSource':{'filename':'test.tar.xz','bytes':len(self.data),'sha256':publisher.sha(self.data),'url':'https://example.org/synthetic'}}]
        self.members={'upstream/LICENSE':(b'Explicit synthetic upstream source\n',0o644,'regular')}
        self.patches=[patch.object(publisher,'source_members',return_value=(self.members,b'Explicit synthetic patch\n')),
            patch.object(publisher,'read_json',return_value={'synthetic':'source-provenance-only'}),
            patch.object(ctypes.util,'find_library',return_value='synthetic-lib-used-only-for-unit'),
            patch.object(ctypes,'CDLL',return_value=SimpleNamespace(lzma_stream_buffer_bound=BufferBound()))]
        for p in self.patches:p.start();self.addCleanup(p.stop)
    def run_bound(self):return diagnostic.diagnostic_packaging_bound(self.root,self.upstream,self.private,self.sources,self.components)
    def test_exact_source_archive_measured_without_native_binary_or_publication(self):
        got=self.run_bound()
        expected=publisher.archive_bytes(self.members,corresponding_source=True)
        self.assertEqual(got['measuredCorrespondingSource']['bytes'],len(expected))
        self.assertEqual(got['measuredCorrespondingSource']['sha256'],publisher.sha(expected))
        self.assertEqual(got['outerMemberUpperBounds']['bin/semgrep-core'],256*1024**2)
        self.assertTrue(got['guaranteedForExactMeasuredSourcesWithinExistingLimits'])
        for field in ('nativeBinaryRead','compilerBuilt','compilerExecuted','qualificationPerformed','toolPublished','pinChanged','publicationReady'):self.assertFalse(got[field])
    def test_header_payload_and_record_padding_bound_matches_real_ustar_construction(self):
        got=self.run_bound();sizes=got['outerMemberUpperBounds']
        # Smaller synthetic payload widths preserve actual USTAR record logic.
        tiny={n:(b'x'*(i+1),0o755 if n=='bin/semgrep-core' else 0o644,'regular')for i,n in enumerate(sizes)}
        actual=lzma.decompress(publisher.archive_bytes(tiny))
        expected=sum(512+((len(v[0])+511)//512)*512 for v in tiny.values())+1024
        expected=((expected+tarfile.RECORDSIZE-1)//tarfile.RECORDSIZE)*tarfile.RECORDSIZE
        self.assertEqual(len(actual),expected)
    def test_nonfitting_conservative_bound_is_reported_never_silently_raised_or_approved(self):
        with patch.object(consumer,'MAX_ARCHIVE',128*1024**2):got=self.run_bound()
        self.assertFalse(got['guaranteedForExactMeasuredSourcesWithinExistingLimits'])
        self.assertFalse(got['outerXzFitsExistingArchiveLimit']);self.assertFalse(got['publicationReady'])
        self.assertEqual(got['existingArchiveLimitBytes'],128*1024**2)
    def test_changed_or_conflicting_corresponding_source_is_rejected_before_measurement(self):
        self.components.append({'correspondingSource':{**self.components[0]['correspondingSource'],'bytes':1}})
        with self.assertRaisesRegex(ValueError,'Conflicting'):self.run_bound()
        self.components.pop();(self.sources/'test.tar.xz').write_bytes(self.data+b'changed')
        with self.assertRaisesRegex(ValueError,'source identity differs'):self.run_bound()
    def test_missing_or_invalid_system_lzma_bound_rejected(self):
        with patch.object(ctypes.util,'find_library',return_value=None),self.assertRaisesRegex(ValueError,'unavailable'):self.run_bound()
        class BadBound:
            def __call__(self,size):return 0
        with patch.object(ctypes,'CDLL',return_value=SimpleNamespace(lzma_stream_buffer_bound=BadBound())),self.assertRaisesRegex(ValueError,'bound is invalid'):self.run_bound()
    @unittest.skipUnless(sys.platform=='linux','Real system liblzma bound is verified on nativeLinux')
    def test_real_linux_liblzma_bound_covers_actual_default_xz_encoder(self):
        self.patches[-1].stop();self.patches[-2].stop()
        name=ctypes.util.find_library('lzma');self.assertTrue(name)
        function=ctypes.CDLL(name).lzma_stream_buffer_bound;function.argtypes=[ctypes.c_size_t];function.restype=ctypes.c_size_t
        for size in (1,4096,1024**2):
            data=os.urandom(size);self.assertLessEqual(len(lzma.compress(data)),int(function(size))+1024**2)

if __name__=='__main__':unittest.main()
