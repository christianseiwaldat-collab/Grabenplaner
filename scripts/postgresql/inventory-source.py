"""Read-only SQLite migration inventory; never returns business rows or secrets."""
import argparse
import collections
import datetime
import hashlib
import json
import pathlib
import sqlite3
import time


def inventory(database, statistics=False):
    path = pathlib.Path(database).resolve(strict=True)
    if not path.is_file():
        raise ValueError('A database file is required')
    connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=3)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    connection.execute('BEGIN')
    try:
        objects = [dict(row) for row in connection.execute(
            "SELECT type,name,tbl_name AS table_name,sql FROM sqlite_schema "
            "WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
        tables = []
        for obj in objects:
            if obj['type'] != 'table':
                continue
            name = obj['name'].replace('"', '""')
            entry = {'name': obj['name'],
                     'columns': [dict(row) for row in connection.execute('PRAGMA table_xinfo("' + name + '")')],
                     'foreignKeys': [dict(row) for row in connection.execute('PRAGMA foreign_key_list("' + name + '")')],
                     'indexes': [dict(row) for row in connection.execute('PRAGMA index_list("' + name + '")')]}
            if statistics:
                start = time.monotonic()
                entry['rowCount'] = connection.execute('SELECT count(*) FROM "' + name + '"').fetchone()[0]
                entry['countMilliseconds'] = round((time.monotonic() - start) * 1000, 3)
            tables.append(entry)
        sizes = []
        if statistics:
            sizes = [dict(row) for row in connection.execute(
                'SELECT name,count(*) AS pages,sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY name')]
        schema_bytes = json.dumps(objects, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
        return {'version': 1, 'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'sourceKind': 'isolated-backup' if statistics else 'schema-only',
                'fileName': path.name, 'fileBytes': path.stat().st_size,
                'schemaSha256': hashlib.sha256(schema_bytes).hexdigest(),
                'sqliteVersion': sqlite3.sqlite_version,
                'objectCounts': dict(collections.Counter(obj['type'] for obj in objects)),
                'objects': objects, 'tables': tables, 'pageSizes': sizes}
    finally:
        connection.rollback()
        connection.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--statistics-on-isolated-backup', action='store_true')
    args = parser.parse_args()
    print(json.dumps(inventory(args.database, args.statistics_on_isolated_backup), ensure_ascii=False, indent=2))
