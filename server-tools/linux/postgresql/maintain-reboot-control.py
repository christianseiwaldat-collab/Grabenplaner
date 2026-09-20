#!/usr/bin/env python3
"""Explicit, reversible GP708 control-module transition; never requests a reboot.

Run as root with --check or --apply and the verified candidate application root.
Only the two declared module files and their installed copies may change.
The PostgreSQL receipt is published only after its actual unit bytes match.
"""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid

APP = Path('/opt/grabenplaner/app')
BROKER = 'server-tools/linux/host-control/lib/host-reboot-broker.js'
UNIT = 'server-tools/linux/postgresql/grabenplaner-postgresql-control@.service.in'
RECEIPT = Path('/var/lib/grabenplaner-postgresql/installed.json')
OLD = {BROKER: '074d09567f024320ce0294e4d2b00e081b274c10178d091841c9fc8ec23f5133',
       UNIT: '4a97dc6e718a6368a54b58e02ade357aa4742c2e2d48d6ce125e40d37de150d0'}
NEW = {'server-tools/linux/host-control/lib/host-reboot-broker.js': '2300e0fee92fdda44c864ce8e017613eef3b7485ddbf21b3bb73bb6deac59c15', 'server-tools/linux/postgresql/grabenplaner-postgresql-control@.service.in': '93f60cd8c8f14b5ab6cc815bc2718f91682294c4d91a65422c0a23cef63febfc'}
SOCKETS = ['grabenplaner-host-control.socket', 'grabenplaner-postgresql-control.socket']

def digest(data):
    return hashlib.sha256(data).hexdigest()

def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()

def safe_file(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
            or info.st_mode & 0o022 or path.resolve() != path):
        raise RuntimeError('MODULE_UNSAFE_FILE: ' + str(path))
    return info

def replace_file(path, data, info):
    pending = path.with_name(path.name + '.gp-module-' + str(uuid.uuid4()))
    try:
        with pending.open('xb') as stream:
            os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
            os.fchown(stream.fileno(), info.st_uid, info.st_gid)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, path)
        fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if pending.exists():
            pending.unlink()

def transaction(updates, verify):
    """Rollback exact bytes/metadata on any failed post-install validation."""
    originals = [(p, p.read_bytes(), safe_file(p)) for p, _ in updates]
    try:
        for (path, data), (_, _, info) in zip(updates, originals):
            replace_file(path, data, info)
        verify()
    except BaseException:
        for path, data, info in reversed(originals):
            replace_file(path, data, info)
        raise

def no_active_operations():
    units = json.loads(run('systemctl', 'list-units', '--all', '--output=json', '--no-pager',
        'grabenplaner*', 'apt-daily*.service', 'fwupd-refresh.service', 'clamav-freshclam-once.service'))
    for entry in units:
        name = entry['unit']
        if entry['active'] not in ('active', 'activating', 'deactivating', 'reloading'):
            continue
        if name == 'grabenplaner-test.service' and run('systemctl','show',name,'--value','-p','WorkingDirectory') == '/opt/grabenplaner-test/current':
            continue  # Existing independent synthetic app, not a recovery operation.
        if name in ('grabenplaner.service', 'grabenplaner-postgresql.service') or name.endswith(('.timer', '.socket')):
            continue
        raise RuntimeError('MODULE_OPERATION_BUSY: ' + name)

