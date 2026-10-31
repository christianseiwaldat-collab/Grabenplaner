"""Exact original OPAM extra sources and separately retained license scopes.

Eleven exact identities: six extra-source packages and five OTel Git pins.
No general virtual-package waiver. Original
declarations, actual normalized metadata, original extra bytes and genuine
file-specific directives are independent records; reference terms never become
invented copyright notices. Runtime source trees and original main archives stay
complete. Compiler identity binds this policy in both publisher and consumer.
"""
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile

from compiler_license_declaration import _reject_duplicate_critical_fields

FORMAT = 'gp-reviewed-opam-original-source-evidence/v1'
OPAM_COMMIT = '78d29aba187e8362b8ab86c189790c0af9153d4b'
DATA = json.loads('{"confLibevOriginalHeader":{"bytes":942,"sha256":"47f0d5d5cb4e69c0bd1ab026c28814893ae818896256b6dcd1589281fb507cb0"},"policies":{"conf-gmp-powm-sec.4":{"authors":["Etienne Millon <etienne@cryptosense.com>"],"declaredLicenses":["GPL-1.0-or-later"],"extraSources":[{"bytes":440,"checksums":["sha256=388b3879530257a7e6e59b68208ee2a52de7be30e40eb4d3a54419708fdad490","md5=29317f477fa828e18428660ef31064fb"],"name":"test.c","sha256":"388b3879530257a7e6e59b68208ee2a52de7be30e40eb4d3a54419708fdad490","url":"https://raw.githubusercontent.com/ocaml/opam-source-archives/main/patches/conf-gmp-powm-sec/test.c.3"}],"metadataBytes":1440,"metadataSha256":"8740c6d9e388a8d2081e3702b64826663dd0411a2e5004e612d5e2bed31877ba","name":"conf-gmp-powm-sec","noticeSpecs":[],"version":"4"},"conf-gmp.5":{"authors":["nbraud"],"declaredLicenses":["GPL-1.0-or-later"],"extraSources":[{"bytes":128,"checksums":["sha256=54a30735f1f271a2531526747e75716f4490dd7bc1546efd6498ccfe3cc4d6fb","md5=2fd2970c293c36222a6d299ec155823f"],"name":"test.c","sha256":"54a30735f1f271a2531526747e75716f4490dd7bc1546efd6498ccfe3cc4d6fb","url":"https://raw.githubusercontent.com/ocaml/opam-source-archives/main/patches/conf-gmp/test.c.4"}],"metadataBytes":2164,"metadataSha256":"0b84f83c98bc73e52fe57b44dc5f7eef62def903cda780ce4d3123756a86d5b1","name":"conf-gmp","noticeSpecs":[],"version":"5"},"conf-libev.4-13":{"authors":["Marc Lehmann"],"declaredLicenses":["BSD-2-Clause"],"extraSources":[{"bytes":8627,"checksums":["sha256=569e94c09c4722989c3acb0f6b709a5dd6218f79175268c7f40f4bd26abd4fc2","md5=0c92517ce8da8366129ee2fff4035951"],"name":"discover.ml","sha256":"569e94c09c4722989c3acb0f6b709a5dd6218f79175268c7f40f4bd26abd4fc2","url":"https://raw.githubusercontent.com/ocaml/opam-source-archives/main/patches/conf-libev/discover.ml.4-13"},{"bytes":29,"checksums":["sha256=4825462f8f84312caf9a2c797bbd24abc776d8a343de5561330314d846e5cf61","md5=f37b5eb73ebeb177dff1cd8bb2f38c4e"],"name":"build.sh","sha256":"4825462f8f84312caf9a2c797bbd24abc776d8a343de5561330314d846e5cf61","url":"https://raw.githubusercontent.com/ocaml/opam-source-archives/main/patches/conf-libev/build.sh"}],"metadataBytes":1784,"metadataSha256":"19bc9c6e0ba782eda64d7237763c5e5f67b8850089c0f5ff49b31fcc04b6b131","name":"conf-libev","noticeSpecs":[{"encoding":"utf8","path":"source/extra/discover.ml","sha256":"569e94c09c4722989c3acb0f6b709a5dd6218f79175268c7f40f4bd26abd4fc2","sourceBytesSha256":"569e94c09c4722989c3acb0f6b709a5dd6218f79175268c7f40f4bd26abd4fc2"}],"version":"4-13"},"conf-rust-2024.1":{"authors":["TriliTech","Simon Cruanes"],"declaredLicenses":["MIT"],"extraSources":[{"bytes":13,"checksums":["sha256=536e506bb90914c243a12b397b9a998f85ae2cbd9ba02dfd03a9e155ca5ca0f4"],"name":"test.rs","sha256":"536e506bb90914c243a12b397b9a998f85ae2cbd9ba02dfd03a9e155ca5ca0f4","url":"https://raw.githubusercontent.com/ocaml/opam-source-archives/main/patches/conf-rust-2021/test.rs"}],"metadataBytes":1552,"metadataSha256":"5e97a6c8b609765eae8e7283631d513c4798530281831aba1ff268cab42eb94f","name":"conf-rust-2024","noticeSpecs":[],"version":"1"},"ocaml-compiler.5.4.0":{"archive":{"bytes":6314659,"checksums":["sha256=6fcf1b192e389e54c4f5cb51306ab2baee2a54a25b1770366de5a8b42695996e"],"sha256":"6fcf1b192e389e54c4f5cb51306ab2baee2a54a25b1770366de5a8b42695996e","url":"https://github.com/ocaml/ocaml/releases/download/5.4.0/ocaml-5.4.0.tar.gz"},"authors":["Xavier Leroy","Damien Doligez","Alain Frisch","Jacques Garrigue","Didier R\\u00e9my","KC Sivaramakrishnan","J\\u00e9r\\u00f4me Vouillon"],"declaredLicenses":["LGPL-2.1-or-later WITH OCaml-LGPL-linking-exception"],"extraSources":[{"bytes":98,"checksums":["sha256=7af3dc34e6f9f3be2ffd8d32cd64fa650d6a036c86c4821a7033d24a90fba11c","md5=781ea69255fd0cb643a9617ff56fd6ba"],"name":"ocaml-compiler.install","sha256":"7af3dc34e6f9f3be2ffd8d32cd64fa650d6a036c86c4821a7033d24a90fba11c","url":"https://raw.githubusercontent.com/ocaml/ocaml/899b8f3bece45f55161dad72eaa223c2bb7202e8/ocaml-variants.install"}],"metadataBytes":5710,"metadataSha256":"317250e88785a2a27739b6a8e51f7bb2798373f6de0fca3a8983aac0a7e0bdf7","name":"ocaml-compiler","noticeSpecs":[{"encoding":"utf8","path":"ocaml-5.4.0/manual/LICENSE-for-the-manual","sha256":"6b4ae3e45e649d9e0a4543c5d47b7f0ed363b21b937755e9cc8a34f56e1f3b18","sourceBytesSha256":"6b4ae3e45e649d9e0a4543c5d47b7f0ed363b21b937755e9cc8a34f56e1f3b18"},{"encoding":"utf8","path":"ocaml-5.4.0/LICENSE","sha256":"65f47d3bf5a921011ac7fa30f23d54f9dffbe7683921eeb116d5ce8dc26ff0c1","sourceBytesSha256":"65f47d3bf5a921011ac7fa30f23d54f9dffbe7683921eeb116d5ce8dc26ff0c1"}],"version":"5.4.0"},"opentelemetry-client-cohttp-eio.0.91.1":{"authors":["ocaml-tracing","ELLIOTTCABLE <opam@ell.io>","the imandra team"],"declaredLicenses":["MIT"],"extraSources":[],"metadataBytes":1117,"metadataSha256":"23b4167fcde28ece3edbc9cc987a5be31d0ff44b988782b23d80cb529590e0d5","metadataUrl":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/opentelemetry-client-cohttp-eio.opam","name":"opentelemetry-client-cohttp-eio","noticeSpecs":[{"encoding":"utf8","path":"source/captured/README.md","sha256":"1cd86dbf790fff824b41143a79093230cf60d630f986e9b8e51c7e6b9fac243c","sourceBytesSha256":"1cd86dbf790fff824b41143a79093230cf60d630f986e9b8e51c7e6b9fac243c"},{"encoding":"utf8","path":"source/captured/src/atomic/atomic.pre412.mli","sha256":"e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d","sourceBytesSha256":"e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d"},{"encoding":"utf8","path":"source/captured/src/atomic/atomic.post412.mli","sha256":"f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b","sourceBytesSha256":"f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b"}],"originalNotices":[{"bytes":5105,"path":"source/captured/README.md","sha256":"1cd86dbf790fff824b41143a79093230cf60d630f986e9b8e51c7e6b9fac243c","sourcePath":"README.md","url":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/README.md"},{"bytes":2327,"path":"source/captured/src/atomic/atomic.pre412.mli","sha256":"e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d","sourcePath":"src/atomic/atomic.pre412.mli","url":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/src/atomic/atomic.pre412.mli"},{"bytes":2348,"path":"source/captured/src/atomic/atomic.post412.mli","sha256":"f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b","sourcePath":"src/atomic/atomic.post412.mli","url":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/src/atomic/atomic.post412.mli"}],"sourceCommit":"c3a03bcc0afafea188b8aefa631788090f0b8fd4","sourcePin":"git+https://github.com/semgrep/ocaml-opentelemetry.git#c3a03bcc0afafea188b8aefa631788090f0b8fd4","sourceUrl":"https://github.com/semgrep/ocaml-opentelemetry/tree/c3a03bcc0afafea188b8aefa631788090f0b8fd4","version":"0.91.1"},"opentelemetry-client-ocurl.0.91.1":{"authors":["ocaml-tracing","ELLIOTTCABLE <opam@ell.io>","the imandra team"],"declaredLicenses":["MIT"],"extraSources":[],"metadataBytes":968,"metadataSha256":"6ff4da9ddae7744427be5e10b18ccbf9e548a2b0ad37f7bfb0e707fa6a56be6d","metadataUrl":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/opentelemetry-client-ocurl.opam","name":"opentelemetry-client-ocurl","noticeSpecs":[{"encoding":"utf8","path":"source/captured/README.md","sha256":"1cd86dbf790fff824b41143a79093230cf60d630f986e9b8e51c7e6b9fac243c","sourceBytesSha256":"1cd86dbf790fff824b41143a79093230cf60d630f986e9b8e51c7e6b9fac243c"},{"encoding":"utf8","path":"source/captured/src/atomic/atomic.pre412.mli","sha256":"e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d","sourceBytesSha256":"e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d"},{"encoding":"utf8","path":"source/captured/src/atomic/atomic.post412.mli","sha256":"f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b","sourceBytesSha256":"f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b"}],"originalNotices":[{"bytes":5105,"path":"source/captured/README.md","sha256":"1cd86dbf790fff824b41143a79093230cf60d630f986e9b8e51c7e6b9fac243c","sourcePath":"README.md","url":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/README.md"},{"bytes":2327,"path":"source/captured/src/atomic/atomic.pre412.mli","sha256":"e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d","sourcePath":"src/atomic/atomic.pre412.mli","url":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/src/atomic/atomic.pre412.mli"},{"bytes":2348,"path":"source/captured/src/atomic/atomic.post412.mli","sha256":"f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b","sourcePath":"src/atomic/atomic.post412.mli","url":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/src/atomic/atomic.post412.mli"}],"sourceCommit":"c3a03bcc0afafea188b8aefa631788090f0b8fd4","sourcePin":"git+https://github.com/semgrep/ocaml-opentelemetry.git#c3a03bcc0afafea188b8aefa631788090f0b8fd4","sourceUrl":"https://github.com/semgrep/ocaml-opentelemetry/tree/c3a03bcc0afafea188b8aefa631788090f0b8fd4","version":"0.91.1"},"opentelemetry-client.0.91.1":{"authors":["ocaml-tracing","ELLIOTTCABLE <opam@ell.io>","the imandra team"],"declaredLicenses":["MIT"],"extraSources":[],"metadataBytes":845,"metadataSha256":"86549512673b52606f67d5465ded7e133ad6dd32e1d9c83a786dda893f50ed2b","metadataUrl":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/opentelemetry-client.opam","name":"opentelemetry-client","noticeSpecs":[{"encoding":"utf8","path":"source/captured/README.md","sha256":"1cd86dbf790fff824b41143a79093230cf60d630f986e9b8e51c7e6b9fac243c","sourceBytesSha256":"1cd86dbf790fff824b41143a79093230cf60d630f986e9b8e51c7e6b9fac243c"},{"encoding":"utf8","path":"source/captured/src/atomic/atomic.pre412.mli","sha256":"e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d","sourceBytesSha256":"e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d"},{"encoding":"utf8","path":"source/captured/src/atomic/atomic.post412.mli","sha256":"f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b","sourceBytesSha256":"f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b"}],"originalNotices":[{"bytes":5105,"path":"source/captured/README.md","sha256":"1cd86dbf790fff824b41143a79093230cf60d630f986e9b8e51c7e6b9fac243c","sourcePath":"README.md","url":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/README.md"},{"bytes":2327,"path":"source/captured/src/atomic/atomic.pre412.mli","sha256":"e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d","sourcePath":"src/atomic/atomic.pre412.mli","url":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/src/atomic/atomic.pre412.mli"},{"bytes":2348,"path":"source/captured/src/atomic/atomic.post412.mli","sha256":"f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b","sourcePath":"src/atomic/atomic.post412.mli","url":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/src/atomic/atomic.post412.mli"}],"sourceCommit":"c3a03bcc0afafea188b8aefa631788090f0b8fd4","sourcePin":"git+https://github.com/semgrep/ocaml-opentelemetry.git#c3a03bcc0afafea188b8aefa631788090f0b8fd4","sourceUrl":"https://github.com/semgrep/ocaml-opentelemetry/tree/c3a03bcc0afafea188b8aefa631788090f0b8fd4","version":"0.91.1"},"opentelemetry-logs.0.91.1":{"authors":["ocaml-tracing","ELLIOTTCABLE <opam@ell.io>","the imandra team"],"declaredLicenses":["MIT"],"extraSources":[],"metadataBytes":973,"metadataSha256":"685bbb1ee6982b3ce062ab465bb68446a8228330b3f6320cc7200da467f3329f","metadataUrl":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/opentelemetry-logs.opam","name":"opentelemetry-logs","noticeSpecs":[{"encoding":"utf8","path":"source/captured/README.md","sha256":"1cd86dbf790fff824b41143a79093230cf60d630f986e9b8e51c7e6b9fac243c","sourceBytesSha256":"1cd86dbf790fff824b41143a79093230cf60d630f986e9b8e51c7e6b9fac243c"},{"encoding":"utf8","path":"source/captured/src/atomic/atomic.pre412.mli","sha256":"e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d","sourceBytesSha256":"e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d"},{"encoding":"utf8","path":"source/captured/src/atomic/atomic.post412.mli","sha256":"f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b","sourceBytesSha256":"f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b"}],"originalNotices":[{"bytes":5105,"path":"source/captured/README.md","sha256":"1cd86dbf790fff824b41143a79093230cf60d630f986e9b8e51c7e6b9fac243c","sourcePath":"README.md","url":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/README.md"},{"bytes":2327,"path":"source/captured/src/atomic/atomic.pre412.mli","sha256":"e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d","sourcePath":"src/atomic/atomic.pre412.mli","url":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/src/atomic/atomic.pre412.mli"},{"bytes":2348,"path":"source/captured/src/atomic/atomic.post412.mli","sha256":"f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b","sourcePath":"src/atomic/atomic.post412.mli","url":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/src/atomic/atomic.post412.mli"}],"sourceCommit":"c3a03bcc0afafea188b8aefa631788090f0b8fd4","sourcePin":"git+https://github.com/semgrep/ocaml-opentelemetry.git#c3a03bcc0afafea188b8aefa631788090f0b8fd4","sourceUrl":"https://github.com/semgrep/ocaml-opentelemetry/tree/c3a03bcc0afafea188b8aefa631788090f0b8fd4","version":"0.91.1"},"opentelemetry.0.91.1":{"authors":["ocaml-tracing","ELLIOTTCABLE <opam@ell.io>","the imandra team"],"declaredLicenses":["MIT"],"extraSources":[],"metadataBytes":1203,"metadataSha256":"49479e717ee873765a11958dd4d1a7cccdaaccdf6c4956f189a6bce754675e1a","metadataUrl":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/opentelemetry.opam","name":"opentelemetry","noticeSpecs":[{"encoding":"utf8","path":"source/captured/README.md","sha256":"1cd86dbf790fff824b41143a79093230cf60d630f986e9b8e51c7e6b9fac243c","sourceBytesSha256":"1cd86dbf790fff824b41143a79093230cf60d630f986e9b8e51c7e6b9fac243c"},{"encoding":"utf8","path":"source/captured/src/atomic/atomic.pre412.mli","sha256":"e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d","sourceBytesSha256":"e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d"},{"encoding":"utf8","path":"source/captured/src/atomic/atomic.post412.mli","sha256":"f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b","sourceBytesSha256":"f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b"}],"originalNotices":[{"bytes":5105,"path":"source/captured/README.md","sha256":"1cd86dbf790fff824b41143a79093230cf60d630f986e9b8e51c7e6b9fac243c","sourcePath":"README.md","url":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/README.md"},{"bytes":2327,"path":"source/captured/src/atomic/atomic.pre412.mli","sha256":"e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d","sourcePath":"src/atomic/atomic.pre412.mli","url":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/src/atomic/atomic.pre412.mli"},{"bytes":2348,"path":"source/captured/src/atomic/atomic.post412.mli","sha256":"f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b","sourcePath":"src/atomic/atomic.post412.mli","url":"https://raw.githubusercontent.com/semgrep/ocaml-opentelemetry/c3a03bcc0afafea188b8aefa631788090f0b8fd4/src/atomic/atomic.post412.mli"}],"sourceCommit":"c3a03bcc0afafea188b8aefa631788090f0b8fd4","sourcePin":"git+https://github.com/semgrep/ocaml-opentelemetry.git#c3a03bcc0afafea188b8aefa631788090f0b8fd4","sourceUrl":"https://github.com/semgrep/ocaml-opentelemetry/tree/c3a03bcc0afafea188b8aefa631788090f0b8fd4","version":"0.91.1"},"seq.base":{"authors":[" "],"declaredLicenses":[],"extraSources":[{"bytes":30,"checksums":["sha256=fff926c2c4d5a82b6c94c60c4c35eb06e3d39975893ebe6b1f0e6557cbe34904","md5=026b31e1df290373198373d5aaa26e42"],"name":"seq.install","sha256":"fff926c2c4d5a82b6c94c60c4c35eb06e3d39975893ebe6b1f0e6557cbe34904","url":"https://raw.githubusercontent.com/ocaml/opam-source-archives/main/patches/seq/seq.install"},{"bytes":137,"checksums":["sha256=e95062b4d0519ef8335c02f7d0f1952d11b814c7ab7e6d566a206116162fa2be","md5=b33c8a1a6c7ed797816ce27df4855107"],"name":"META.seq","sha256":"e95062b4d0519ef8335c02f7d0f1952d11b814c7ab7e6d566a206116162fa2be","url":"https://raw.githubusercontent.com/ocaml/opam-source-archives/main/patches/seq/META.seq"}],"metadataBytes":840,"metadataSha256":"d7aae476c0d44177db7334f4962e171cd51efc745a8d8ddc97b43355578f2983","name":"seq","noticeSpecs":[{"encoding":"utf8","path":"reference/SEQ-README.txt","sha256":"79519163878ecbf5811ac0225b735fb29659b8e5ba7400690201d488561166ab","sourceBytesSha256":"79519163878ecbf5811ac0225b735fb29659b8e5ba7400690201d488561166ab"},{"encoding":"utf8","path":"reference/SEQ-COPYING.txt","sha256":"6d489af6292662d9e36d34ce49423784984a5f6e41d7b58f49b01264df59fa03","sourceBytesSha256":"6d489af6292662d9e36d34ce49423784984a5f6e41d7b58f49b01264df59fa03"}],"version":"base"}},"references":{"BSD-2-Clause":{"bytes":1267,"path":"reference/BSD-2-Clause.txt","role":"standard-license-reference-with-unfilled-placeholders","sha256":"f32fb3b417a194167cfad068223fc975ba96c5960513a10f66a3c28720aec1df","url":"https://raw.githubusercontent.com/spdx/license-list-data/617f1a78824394ada7525017d98c6fb215aad09b/text/BSD-2-Clause.txt"},"GPL-1.0-or-later":{"bytes":12235,"path":"reference/GPL-1.0-or-later.txt","role":"standard-license-reference-unmodified","sha256":"da37ffd5fcdf0a7d76af862a4330ea1076e1443b51782b2f912148357b7acabe","url":"https://raw.githubusercontent.com/spdx/license-list-data/617f1a78824394ada7525017d98c6fb215aad09b/text/GPL-1.0-or-later.txt"},"LWT-COPYING":{"bytes":29076,"path":"reference/LWT-COPYING.txt","role":"original-LWT-license-terms-reference","sha256":"3ac59d493bbe5e90a88db902560cbd131885460b59d3d97830f7090932ae913c","url":"https://raw.githubusercontent.com/ocsigen/lwt/9f57ff7251866db40c8e08b7c61c056ee9e52b0b/COPYING"},"LWT-LICENSE":{"bytes":266,"path":"reference/LWT-LICENSE.txt","role":"original-LWT-file-scope-and-linking-exceptions-reference","sha256":"e94fd77af7d9775c50b4ebdc03dd1028c53ec527ce94ca871d7144f3ccef82b8","url":"https://raw.githubusercontent.com/ocsigen/lwt/9f57ff7251866db40c8e08b7c61c056ee9e52b0b/LICENSE"},"LWT-discover-origin":{"bytes":8310,"path":"reference/LWT-discover-origin.txt","role":"original-LWT-source-context-not-claimed-identical-complete-file","sha256":"161b7ffc7441726fbf725301ff8b3e12d3fc8497c477c242b44b3993d1de9b2f","url":"https://raw.githubusercontent.com/ocsigen/lwt/9f57ff7251866db40c8e08b7c61c056ee9e52b0b/discover.ml"},"MIT":{"bytes":1078,"path":"reference/MIT.txt","role":"standard-license-reference-with-unfilled-placeholders","sha256":"b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5","url":"https://raw.githubusercontent.com/spdx/license-list-data/617f1a78824394ada7525017d98c6fb215aad09b/text/MIT.txt"},"OCaml-LICENSE":{"bytes":27179,"path":"reference/OCaml-LICENSE.txt","role":"original-system-license-terms-reference-for-file-directives","sha256":"65f47d3bf5a921011ac7fa30f23d54f9dffbe7683921eeb116d5ce8dc26ff0c1","url":"https://raw.githubusercontent.com/ocaml/ocaml/66f33f6e08857f3c3cb53fc1759fbad6860c59bd/LICENSE"},"OCaml-atomic-origin":{"bytes":7709,"path":"reference/OCaml-atomic.mli.txt","role":"original-system-source-context-with-byte-identical-license-header","sha256":"2eaf7b870d3a45bd595ed448a341d39d6dd1ae9291c996680c854f787ad98316","url":"https://raw.githubusercontent.com/ocaml/ocaml/66f33f6e08857f3c3cb53fc1759fbad6860c59bd/stdlib/atomic.mli"},"OPAM-METADATA-COPYING":{"bytes":7047,"path":"reference/OPAM-METADATA-COPYING.txt","role":"original-repository-metadata-terms-only-not-program-source-relicensing","sha256":"6d489af6292662d9e36d34ce49423784984a5f6e41d7b58f49b01264df59fa03","url":"https://raw.githubusercontent.com/ocaml/opam-repository/78d29aba187e8362b8ab86c189790c0af9153d4b/COPYING"},"SEQ-COPYING":{"bytes":7047,"path":"reference/SEQ-COPYING.txt","role":"original-repository-CC0-terms-for-exact-seq-metadata-origin","sha256":"6d489af6292662d9e36d34ce49423784984a5f6e41d7b58f49b01264df59fa03","url":"https://raw.githubusercontent.com/ocaml/opam-repository/bfbc306ceaa8bb97ade3dde4feedaa16a484b87a/COPYING"},"SEQ-META-origin":{"bytes":137,"path":"reference/SEQ-META-origin.txt","role":"original-source-origin","sha256":"e95062b4d0519ef8335c02f7d0f1952d11b814c7ab7e6d566a206116162fa2be","url":"https://raw.githubusercontent.com/ocaml/opam-repository/bfbc306ceaa8bb97ade3dde4feedaa16a484b87a/packages/seq/seq.base/files/META.seq"},"SEQ-README":{"bytes":907,"path":"reference/SEQ-README.txt","role":"original-repository-license-declaration-for-package-metadata","sha256":"79519163878ecbf5811ac0225b735fb29659b8e5ba7400690201d488561166ab","url":"https://raw.githubusercontent.com/ocaml/opam-repository/bfbc306ceaa8bb97ade3dde4feedaa16a484b87a/README.md"},"SEQ-install-origin":{"bytes":30,"path":"reference/SEQ-install-origin.txt","role":"original-source-origin","sha256":"fff926c2c4d5a82b6c94c60c4c35eb06e3d39975893ebe6b1f0e6557cbe34904","url":"https://raw.githubusercontent.com/ocaml/opam-repository/bfbc306ceaa8bb97ade3dde4feedaa16a484b87a/packages/seq/seq.base/files/seq.install"}}}')
POLICIES = DATA['policies']
REFERENCES = DATA['references']
EXTRA_SOURCE_IDS = frozenset(identity for identity, p in POLICIES.items() if not p.get('sourcePin'))
PINNED_SOURCE_IDS = frozenset(identity for identity, p in POLICIES.items() if p.get('sourcePin'))
REVIEWED_SOURCE_IDS = EXTRA_SOURCE_IDS | PINNED_SOURCE_IDS
MAX_METADATA = 4 * 1024**2


