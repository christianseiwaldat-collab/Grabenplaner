"""Exact ocaml-config.3 declaration evidence, separate from original notices.

The reference is the unmodified official SPDX ISC standard text, including its
unfilled YEAR/OWNER placeholders. It is not an upstream copyright notice or an
assertion that ISC owns this generator. No other package/version can use this
model. Complete original sources and the actually installed generated source
remain required; normal source-contained notice validation is unchanged.
"""
import base64
import hashlib
from pathlib import PurePosixPath
import re

FORMAT = 'gp-opam-declaration-with-standard-reference/v1'
PACKAGE = 'ocaml-config.3'
METADATA_SHA = 'eac491c01bd4de3e78443d55bd9948e107c9ad4c80b5d0f4c63de778b601aae3'
OPAM_COMMIT = '78d29aba187e8362b8ab86c189790c0af9153d4b'
DECLARATION_URL = 'https://raw.githubusercontent.com/ocaml/opam-repository/' + OPAM_COMMIT + '/packages/ocaml-config/ocaml-config.3/opam'
INSTALLED_PATH = '/root/.opam/5.4.0/share/ocaml-config/gen_ocaml_config.ml'
REFERENCE_URL = 'https://raw.githubusercontent.com/spdx/license-list-data/617f1a78824394ada7525017d98c6fb215aad09b/text/ISC.txt'
REFERENCE_SHA = '521c6f0ed8e64736684f89843d16a4df6b4b7449acbcfc6ca6630a3037ca8c53'
ORIGINALS = (
    ('ocaml-config.install', 'https://raw.githubusercontent.com/ocaml/ocaml/363fb9f5a2fb87dbd5f8cc579af87dd04e14343b/tools/opam/ocaml-config.install', 31, '6e4fd93f4cce6bad0ed3c08afd0248dbe7d7817109281de6294e5b5ef5597051'),
    ('gen_ocaml_config.ml.in', 'https://raw.githubusercontent.com/ocaml/ocaml/66f33f6e08857f3c3cb53fc1759fbad6860c59bd/tools/opam/gen_ocaml_config.ml.in', 2697, 'a9ad8d84a08961159653a978db92d10f694510182b206cacb96d5c9f63b5121e'),
)
AUTHORS = ['Louis Gesbert <louis.gesbert@ocamlpro.com>', 'David Allsopp <david.allsopp@metastack.com>']
UPSTREAM_NOTICE_STATUS = 'No original notice supplied in the checksum-bound extra-source files; standard text is reference only.'
MAX_INSTALLED = 64 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def declaration():
    return {'path': 'metadata/opam', 'url': DECLARATION_URL, 'sha256': METADATA_SHA,
        'bytes': METADATA_BYTES, 'licenseExpression': 'ISC', 'authors': list(AUTHORS),
        'declarationIntroductionCommit': '4461f0a62b0f261ea84b98f948c61154b65d40ff'}


def originals():
    return [{'path': 'source/original/' + name, 'url': url, 'bytes': size, 'sha256': digest}
        for name, url, size, digest in ORIGINALS]


def standard_reference():
    if sha(REFERENCE_BYTES) != REFERENCE_SHA:
        raise ValueError('Reviewed ISC reference bytes differ')
    return {'role': 'standard-license-reference', 'path': 'reference/ISC.txt',
        'url': REFERENCE_URL, 'sha256': REFERENCE_SHA, 'bytes': len(REFERENCE_BYTES),
        'licenseExpression': 'ISC', 'text': REFERENCE_BYTES.decode('utf8'),
        'copyrightAttribution': 'Unfilled reference placeholders; no package copyright claim'}


def installed_source(package):
    value = package.get('installedSource')
    if (package.get('id') != PACKAGE or not isinstance(value, dict)
            or set(value) != {'imagePath', 'bytes', 'sha256', 'content'} or value['imagePath'] != INSTALLED_PATH
            or type(value['bytes']) is not int or not 0 < value['bytes'] <= MAX_INSTALLED
            or not re.fullmatch('[a-f0-9]{64}', str(value['sha256']))):
        raise ValueError('Exact captured installed config source is required')
    data = base64.b64decode(value['content'], validate=True)
    if len(data) != value['bytes'] or sha(data) != value['sha256'] or b'\x00' in data:
        raise ValueError('Captured installed config source bytes differ')
    return data


def actual_source_evidence(capture):
    packages = capture.get('opamPackages', [])
    if not isinstance(packages, list):
        raise ValueError('Actual opam package records are missing')
    values = [item for item in packages if item.get('id') == PACKAGE]
    expected = any(line.split() == ['ocaml-config', '3'] for line in capture.get('opamListing', '').splitlines())
    if expected and not values:
        raise ValueError('Actual installed config source evidence was omitted')
    if len(values) > 1:
        raise ValueError('Duplicate actual config package')
    if not values:
        return {}
    data = installed_source(values[0])
    return {PACKAGE: {'bytes': len(data), 'sha256': sha(data)}}


