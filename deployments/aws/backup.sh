#!/usr/bin/env bash
# Hourly backup: a consistent snapshot of every SQLite database, uploaded to S3, with the last
# 48 local snapshots kept. Run by naryx-backup.timer. Needs NARYX_BACKUP_S3_URI and the AWS CLI;
# the EC2 instance role grants s3:PutObject on that prefix (no access keys on the host).
set -euo pipefail
: "${NARYX_BACKUP_S3_URI:?set NARYX_BACKUP_S3_URI in /srv/naryx/backup.env}"
data_dir="${NARYX_DATA_DIR:-/srv/naryx/data}"
backup_root="${NARYX_BACKUP_DIR:-/srv/naryx/backups}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backup_root/$stamp"

node "$(dirname "$0")/backup-sqlite.mjs" "$data_dir" "$target"
aws s3 sync --only-show-errors "$target" "$NARYX_BACKUP_S3_URI/$stamp"
ls -1d "$backup_root"/*/ 2>/dev/null | sort | head -n -48 | xargs -r rm -rf