def sha(data): return hashlib.sha256(data).hexdigest()

def canonical(value): return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))+'\n').encode()

def record(data): return {'bytes': len(data), 'sha256': sha(data)}


def policy(identity):
    if identity not in REVIEWED_SOURCE_IDS:
        raise ValueError('Source model is restricted to eleven exact reviewed package identities')
    return POLICIES[identity]


def metadata_url(identity):
    if policy(identity).get('metadataUrl'): return policy(identity)['metadataUrl']
    return 'https://raw.githubusercontent.com/ocaml/opam-repository/'+OPAM_COMMIT+'/packages/'+policy(identity)['name']+'/'+identity+'/opam'


def all_reviewed_ids():
    from compiler_license_declaration import DECLARATION_IDS
    return DECLARATION_IDS | REVIEWED_SOURCE_IDS


def captured_bytes(package, key):
    value = base64.b64decode(package[key], validate=True)
    if len(value) > MAX_METADATA or key == 'opam' and not value:
        raise ValueError('Invalid actual installed metadata bytes')
    return value


def extra_specs(identity):
    return [{**item, 'path': 'source/extra/'+item['name']} for item in policy(identity)['extraSources']]


def reference_keys(identity):
    if identity in PINNED_SOURCE_IDS: return ['MIT', 'OCaml-LICENSE', 'OCaml-atomic-origin']
    return ['OPAM-METADATA-COPYING'] + {
        'conf-gmp.5': ['GPL-1.0-or-later'],
        'conf-gmp-powm-sec.4': ['GPL-1.0-or-later'],
        'conf-libev.4-13': ['BSD-2-Clause', 'LWT-COPYING', 'LWT-LICENSE', 'LWT-discover-origin'],
        'conf-rust-2024.1': ['MIT'],
        'seq.base': ['SEQ-README', 'SEQ-COPYING', 'SEQ-META-origin', 'SEQ-install-origin'],
        'ocaml-compiler.5.4.0': [],
    }[identity]


