#!/usr/bin/env bash
# Dedicated synthetic development instance, not an installation into a product cluster.
set -euo pipefail
umask 077
base=/home/gpadmin/grabenplaner-pg-migration-20260912
bin=/usr/lib/postgresql/18/bin
test "$(id -un)" = gpadmin
test -x "$bin/initdb"
test ! -e "$base"
mkdir -m 700 "$base"
printf '%s\n' 'grabenplaner-postgresql-migration-development-v1' > "$base/ownership-marker"
python3 - "$base" <<'PY'
import pathlib,secrets,json,sys
p=pathlib.Path(sys.argv[1])
accounts={role:secrets.token_hex(32) for role in ['gp_migration_admin','gp_core_migrator','gp_core_app','gp_core_reader','gp_sales_migrator','gp_sales_app','gp_sales_reader']}
(p/'credentials.json').write_text(json.dumps({'host':'127.0.0.1','port':55482,'accounts':accounts}))
(p/'admin-password').write_text(accounts['gp_migration_admin']+'\n')
(p/'admin-pgpass').write_text('127.0.0.1:55482:*:gp_migration_admin:'+accounts['gp_migration_admin']+'\n')
PY
"$bin/initdb" --pgdata="$base/data" --username=gp_migration_admin --pwfile="$base/admin-password" --auth=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8 > "$base/initdb.log"
cat >> "$base/data/postgresql.conf" <<'CONF'
listen_addresses = '127.0.0.1'
port = 55482
unix_socket_directories = ''
max_connections = 20
max_locks_per_transaction = 256
shared_buffers = '64MB'
work_mem = '4MB'
maintenance_work_mem = '32MB'
max_wal_size = '256MB'
min_wal_size = '80MB'
statement_timeout = '30s'
lock_timeout = '3s'
idle_in_transaction_session_timeout = '60s'
log_statement = 'none'
log_min_error_statement = 'panic'
log_parameter_max_length_on_error = 0
password_encryption = 'scram-sha-256'
CONF
nice -n 15 "$bin/pg_ctl" --pgdata="$base/data" --log="$base/postgresql.log" --wait start > "$base/start.log"
export PGPASSFILE="$base/admin-pgpass"
python3 - "$base" <<'PY' | "$bin/psql" -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55482 -U gp_migration_admin -d postgres > "$base/provision.log"
import json,pathlib,sys
accounts=json.loads((pathlib.Path(sys.argv[1])/'credentials.json').read_text())['accounts']
print('REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;')
print('REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;')
for domain in ['core','sales']:
    owner='gp_'+domain+'_owner'
    print('CREATE ROLE '+owner+' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;')
    for purpose in ['migrator','app','reader']:
        role='gp_'+domain+'_'+purpose
        print("CREATE ROLE "+role+" LOGIN PASSWORD '"+accounts[role]+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;")
        print("ALTER ROLE "+role+" SET search_path TO pg_catalog;")
    print('GRANT '+owner+' TO gp_'+domain+'_migrator;')
    db='gp_migration_'+domain
    print('CREATE DATABASE '+db+' OWNER '+owner+';')
    print('REVOKE ALL ON DATABASE '+db+' FROM PUBLIC;')
    print('GRANT CONNECT ON DATABASE '+db+' TO '+','.join('gp_'+domain+'_'+s for s in ['migrator','app','reader'])+';')
    print('\\connect '+db)
    print('REVOKE CREATE ON SCHEMA public FROM PUBLIC;')
    print('CREATE SCHEMA gp AUTHORIZATION '+owner+';')
    print('GRANT USAGE ON SCHEMA gp TO gp_'+domain+'_app,gp_'+domain+'_reader;')
    print('ALTER DEFAULT PRIVILEGES FOR ROLE '+owner+' IN SCHEMA gp GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO gp_'+domain+'_app;')
    print('ALTER DEFAULT PRIVILEGES FOR ROLE '+owner+' IN SCHEMA gp GRANT SELECT ON TABLES TO gp_'+domain+'_reader;')
    print('ALTER DEFAULT PRIVILEGES FOR ROLE '+owner+' IN SCHEMA gp GRANT USAGE,SELECT ON SEQUENCES TO gp_'+domain+'_app;')
    print('ALTER DEFAULT PRIVILEGES FOR ROLE '+owner+' IN SCHEMA gp REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;')
    print('\\connect postgres')
PY
"$bin/psql" -X -A -t -h 127.0.0.1 -p 55482 -U gp_migration_admin -d postgres -c "SELECT version(); SELECT datname FROM pg_database WHERE datname LIKE 'gp_migration_%';"