def main():
    if os.geteuid() != 0 or len(sys.argv) != 3 or sys.argv[1] not in ('--check', '--apply'):
        raise RuntimeError('Usage: maintain-reboot-control.py --check|--apply CANDIDATE_ROOT')
    candidate = Path(sys.argv[2])
    if not candidate.is_absolute() or candidate.resolve() != candidate or candidate.stat().st_uid != 0:
        raise RuntimeError('MODULE_CANDIDATE_PATH')
    lock_path = Path('/run/grabenplaner/maintenance.lock')
    safe_file(lock_path)
    with lock_path.open('rb') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        no_active_operations()
        run('systemctl', 'is-active', 'grabenplaner.service')
        run('/usr/bin/node', str(APP/'server-tools/linux/postgresql/managed-contract.js'), str(APP))
        safe_file(RECEIPT)
        receipt = json.loads(RECEIPT.read_text())
        updates = []
        for source, targets in [(BROKER, [APP/BROKER, Path('/opt/grabenplaner-host-control/module/lib/host-reboot-broker.js')]),
                                (UNIT, [APP/UNIT, Path('/etc/systemd/system/grabenplaner-postgresql-control@.service')])]:
            safe_file(candidate/source)
            data = (candidate/source).read_bytes()
            # Only the reviewed GP708 diff is accepted, not an arbitrary replacement.
            before = (APP/source).read_bytes()
            if digest(before) != OLD[source] or digest(data) != NEW[source]:
                raise RuntimeError('MODULE_UNEXPECTED_BASE: ' + source)
            for target in targets:
                safe_file(target)
                if target.read_bytes() != before:
                    raise RuntimeError('MODULE_INSTALLED_COPY_DRIFT: ' + str(target))
                updates.append((target, data))
        run('/usr/bin/node', '--check', str(candidate/BROKER))
        run('/usr/bin/node', '-e', "require(process.argv[1]).preflight()", str(candidate/'server-tools/linux/postgresql/host-reboot.js'))
        # Check all other unit contracts against the candidate before changing anything.
        for unit in receipt['units']:
            source = candidate/'server-tools/linux/postgresql'/unit['source']
            safe_file(source)
            if unit['source'] != Path(UNIT).name and digest(source.read_bytes()) != unit['sha256']:
                raise RuntimeError('MODULE_OTHER_UNIT_CHANGED')
        result = {'status': 'checked', 'files': {str(p): digest(data) for p, data in updates},
                  'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        if sys.argv[1] == '--check':
            print(json.dumps(result)); return
        evidence = Path('/var/lib/grabenplaner-postgresql/module-maintenance')/str(uuid.uuid4())
        evidence.mkdir(mode=0o700, parents=True)
        os.chmod(evidence.parent, 0o700)
        for i, (target, _) in enumerate(updates + [(RECEIPT, b'')]):
            (evidence/str(i)).write_bytes(target.read_bytes())
        (evidence/'before.json').write_text(json.dumps({'receipt':receipt,'files':[
            {'path':str(p),'sha256':digest(p.read_bytes()),'mode':stat.S_IMODE(p.stat().st_mode),'gid':p.stat().st_gid}
            for p, _ in updates + [(RECEIPT,b'')]]},indent=2))
        staged_unit = evidence/'grabenplaner-postgresql-control@.service'
        staged_unit.write_bytes((candidate/UNIT).read_bytes())
        run('systemd-analyze','verify',str(staged_unit))
        active_sockets = [s for s in SOCKETS if subprocess.run(['systemctl','is-active','--quiet',s]).returncode == 0]
        boot = Path('/proc/sys/kernel/random/boot_id').read_text()
        pid = run('systemctl','show','grabenplaner.service','--value','-p','MainPID')
        try:
            for socket in active_sockets:
                run('systemctl','stop',socket)
            no_active_operations()
            for unit in receipt['units']:
                if unit['source'] == Path(UNIT).name:
                    unit['sha256'] = digest((candidate/UNIT).read_bytes())
            receipt['lastModuleMaintenanceAt'] = result['at']
            receipt['lastModuleMaintenanceId'] = evidence.name
            updates.append((RECEIPT, (json.dumps(receipt,indent=2)+'\n').encode()))
            def verify():
                run('systemctl','daemon-reload')
                run('/usr/bin/node',str(APP/'server-tools/linux/postgresql/managed-contract.js'),str(APP))
                run('/usr/bin/node',str(APP/'server-tools/linux/postgresql/managed-contract.js'),str(candidate))
                run('/usr/bin/node','-e',"require(process.argv[1]).preflight()",str(APP/'server-tools/linux/postgresql/host-reboot.js'))
                if boot != Path('/proc/sys/kernel/random/boot_id').read_text() or pid != run('systemctl','show','grabenplaner.service','--value','-p','MainPID'):
                    raise RuntimeError('MODULE_UNEXPECTED_APP_OR_BOOT_CHANGE')
                run('curl','-fsS','--max-time','10','http://127.0.0.1:3000/api/health/ready')
            transaction(updates, verify)
            result.update(status='installed', evidence=str(evidence), appPid=pid, rebootRequested=False)
        except BaseException:
            run('systemctl','daemon-reload')
            (evidence/'FAILED').write_text('Module transition failed; inspect originals and journal.\n')
            raise
        finally:
            for socket in active_sockets:
                run('systemctl','start',socket)
        (evidence/'result.json').write_text(json.dumps(result,indent=2))
        print(json.dumps(result))

if __name__ == '__main__':
    main()