def expected_semantics(identity):
    p = policy(identity)
    return {'name': p['name'], 'version': p['version'], 'license': p['declaredLicenses'],
        'authors': p['authors'], 'patches': [], 'substs': [],
        'mainSource': {'url': p['sourceUrl'], 'checksums': []} if p.get('sourcePin')
                      else {key: p['archive'][key] for key in ('url', 'checksums')} if 'archive' in p else None,
        'extraSources': [{key: x[key] for key in ('name', 'url', 'checksums')} for x in p['extraSources']]}


def actual_extra_names(text):
    # Reuse the existing quote-aware OPAM section scanner. A description may
    # contain a fake extra-source line; it cannot introduce an actual section.
    from compiler_license_ledger import opam_blocks
    candidates = [json.loads(x) for x in re.findall(r'(?m)^\s*extra-source\s+("(?:[^"\\]|\\.)*")\s*\{', text)]
    return [name for name in dict.fromkeys(candidates)
            for _ in opam_blocks(text, 'extra-source '+json.dumps(name))]


def ensure_reviewed_extensions(identity, text):
    from compiler_license_ledger import field
    positions = _reject_duplicate_critical_fields(text)
    if 'extra-files' in positions:
        raise ValueError('Unreviewed OPAM extra-files source payload')
    if identity in all_reviewed_ids(): return
    if (any(field(text[positions[key]:], key) for key in ('patches', 'substs') if key in positions)
            or actual_extra_names(text)):
        raise ValueError('Actual OPAM source extensions require exact reviewed source coverage: '+identity)


