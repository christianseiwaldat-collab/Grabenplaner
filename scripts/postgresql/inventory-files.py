"""Summarize protected GP storage without reading payloads or key material."""
import collections
import json
import os
import pathlib

root = pathlib.Path('/var/lib/grabenplaner')
groups = collections.defaultdict(lambda: {'files': 0, 'bytes': 0, 'symlinks': 0})
for directory, dirs, files in os.walk(root, followlinks=False):
    for name in files:
        path = pathlib.Path(directory, name)
        relative = path.relative_to(root)
        group = relative.parts[0] if len(relative.parts) > 1 else 'root-files'
        item = groups[group]
        if path.is_symlink():
            item['symlinks'] += 1
        else:
            item['files'] += 1
            item['bytes'] += path.stat().st_size
configuration = pathlib.Path('/etc/grabenplaner/grabenplaner.env')
names = []
if configuration.is_file():
    for line in configuration.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            name = line.split('=', 1)[0].strip()
            if any(word in name for word in ['KEY', 'SECRET', 'TOKEN', 'PATH', 'DIR', 'DATABASE', 'DB_']):
                names.append(name)
print(json.dumps({'root': str(root), 'storageGroups': dict(sorted(groups.items())),
                  'configurationVariableNamesOnly': sorted(set(names)),
                  'payloadsRead': False, 'configurationValuesEmitted': False}, indent=2))
