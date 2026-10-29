"""Canonical, reviewed inputs for compiler reuse; never a scan-result cache.

Application sources deliberately are not compiler inputs: every consuming job
qualifies its current whole files and runs every ordinary full-project profile.
"""
import hashlib
import json
from pathlib import Path
import re

FORMAT = 'gp-semgrep-core-build-inputs/v1'
PROGRAMS = ('build_semgrep_source.py', 'source_core_identity.py', 'source_core_acquisition.py',
            'semgrep_core_tool.py', 'publish_semgrep_core_tool.py', 'compiler_license_ledger.py',
            'compiler_license_native.py', 'prepare_source_core.py',
            'sast_profile.py', 'gates.py')
PROGRAM_ATTRIBUTE = 'scripts/security/*.py text eol=lf'
INPUT_ATTRIBUTES = (PROGRAM_ATTRIBUTE, 'scripts/security/requirements.txt text eol=lf',
                    'scripts/security/tools.json text eol=lf')


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def regular(path):
    path = Path(path).absolute()
    info = path.lstat()
    if (path.resolve() != path or not path.is_file() or info.st_nlink != 1
            or not 0 < info.st_size <= 16 * 1024**2):
        raise ValueError('Build-input identity requires canonical regular input files')
    return path.read_bytes()


def fixed_inputs():
    # Local import keeps the builder/consumer/publisher dependency graph acyclic.
    import build_semgrep_source as build
    recipe = regular(Path(__file__).parent / 'fixtures/semgrep-1.181.0-Dockerfile')
    return {'format': FORMAT,
        'source': {'repository': build.UPSTREAM, 'tag': build.TAG, 'tagObject': build.TAG_OBJECT,
            'commit': build.COMMIT, 'submodule': list(build.SUBMODULE)},
        'patchRecipe': {'path': build.LIMITS, 'beforeSha256': build.LIMITS_BEFORE,
            'afterSha256': build.LIMITS_AFTER, 'from': build.PATCH_FROM.decode(),
            'to': build.PATCH_TO.decode(), 'upstreamDockerfileSha256': build.DOCKERFILE,
            'derivedRecipeSha256': digest(build.pinned_recipe(recipe))},
        'toolchain': {'baseImage': build.ALPINE, 'compilerSourceCommit': build.COMPILER,
            'opamRepositoryCommit': build.OPAM_REPOSITORY, 'target': 'semgrep-core-container',
            'platform': 'linux/amd64', 'elfMachine': 62},
        'wrapperVersion': build.VERSION,
        'inputLineEndings': {'versionedAttributes': list(INPUT_ATTRIBUTES), 'actualBytes': 'lf-only'}}


def validate(value):
    expected = fixed_inputs()
    if (not isinstance(value, dict) or set(value) != set(expected) | {
            'requirementsSha256', 'toolsConfigurationSha256', 'programs'}
            or any(value.get(key) != item for key, item in expected.items())
            or not isinstance(value['programs'], dict) or set(value['programs']) != set(PROGRAMS)):
        raise ValueError('Unreviewed compiler build-input identity')
    hashes = [value['requirementsSha256'], value['toolsConfigurationSha256'], *value['programs'].values()]
    if any(not isinstance(item, str) or not re.fullmatch('[a-f0-9]{64}', item) for item in hashes):
        raise ValueError('Compiler input identity contains an unpinned input')
    return value


def inputs(root):
    directory = Path(root) / 'scripts/security'
    # Do not silently normalize a compiler input. The versioned checkout policy
    # must request LF, and the actual bytes must comply before they are hashed.
    # A local Git override producing CRLF is therefore a hard failure too.
    attributes = regular(Path(root) / '.gitattributes').decode('utf8').splitlines()
    if any(rule not in attributes for rule in INPUT_ATTRIBUTES):
        raise ValueError('Compiler inputs require the versioned LF checkout attributes')
    def lf_input(name):
        data = regular(directory / name)
        if b'\r' in data:
            raise ValueError('Compiler input bytes violate the versioned LF checkout policy')
        return data
    programs = {}
    for name in PROGRAMS:
        programs[name] = digest(lf_input(name))
    value = {**fixed_inputs(), 'requirementsSha256': digest(lf_input('requirements.txt')),
        'toolsConfigurationSha256': digest(lf_input('tools.json')),
        'programs': programs}
    return validate(value)