def semantics(data, identity):
    from compiler_license_ledger import field, opam_blocks, source_url
    p = policy(identity); text = data.decode('utf8')
    positions = _reject_duplicate_critical_fields(text)
    if 'extra-files' in positions:
        raise ValueError('Unreviewed OPAM extra-files source payload')
    critical = lambda key: field(text[positions[key]:], key) if key in positions else []
    for key in ('name', 'version'):
        if critical(key) and critical(key) != [p[key]]:
            raise ValueError('Actual package name/version differs')
    result = {key: critical(key) for key in ('license', 'authors', 'patches', 'substs')}
    result.update(name=p['name'], version=p['version'])
    main, checksums = source_url(text)
    if p.get('sourcePin'):
        # OPAM adds the exact pinned Git url section to installed metadata.
        # The original Git .opam has none; no other commit or URL is allowed.
        if main not in (None, p['sourceUrl']) or checksums:
            raise ValueError('Actual pinned Git source commit differs')
        main, checksums = p['sourceUrl'], []
    result['mainSource'] = {'url': main, 'checksums': checksums} if main else None
    names = actual_extra_names(text)
    if len(names) != len(set(names)) or set(names) != {x['name'] for x in p['extraSources']}:
        raise ValueError('Actual extra-source names differ')
    result['extraSources'] = []
    for spec in p['extraSources']:
        blocks = opam_blocks(text, 'extra-source '+json.dumps(spec['name']))
        if len(blocks) != 1:
            raise ValueError('Actual extra-source block differs')
        urls = field(blocks[0], 'src'); hashes = sorted(field(blocks[0], 'checksum'))
        if urls != [spec['url']] or hashes != sorted(spec['checksums']):
            raise ValueError('Actual extra-source URL/checksums differ')
        result['extraSources'].append({'name': spec['name'], 'url': urls[0], 'checksums': spec['checksums']})
    if result != expected_semantics(identity):
        raise ValueError('Actual original licensing/source semantics differ')
    return result


