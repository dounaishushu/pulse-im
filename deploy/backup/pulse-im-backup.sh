#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ENV_FILE="${ENV_FILE:-/www/wwwroot/pulse-im/backend/.env}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/pulse-im}"
PROJECT_ROOT="${PROJECT_ROOT:-/www/wwwroot/pulse-im}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/backup-common.sh"
DRY_RUN=0
if [[ "${1:-}" == --dry-run && $# == 1 ]]; then DRY_RUN=1; elif [[ $# != 0 ]]; then echo "Usage: $0 [--dry-run]" >&2; exit 2; fi
[[ -d "$PROJECT_ROOT/backend/public/storage" ]] || { echo 'Missing storage directory' >&2; exit 2; }
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && (( RETENTION_DAYS >= 1 )) || { echo 'RETENTION_DAYS must be positive' >&2; exit 2; }
load_database_config "$ENV_FILE"
if (( DRY_RUN )); then echo "Backup configuration valid; database=$DB_NAME; storage=$PROJECT_ROOT/backend/public/storage; destination=$BACKUP_ROOT; retention=$RETENTION_DAYS days"; exit 0; fi
for command in mysqldump tar sha256sum; do command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 2; }; done
mkdir -p -- "$BACKUP_ROOT"
[[ ! -L "$BACKUP_ROOT" ]] || { echo 'BACKUP_ROOT must not be a symlink' >&2; exit 2; }
BACKUP_ROOT="$(cd -- "$BACKUP_ROOT" && pwd -P)"
[[ "$BACKUP_ROOT" != / ]] || { echo 'BACKUP_ROOT cannot be /' >&2; exit 2; }
timestamp="$(date -u +%Y%m%d-%H%M%S)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/pulse-im-backup.XXXXXX")"
archive="$BACKUP_ROOT/pulse-im-$timestamp.tar.gz"
partial="$archive.partial"
cleanup() { [[ -d "$work_dir" && "$(basename -- "$work_dir")" == pulse-im-backup.* ]] && rm -rf -- "$work_dir"; [[ -f "$partial" ]] && rm -f -- "$partial"; return 0; }
trap cleanup EXIT
[[ ! -e "$archive" ]] || { echo 'Backup name already exists; retry in one second' >&2; exit 2; }
write_mysql_options "$work_dir/mysql.cnf"
mysqldump --defaults-extra-file="$work_dir/mysql.cnf" --single-transaction --quick --no-tablespaces --set-gtid-purged=OFF --routines --triggers "$DB_NAME" > "$work_dir/pulse-im.sql"
[[ -s "$work_dir/pulse-im.sql" ]] || { echo 'Empty database dump' >&2; exit 2; }
printf 'format=pulse-im-backup-v2\ncreated_at_utc=%s\nsource_database=%s\n' "$(date -u +%FT%TZ)" "$DB_NAME" > "$work_dir/manifest.txt"
(cd -- "$work_dir" && sha256sum pulse-im.sql) >> "$work_dir/manifest.txt"
tar -czf "$partial" -C "$work_dir" pulse-im.sql manifest.txt -C "$PROJECT_ROOT/backend/public" storage
tar -tzf "$partial" >/dev/null
chmod 600 "$partial"
mv -- "$partial" "$archive"
(cd -- "$BACKUP_ROOT" && sha256sum "$(basename -- "$archive")" > "$(basename -- "$archive").sha256")
chmod 600 "$archive.sha256"
find "$BACKUP_ROOT" -maxdepth 1 -type f \( -name 'pulse-im-*.tar.gz' -o -name 'pulse-im-*.tar.gz.sha256' \) -mtime "+$RETENTION_DAYS" -delete
echo "Backup created and integrity checked: $archive"
