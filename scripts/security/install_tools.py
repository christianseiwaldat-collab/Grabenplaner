"""Install only explicitly pinned scanner artifacts; never execute downloaded installers."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile
import urllib.request
import zipfile

CONFIG = Path(__file__).with_name('tools.json')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verified_download(asset, cache):
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / asset['sha256']
    if target.exists():
        data = target.read_bytes()
    else:
        with urllib.request.urlopen(asset['url'], timeout=120) as response:
            data = response.read(asset['bytes'] + 1)
        if len(data) != asset['bytes'] or digest(data) != asset['sha256']:
            raise ValueError('Scanner download integrity mismatch')
        target.write_bytes(data)
    if len(data) != asset['bytes'] or digest(data) != asset['sha256']:
        raise ValueError('Scanner cache integrity mismatch')
    return data


def install(tool, directory, cache=None):
    config = json.loads(CONFIG.read_text())
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    cache = Path(cache).resolve() if cache else directory / 'downloads'
    if tool == 'rules':
        asset = config['rules']
        data = verified_download(asset, cache)
        files = []
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            for item in archive:
                relative = PurePosixPath(*PurePosixPath(item.name).parts[1:])
                if relative.is_absolute() or '..' in relative.parts:
                    raise ValueError('Unsafe rule archive path')
                name = relative.as_posix()
                selected = (name.startswith('javascript/') and '/security/' in name
                            or name.startswith('typescript/lang/security/')) and name.endswith('.yaml')
                if not selected and name != 'LICENSE':
                    continue
                if not item.isfile():
                    raise ValueError('Non-regular rule archive member')
                content = archive.extractfile(item).read()
                target = directory / 'rules' / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                files.append({'path':name, 'sha256':digest(content)})
        if len(files) < 100:
            raise ValueError('Incomplete pinned security rule bundle')
        (directory/'rules-manifest.json').write_text(json.dumps({'commit':asset['commit'], 'archiveSha256':asset['sha256'], 'files':files},indent=2))
        return directory / 'rules'
    platform = 'windows' if sys.platform == 'win32' else 'linux' if sys.platform.startswith('linux') else None
    if platform is None:
        raise ValueError('Only Windows/Linux x86-64 scanner runtimes are qualified')
    import platform as architecture
    if architecture.machine().lower() not in ('amd64','x86_64'):
        raise ValueError('Only x86-64 scanner runtimes are qualified')
    asset = config['tools'][tool]['assets'][platform]
    data = verified_download(asset, cache)
    if asset['filename'].endswith('.zip'):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            data = archive.read(asset['member'])
    elif asset['filename'].endswith('.tar.gz'):
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            item = archive.getmember(asset['member'])
            if not item.isfile():
                raise ValueError('Non-regular scanner executable')
            data = archive.extractfile(item).read()
    target = directory / asset['member']
    target.write_bytes(data)
    target.chmod(0o755)
    (directory/(tool+'-receipt.json')).write_text(json.dumps({'version':config['tools'][tool]['version'], 'asset':asset, 'executableSha256':digest(data)},indent=2))
    return target


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--tool',choices=['gitleaks','syft','osv-scanner','rules'],required=True)
    parser.add_argument('--directory',required=True)
    parser.add_argument('--cache')
    args=parser.parse_args()
    print(install(args.tool,args.directory,args.cache))