def actual_source_evidence(capture):
    """Merge all sixteen exact IDs from fresh independently captured image data."""
    from compiler_license_declaration import actual_source_evidence as original_evidence
    value = original_evidence(capture)
    expected = set()
    for line in capture.get('opamListing', '').splitlines():
        if not line.strip() or line.lstrip().startswith('#'): continue
        parts = line.split()
        if len(parts) != 2: raise ValueError('Invalid actual package listing')
        identity = parts[0]+'.'+parts[1]
        if identity in REVIEWED_SOURCE_IDS: expected.add(identity)
    found = set()
    for package in capture.get('opamPackages', []):
        identity = package.get('id')
        ensure_reviewed_extensions(identity, captured_bytes(package, 'opam').decode('utf8'))
        if identity not in REVIEWED_SOURCE_IDS: continue
        p = policy(identity)
        if identity in found or (package.get('name'), package.get('version')) != (p['name'], p['version']):
            raise ValueError('Invalid actual extra-source package identity')
        found.add(identity)
        value[identity] = {key: record(captured_bytes(package, key)) for key in ('opam', 'install', 'changes')}
    if found != expected: raise ValueError('Actual extra-source package metadata was omitted')
    return value


def original_declaration(identity):
    p = policy(identity)
    return {'url': metadata_url(identity), 'bytes': p['metadataBytes'], 'sha256': p['metadataSha256'],
        'license': p['declaredLicenses'], 'authors': p['authors']}


