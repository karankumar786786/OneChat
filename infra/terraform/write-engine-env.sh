#!/usr/bin/env bash
# Copies the bucket and the engine's key from Terraform outputs into engine/.env.
# Secrets go file-to-file through environment variables; nothing is printed.
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE="../../engine/.env"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (copy engine/.env.example first)"; exit 1; }

set_var() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    K="$key" V="$value" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] } index($0, k "=") == 1 { print k "=" v; next } { print }' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

set_var S3_BUCKET "$(terraform output -raw bucket_name)"
set_var S3_REGION "$(terraform output -raw region)"
set_var S3_ENDPOINT ""
set_var S3_PUBLIC_ENDPOINT ""
set_var S3_FORCE_PATH_STYLE "false"
set_var AWS_ACCESS_KEY_ID "$(terraform output -raw engine_access_key_id)"
set_var AWS_SECRET_ACCESS_KEY "$(terraform output -raw engine_secret_access_key)"
chmod 600 "$ENV_FILE"
echo "engine/.env updated: S3_BUCKET=$(terraform output -raw bucket_name), S3_REGION=$(terraform output -raw region), AWS keys set. Restart the engine."
