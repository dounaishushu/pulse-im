#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/backup-common.sh"
mode=verify
if [[ "${1:-}" == --restore ]]; then mode=restore; shift; fi
[[ $# == 1 && -f "$1" ]] || { echo "Usage: $0 [--restore] ARCHIVE.tar.gz" >&2; exit 2; }
archive="$(cd -- "$(dirname -- "$1")" && pwd -P)/$(basename -- "$1")"
for command in tar sha256sum; do command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 2; }; done
[[ -f "$archive.sha256" ]] || { echo 'Missing archive checksum; backup is unverified' >&2; exit 2; }
(cd -- "$(dirname -- "$archive")" && sha256sum --check --status "$(basename -- "$archive").sha256") || { echo 'Archive checksum mismatch' >&2; exit 2; }
while IFS= read -r entry; do
  [[ "$entry" != /* && "$entry" != *../* && "$entry" != ../* && "$entry" != *\\* ]] || { echo 'Unsafe archive path' >&2; exit 2; }
  case "$entry" in pulse-im.sql|manifest.txt|storage|storage/|storage/*) ;; *) echo 'Unexpected archive content' >&2; exit 2;; esac
done < <(tar -tzf "$archive")
tar -tvzf "$archive" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" { bad=1 } END { exit bad }' || { echo 'Archive contains unsupported file types' >&2; exit 2; }
sql_hash="$(tar -xOzf "$archive" pulse-im.sql | sha256sum | cut -d' ' -f1)"
manifest="$(tar -xOzf "$archive" manifest.txt)"
[[ "$manifest" == *'format=pulse-im-backup-v2'* && ( "$manifest" == *"$sql_hash  pulse-im.sql"* || "$manifest" == *"$sql_hash *pulse-im.sql"* ) ]] || { echo 'SQL dump checksum mismatch' >&2; exit 2; }
echo 'Archive and SQL integrity checks passed'
[[ "$mode" == restore ]] || exit 0
[[ -n "${RESTORE_ENV_FILE:-}" ]] || { echo 'RESTORE_ENV_FILE with a separate isolated MySQL account is required' >&2; exit 2; }
load_database_config "$RESTORE_ENV_FILE"
[[ "$DB_NAME" =~ ^pulse_im_restore_[0-9]{14}_[a-f0-9]{6}$ ]] || { echo 'DB_NAME must be pulse_im_restore_<UTC timestamp>_<six hex characters>' >&2; exit 2; }
command -v mysql >/dev/null || { echo 'mysql is required' >&2; exit 2; }
DRILL_ROOT="${DRILL_ROOT:-/var/backups/pulse-im-restore-drills}"
mkdir -p -- "$DRILL_ROOT"
[[ ! -L "$DRILL_ROOT" ]] || { echo 'DRILL_ROOT must not be a symlink' >&2; exit 2; }
DRILL_ROOT="$(cd -- "$DRILL_ROOT" && pwd -P)"
[[ "$DRILL_ROOT" != / ]] || { echo 'DRILL_ROOT cannot be /' >&2; exit 2; }
target="$DRILL_ROOT/$DB_NAME"
[[ ! -e "$target" ]] || { echo 'Isolated restore directory already exists' >&2; exit 2; }
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/pulse-im-restore.XXXXXX")"
cleanup() { [[ -d "$work_dir" && "$(basename -- "$work_dir")" == pulse-im-restore.* ]] && rm -rf -- "$work_dir"; return 0; }
trap cleanup EXIT
write_mysql_options "$work_dir/mysql.cnf"
mysql --defaults-extra-file="$work_dir/mysql.cnf" -N -e 'SHOW GRANTS FOR CURRENT_USER' > "$work_dir/grants.txt"
# The restore credential must not have privileges on production or other databases.
while IFS= read -r grant; do
  [[ "$grant" == 'GRANT USAGE ON *.* TO '* || "$grant" == *' ON `pulse\_im\_restore\_%`.* TO '* ]] || { echo 'Restore account has privileges outside isolated restore databases' >&2; exit 2; }
done < "$work_dir/grants.txt"
existing="$(mysql --defaults-extra-file="$work_dir/mysql.cnf" -N -e "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$DB_NAME'")"
[[ -z "$existing" ]] || { echo 'Isolated database already exists' >&2; exit 2; }
mkdir -- "$target"
tar -xzf "$archive" -C "$target" --no-same-owner --no-same-permissions
[[ -d "$target/storage" ]] || { echo 'Restored storage directory is missing' >&2; exit 2; }
if grep -Eiq '^[[:space:]]*(CREATE|DROP)[[:space:]]+DATABASE|^[[:space:]]*USE[[:space:]]' "$target/pulse-im.sql"; then echo 'Dump selects/creates a database; import refused' >&2; exit 2; fi
mysql --defaults-extra-file="$work_dir/mysql.cnf" -e "CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4"
# Bind restored triggers/routines to the isolated account rather than production DEFINERs.
sed -E 's/DEFINER=`[^`]*`@`[^`]*`/DEFINER=CURRENT_USER/g' "$target/pulse-im.sql" > "$target/isolated-import.sql"
mysql --defaults-extra-file="$work_dir/mysql.cnf" --database="$DB_NAME" < "$target/isolated-import.sql"
mysql --defaults-extra-file="$work_dir/mysql.cnf" -N --database="$DB_NAME" -e 'SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM messages; SELECT COUNT(*) FROM admin_accounts; SELECT COUNT(*) FROM realtime_events;' > "$target/database-smoke-counts.txt"
printf 'database=%s\nstorage=%s/storage\nverified_at_utc=%s\n' "$DB_NAME" "$target" "$(date -u +%FT%TZ)" > "$target/restore-report.txt"
echo "Isolated restore completed: database=$DB_NAME; report=$target/restore-report.txt"
echo 'Isolated database and media retained for review; production database was not selected.'