def file_scopes(identity):
    if identity in PINNED_SOURCE_IDS:
        return [
            {'path': 'source/captured/README.md', 'role': 'original-project-MIT-declaration-no-invented-copyright',
             'licenseExpression': 'MIT', 'references': ['MIT']},
            *[{'path': 'source/captured/src/atomic/atomic.'+suffix+'.mli',
               'role': 'original-source-file-license-directive',
               'licenseExpression': 'LGPL-2.1-only WITH OCaml-LGPL-linking-exception',
               'references': ['OCaml-LICENSE', 'OCaml-atomic-origin']}
              for suffix in ('pre412', 'post412')],
        ]
    if identity == 'conf-libev.4-13':
        return [
            {'path': 'source/extra/discover.ml', 'role': 'original-source-file-license-directive',
             'licenseExpression': 'LicenseRef-LWT-LGPL-2.1-or-later-with-linking-exceptions',
             'header': DATA['confLibevOriginalHeader'], 'references': ['LWT-COPYING', 'LWT-LICENSE', 'LWT-discover-origin']},
            {'path': 'source/extra/build.sh', 'role': 'original-package-license-declaration-no-invented-copyright',
             'licenseExpression': 'BSD-2-Clause', 'references': ['BSD-2-Clause']},
        ]
    if identity == 'seq.base':
        return [{'path': 'source/extra/'+name, 'role': 'exact-original-package-metadata-file',
                 'licenseExpression': 'CC0-1.0',
                 'references': ['SEQ-README', 'SEQ-COPYING', 'SEQ-META-origin' if name == 'META.seq' else 'SEQ-install-origin']}
                for name in ('seq.install', 'META.seq')]
    return [{'path': spec['path'], 'role': 'original-package-license-declaration-no-invented-copyright',
             'licenseExpression': policy(identity)['declaredLicenses'][0],
             'references': reference_keys(identity)[1:]}
            for spec in extra_specs(identity)]


def expression(identity):
    if identity in PINNED_SOURCE_IDS: return 'LicenseRef-Reviewed-Opentelemetry-c3a03bcc-Per-File'
    if identity == 'conf-libev.4-13': return 'LicenseRef-Reviewed-Conf-Libev-4-13-Per-File'
    if identity == 'seq.base': return 'LicenseRef-Reviewed-Seq-Opam-Metadata-Files'
    return policy(identity)['declaredLicenses'][0]


def original_notices(identity, files):
    from compiler_license_ledger import archive_notices, notice
    if identity in PINNED_SOURCE_IDS:
        return [notice(spec['path'], files[spec['path']]) for spec in policy(identity)['originalNotices']]
    if identity == 'conf-libev.4-13':
        return [notice('source/extra/discover.ml', files['source/extra/discover.ml'])]
    if identity == 'seq.base':
        return [notice(REFERENCES[key]['path'], files[REFERENCES[key]['path']]) for key in ('SEQ-README', 'SEQ-COPYING')]
    if identity == 'ocaml-compiler.5.4.0':
        return archive_notices(files['source/original-archive'])
    return []


def valid_seq_install(data):
    # Actual OPAM 2.5.2 P3 evidence serialized the singleton list as a scalar
    # and added opam-version. Accept exactly these equivalent observed forms.
    # Whitespace between OPAM tokens is interchangeable. Whitespace inside a
    # quoted filename changes that filename and must never be normalized.
    ws = rb'[ \t\r\n]*'
    entry = rb'"META\.seq"' + ws + rb'\{' + ws + rb'"META"' + ws + rb'\}'
    value = rb'(?:\[' + ws + entry + ws + rb'\]|' + entry + rb')'
    return re.fullmatch(ws + rb'(?:opam-version' + ws + rb':' + ws + rb'"2\.0"' + ws
        + rb')?lib' + ws + rb':' + ws + value + ws, data) is not None


