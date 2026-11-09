#!/usr/bin/env bash
# Read deployment settings as data, never execute dotenv content.
load_database_config() {
  local env_file="$1" line key value
  [[ -f "$env_file" ]] || { echo "Missing database configuration: $env_file" >&2; return 2; }
  DB_HOST='' DB_PORT='' DB_NAME='' DB_USER='' DB_PASSWORD=''
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[[:space:]]*(DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASSWORD)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      key="${BASH_REMATCH[1]}" value="${BASH_REMATCH[2]}"
      value="${value%"${value##*[![:space:]]}"}"
      if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value="${value:1:${#value}-2}"; fi
      printf -v "$key" '%s' "$value"
    fi
  done < "$env_file"
  for key in DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD; do [[ -n "${!key}" ]] || { echo "$key is empty" >&2; return 2; }; done
  [[ "$DB_PORT" =~ ^[0-9]+$ && "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || { echo 'Invalid database port/name' >&2; return 2; }
}
write_mysql_options() {
  local destination="$1" key value
  printf '[client]\n' > "$destination"
  for key in DB_HOST DB_PORT DB_USER DB_PASSWORD; do
    value="${!key}"; value="${value//\\/\\\\}"; value="${value//\"/\\\"}"
    case "$key" in DB_HOST) key=host;; DB_PORT) key=port;; DB_USER) key=user;; DB_PASSWORD) key=password;; esac
    printf '%s="%s"\n' "$key" "$value" >> "$destination"
  done
  chmod 600 "$destination"
}