def build_evidence(package, metadata, source_files, captured_files):
    if (package.get('name'), package.get('version'), package.get('id')) != ('ocaml-config', '3', PACKAGE):
        raise ValueError('Declaration model is restricted to exact config3')
    if len(metadata) != METADATA_BYTES or sha(metadata) != METADATA_SHA:
        raise ValueError('Reviewed original config declaration differs')
    installed = installed_source(package)
    files = {'metadata/opam': metadata, 'metadata/install': base64.b64decode(package['install'], validate=True),
        'metadata/changes': base64.b64decode(package['changes'], validate=True),
        'reference/ISC.txt': REFERENCE_BYTES, 'source/installed/gen_ocaml_config.ml': installed}
    for name, _url, size, digest in ORIGINALS:
        data = source_files[name]
        if len(data) != size or sha(data) != digest:
            raise ValueError('Reviewed original config extra-source bytes differ')
        files['source/original/' + name] = data
    files.update({'source/captured/' + name: data for name, data in captured_files.items()})
    value = {'format': FORMAT, 'originalDeclaration': declaration(), 'originalSources': originals(),
        'installedSource': {'path': 'source/installed/gen_ocaml_config.ml', 'imagePath': INSTALLED_PATH,
            'bytes': len(installed), 'sha256': sha(installed)},
        'standardLicenseReference': standard_reference(), 'upstreamNoticeStatus': UPSTREAM_NOTICE_STATUS}
    return value, files


def validate_declaration(component, files=None, native=None):
    evidence = component.get('licenseEvidence')
    if component.get('correspondingSource', {}).get('url') != DECLARATION_URL:
        raise ValueError('Config corresponding-source authority differs')
    if (component.get('name'), component.get('version'), component.get('packageIds'), component.get('licenseExpression')) != ('opam/ocaml-config', '3', [PACKAGE], 'ISC'):
        raise ValueError('Declaration model is restricted to exact config3')
    if component.get('notices') != []:
        raise ValueError('Reference cannot be claimed as original upstream notice')
    if (not isinstance(evidence, dict) or set(evidence) != {'format', 'originalDeclaration', 'originalSources',
            'installedSource', 'standardLicenseReference', 'upstreamNoticeStatus'}
            or evidence['format'] != FORMAT or evidence['originalDeclaration'] != declaration()
            or evidence['originalSources'] != originals() or evidence['standardLicenseReference'] != standard_reference()
            or evidence['upstreamNoticeStatus'] != UPSTREAM_NOTICE_STATUS):
        raise ValueError('Config declaration/reference provenance differs from reviewed policy')
    installed = evidence['installedSource']
    if (not isinstance(installed, dict) or set(installed) != {'path', 'imagePath', 'bytes', 'sha256'}
            or installed['path'] != 'source/installed/gen_ocaml_config.ml' or installed['imagePath'] != INSTALLED_PATH
            or type(installed['bytes']) is not int or not 0 < installed['bytes'] <= MAX_INSTALLED
            or not re.fullmatch('[a-f0-9]{64}', str(installed['sha256']))):
        raise ValueError('Installed source binding is invalid')
    if native is not None and native.get('opamSourceEvidence') != {PACKAGE: {key: installed[key] for key in ('bytes', 'sha256')}}:
        raise ValueError('Installed source differs from actual qualified image')
    if files is not None:
        expected = {'metadata/opam': (METADATA_BYTES, METADATA_SHA), 'reference/ISC.txt': (len(REFERENCE_BYTES), REFERENCE_SHA),
            **{item['path']: (item['bytes'], item['sha256']) for item in originals()},
            installed['path']: (installed['bytes'], installed['sha256'])}
        if not {'metadata/install', 'metadata/changes'} <= set(files):
            raise ValueError('Original installation evidence was omitted')
        for path, (size, digest) in expected.items():
            data = files.get(path)
            if not isinstance(data, bytes) or len(data) != size or sha(data) != digest:
                raise ValueError('Declared original/reference/installed source bytes differ')
        # Existing original notices are never replaced by this model. All actual
        # captured source files remain retained; any new notice needs normal review.
        for path in files:
            if path not in expected and path not in ('metadata/install', 'metadata/changes') and not path.startswith('source/captured/'):
                raise ValueError('Unexpected config declaration source member')
            if path.startswith('source/') and not PurePosixPath(path).name.endswith('.symlink-target') and re.fullmatch(r'(?:licen[cs]e|copying|copyright|notice)(?:[._-].*)?', PurePosixPath(path).name, re.I):
                raise ValueError('Existing original notice must use normal notice model')
    return evidence

METADATA_BYTES = 1265
REFERENCE_BYTES = b'ISC License\n\nCopyright <year> <owner> \n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.\n'