def expected_evidence(identity, actual, refs):
    return {'format': FORMAT, 'packageId': identity, 'originalDeclaration': original_declaration(identity),
        'installedMetadata': {key: {'path': 'metadata/installed-opam' if key == 'opam' else 'metadata/'+key, **record(data)}
                              for key, data in actual.items()},
        'criticalMetadataSemanticsSha256': sha(canonical(expected_semantics(identity))),
        'originalExtraSources': extra_specs(identity),
        'originalArchive': {**policy(identity)['archive'], 'path': 'source/original-archive'} if 'archive' in policy(identity) else None,
        'originalPinnedSource': {key: policy(identity)[key] for key in ('sourcePin', 'sourceUrl', 'sourceCommit', 'originalNotices')}
                                if identity in PINNED_SOURCE_IDS else None,
        'referenceTerms': refs, 'perFileLicenseEvidence': file_scopes(identity)}


def collect_component(package, root, output):
    from compiler_license_ledger import download, checked_download, tree_files, retain_source
    identity = package.get('id'); p = policy(identity)
    if package.get('sourcePin') != p.get('sourcePin') or (package.get('name'), package.get('version')) != (p['name'], p['version']):
        raise ValueError('Exact reviewed extra-source package identity/pin differs')
    original = download(metadata_url(identity), maximum=p['metadataBytes'])
    if record(original) != {key.removeprefix('metadata').lower(): p[key] for key in ('metadataBytes', 'metadataSha256')}:
        raise ValueError('Original pinned OPAM bytes differ')
    actual = {key: captured_bytes(package, key) for key in ('opam', 'install', 'changes')}
    semantics(original, identity); semantics(actual['opam'], identity)
    if identity == 'seq.base' and not valid_seq_install(actual['install']):
        raise ValueError('Actual seq install must preserve its exact metadata-file installation')
    if p['name'].startswith('conf-') and actual['install'].strip():
        raise ValueError('Actual conf install has unreviewed installed files')
    files = {'metadata/original-opam': original, 'metadata/installed-opam': actual['opam'],
             'metadata/install': actual['install'], 'metadata/changes': actual['changes']}
    for spec in extra_specs(identity):
        data = checked_download(spec['url'], spec['checksums'], root/'opam-download-cache')
        if record(data) != {key: spec[key] for key in ('bytes', 'sha256')}:
            raise ValueError('Original extra-source bytes differ')
        files[spec['path']] = data
    if 'archive' in p:
        spec = p['archive']; data = checked_download(spec['url'], spec['checksums'], root/'opam-download-cache')
        if record(data) != {key: spec[key] for key in ('bytes', 'sha256')}: raise ValueError('Original archive bytes differ')
        files['source/original-archive'] = data
    captured = package.get('sourceDirectory')
    if captured:
        if ('/' in captured or '\\' in captured
                or not (captured.startswith(p['name']+'.') or p.get('sourcePin') and captured == p['name'])):
            raise ValueError('Invalid retained source directory')
        tree = root/'opam-sources'/captured
        if tree.is_dir(): files.update({'source/captured/'+name: data for name, data in tree_files(tree).items()})
    if identity in PINNED_SOURCE_IDS:
        for spec in p['originalNotices']:
            if spec['path'] not in files or record(files[spec['path']]) != {key: spec[key] for key in ('bytes', 'sha256')}:
                raise ValueError('Actual complete pinned source tree/primary directives are required')
    refs = []
    for key in reference_keys(identity):
        spec = REFERENCES[key]; data = download(spec['url'], maximum=spec['bytes'])
        if record(data) != {key: spec[key] for key in ('bytes', 'sha256')}: raise ValueError('Unmodified primary reference bytes differ')
        files[spec['path']] = data
        refs.append({**spec, 'id': key, 'text': data.decode('utf8')})
    evidence = expected_evidence(identity, actual, refs)
    component = {'name': 'opam/'+p['name'], 'version': p['version'], 'packageIds': [identity],
                 'licenseExpression': expression(identity), 'notices': original_notices(identity, files),
                 'licenseEvidence': evidence, 'correspondingSource': retain_source(output, 'opam-'+identity, files, p.get('sourceUrl', metadata_url(identity)))}
    validate_component(component, files)
    return component


def validate_component(component, files=None, native=None):
    if not isinstance(component, dict) or set(component) != {'name', 'version', 'packageIds', 'licenseExpression', 'notices', 'licenseEvidence', 'correspondingSource'}:
        raise ValueError('Invalid typed extra-source component')
    evidence = component.get('licenseEvidence')
    if not isinstance(evidence, dict): raise ValueError('Missing original extra-source evidence')
    identity = evidence.get('packageId'); p = policy(identity)
    if (component['name'], component['version'], component['packageIds'], component['licenseExpression']) != ('opam/'+p['name'], p['version'], [identity], expression(identity)):
        raise ValueError('Exact extra-source component identity/license differs')
    if component['correspondingSource'].get('url') != p.get('sourceUrl', metadata_url(identity)):
        raise ValueError('Exact original package source provenance differs')
    actual = evidence.get('installedMetadata', {})
    if set(actual) != {'opam', 'install', 'changes'}: raise ValueError('Missing actual installed metadata binding')
    for key, value in actual.items():
        if (not isinstance(value, dict) or set(value) != {'path', 'bytes', 'sha256'} or type(value['bytes']) is not int
                or not 0 <= value['bytes'] <= MAX_METADATA or key == 'opam' and not value['bytes']
                or not re.fullmatch('[a-f0-9]{64}', str(value['sha256']))
                or value['path'] != ('metadata/installed-opam' if key == 'opam' else 'metadata/'+key)):
            raise ValueError('Invalid actual installed metadata identity')
    refs = []
    for key in reference_keys(identity):
        spec = REFERENCES[key]
        provided = next((x for x in evidence.get('referenceTerms', []) if x.get('id') == key), None)
        if not isinstance(provided, dict) or set(provided) != set(spec)|{'id', 'text'}:
            raise ValueError('Missing exact reference terms')
        data = provided['text'].encode('utf8')
        if provided != {**spec, 'id': key, 'text': provided['text']} or record(data) != {x: spec[x] for x in ('bytes', 'sha256')}:
            raise ValueError('Reference text/role changed or claimed as original')
        refs.append(provided)
    expected = expected_evidence(identity, {key: b'' for key in actual}, refs)
    expected['installedMetadata'] = actual
    if evidence != expected: raise ValueError('Exact original source/declaration policy differs')
    notices = component['notices']
    if not isinstance(notices, list) or len(notices) != len(p['noticeSpecs']):
        raise ValueError('Exact original notices missing or standard reference claimed as original')
    for item, spec in zip(notices, p['noticeSpecs']):
        if not isinstance(item, dict) or set(item) != set(spec)|{'text'} or {key: item[key] for key in spec} != spec:
            raise ValueError('Original notice identity differs')
        try:
            original = item['text'].encode({'utf8': 'utf8', 'latin1': 'latin1'}[item['encoding']])
        except (KeyError, AttributeError, UnicodeError):
            raise ValueError('Invalid original notice encoding') from None
        if sha(original) != item['sourceBytesSha256'] or sha(item['text'].encode('utf8')) != item['sha256']:
            raise ValueError('Original notice bytes differ')
    if native is not None:
        ids = set()
        for line in native.get('opamPackages', '').splitlines():
            if not line.strip() or line.lstrip().startswith('#'): continue
            parts = line.split()
            if len(parts) != 2: raise ValueError('Invalid native package listing')
            ids.add(parts[0]+'.'+parts[1])
        binding = native.get('opamSourceEvidence')
        if (not isinstance(binding, dict) or set(binding) != ids & all_reviewed_ids()
                or binding.get(identity) != {key: {x: value[x] for x in ('bytes', 'sha256')} for key, value in actual.items()}):
            raise ValueError('Source declaration differs from independently captured native metadata')
    if files is not None:
        required = {'metadata/original-opam', 'metadata/installed-opam', 'metadata/install', 'metadata/changes'}
        required.update(spec['path'] for spec in extra_specs(identity))
        required.update(ref['path'] for ref in refs)
        required.update(spec['path'] for spec in p.get('originalNotices', []))
        if 'archive' in p: required.add('source/original-archive')
        if not required <= set(files): raise ValueError('Original extra/source/reference payload omitted')
        original = files['metadata/original-opam']
        if record(original) != {'bytes': p['metadataBytes'], 'sha256': p['metadataSha256']}: raise ValueError('Original OPAM bytes differ')
        semantics(original, identity)
        for key, value in actual.items():
            if record(files[value['path']]) != {x: value[x] for x in ('bytes', 'sha256')}: raise ValueError('Actual installed metadata bytes differ')
        semantics(files[actual['opam']['path']], identity)
        if identity == 'seq.base' and not valid_seq_install(files['metadata/install']):
            raise ValueError('Actual seq metadata installation differs')
        if p['name'].startswith('conf-') and files['metadata/install'].strip(): raise ValueError('Actual conf install differs')
        for spec in extra_specs(identity):
            if record(files[spec['path']]) != {x: spec[x] for x in ('bytes', 'sha256')}: raise ValueError('Original extra-source bytes differ')
        if 'archive' in p and record(files['source/original-archive']) != {x: p['archive'][x] for x in ('bytes', 'sha256')}: raise ValueError('Original main archive bytes differ')
        for spec in p.get('originalNotices', []):
            if record(files[spec['path']]) != {key: spec[key] for key in ('bytes', 'sha256')}:
                raise ValueError('Original pinned source notice/directive bytes differ')
        if identity in PINNED_SOURCE_IDS:
            # These are byte-identical to the separately reviewed Ambient
            # Atomic declarations, including their genuine OCaml file header.
            from compiler_license_declaration import ATOMIC_HEADER_SHA
            origin = files[REFERENCES['OCaml-atomic-origin']['path']]
            origin_header = origin.split(b'(** Atomic references.', 1)[0]
            if sha(origin_header) != ATOMIC_HEADER_SHA: raise ValueError('Original OCaml header reference differs')
            for suffix in ('pre412', 'post412'):
                header = files['source/captured/src/atomic/atomic.'+suffix+'.mli'].split(b'(** Atomic references.', 1)[0]
                if header != origin_header: raise ValueError('Original OTel Atomic header differs')
        for ref in refs:
            if files[ref['path']] != ref['text'].encode('utf8'): raise ValueError('Retained exact reference differs')
        if identity == 'conf-libev.4-13':
            original_header = files['source/extra/discover.ml'].split(b'*)', 1)[0]+b'*)'
            origin_header = files[REFERENCES['LWT-discover-origin']['path']].split(b'*)', 1)[0]+b'*)'
            if record(original_header) != DATA['confLibevOriginalHeader'] or origin_header != original_header:
                raise ValueError('Genuine original LWT license header differs')
        if identity == 'seq.base':
            for key, name in [('SEQ-META-origin', 'META.seq'), ('SEQ-install-origin', 'seq.install')]:
                if files[REFERENCES[key]['path']] != files['source/extra/'+name]: raise ValueError('Historical seq metadata origin differs')
        if component['notices'] != original_notices(identity, files): raise ValueError('Original notices changed or standard reference claimed as original')
    else:
        # Hash-only phase never promotes reference terms to an upstream notice.
        if identity not in PINNED_SOURCE_IDS | {'conf-libev.4-13', 'seq.base', 'ocaml-compiler.5.4.0'} and component['notices']:
            raise ValueError('Standard reference claimed as original')
    return component


def source_files(data):
    """Bounded wrapper reader; preserves opaque source names, no extraction."""
    from compiler_license_ledger import MAX_FILE, MAX_SOURCE, source_relative
    if len(data) > MAX_FILE: raise ValueError('Extra-source bundle exceeds bound')
    result = {}; total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
        for item in archive:
            name = source_relative(item.name)
            if not item.isfile() or name in result or len(result) >= 250000 or not 0 <= item.size <= MAX_FILE:
                raise ValueError('Invalid extra-source bundle member')
            total += item.size
            if total > MAX_SOURCE: raise ValueError('Extra-source expansion exceeds bound')
            result[name] = archive.extractfile(item).read()
    return result
