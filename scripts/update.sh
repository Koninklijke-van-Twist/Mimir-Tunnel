#!/usr/bin/env bash
# Werkt de Mimir BC-bridge bij op de server. Draaien met sudo.
#
#   sudo /home/administrator/mimir-tunnel/scripts/update.sh [branch]
#
# Zonder argument is de branch master, tenzij MIMIR_BRANCH gezet is.
# Het argument wint van MIMIR_BRANCH.
#
# Paden (standaard de KVT-server):
#   MIMIR_SRC      /home/administrator/mimir-tunnel
#   MIMIR_DEST     /opt/mimir-bc-bridge
#   MIMIR_USER     bcbridge
#   MIMIR_GROUP    bcbridge
#   MIMIR_SERVICE  mimir-bc-bridge
#   MIMIR_GIT_USER eigenaar van MIMIR_SRC
#
# De checkout blijft van de git-gebruiker. /opt wordt van bcbridge.
# .env in /opt wordt nooit overschreven. rsync wordt niet gebruikt.

set -euo pipefail
umask 077

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'FOUT: draai dit script met sudo.\n' >&2
  exit 1
fi

# Git checkout vervangt dit bestand terwijl het nog loopt. Verder gaan vanuit een kopie.
if [[ -z "${MIMIR_UPDATE_REEXEC:-}" ]]; then
  copy="$(mktemp /tmp/mimir-bc-bridge-update.XXXXXX.sh)"
  cp -- "$0" "$copy"
  chmod 700 "$copy"
  export MIMIR_UPDATE_REEXEC=1
  export MIMIR_UPDATE_REEXEC_COPY="$copy"
  exec bash "$copy" "$@"
fi

SRC="${MIMIR_SRC:-/home/administrator/mimir-tunnel}"
DEST="${MIMIR_DEST:-/opt/mimir-bc-bridge}"
SERVICE_USER="${MIMIR_USER:-bcbridge}"
SERVICE_GROUP="${MIMIR_GROUP:-bcbridge}"
SERVICE="${MIMIR_SERVICE:-mimir-bc-bridge}"
BACKUP_ROOT="${MIMIR_BACKUP_DIR:-/opt/mimir-bc-bridge.backups}"
HEALTH_TRIES="${MIMIR_HEALTH_TRIES:-20}"
HEALTH_INTERVAL="${MIMIR_HEALTH_INTERVAL:-0.5}"
LOCK_FILE="${MIMIR_LOCK:-/var/lock/mimir-bc-bridge-update.lock}"

phase=init
stage=""
backup=""
token=""
port=""
health_body=""
rolling_back=0

say() { printf '==> %s\n' "$*"; }
die() { printf 'FOUT: %s\n' "$*" >&2; exit 1; }

remove_tree() {
  local target="$1" parent
  [[ -n "$target" && -d "$target" ]] || return 0
  parent="$(dirname "$DEST")"
  case "$target" in
    "$parent"/.mimir-bc-bridge-stage.*) rm -rf -- "$target" ;;
    "$parent"/"$(basename "$DEST")".failed-*) rm -rf -- "$target" ;;
    *) printf 'FOUT: weiger te verwijderen: %s\n' "$target" >&2 ;;
  esac
}

env_value() {
  local file="$1" key="$2" line value
  [[ -f "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%$'\r'}"
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
    [[ "$line" == export\ * ]] && line="${line#export }"
    [[ "$line" == "$key="* ]] || continue
    value="${line#"${key}="}"
    # Zelfde regels als een systemd EnvironmentFile: quotes horen bij de waarde.
    value="${value%$'\r'}"
    printf '%s' "$value"
    return 0
  done < "$file"
  return 1
}

curl_escape() {
  local text="$1"
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  printf '%s' "$text"
}

health_once() {
  local cfg body status escaped
  cfg="$(mktemp)"
  chmod 600 "$cfg"
  escaped="$(curl_escape "$token")"
  printf 'header = "Authorization: Bearer %s"\nurl = "http://127.0.0.1:%s/health"\n' "$escaped" "$port" > "$cfg"
  body="$(curl --silent --show-error --fail --max-time 2 --config "$cfg" 2>/dev/null)" && status=0 || status=$?
  rm -f -- "$cfg"
  [[ "$status" -eq 0 ]] || return 1
  [[ "$body" == *'"ok":true'* || "$body" == *'"ok": true'* ]] || return 1
  health_body="$body"
}

wait_for_health() {
  local i
  for (( i = 1; i <= HEALTH_TRIES; i++ )); do
    if health_once; then
      return 0
    fi
    if (( i < HEALTH_TRIES )); then
      sleep "$HEALTH_INTERVAL"
    fi
  done
  return 1
}

journal_hint() {
  say "Laatste journalregels van $SERVICE:"
  journalctl -u "$SERVICE" -n 30 --no-pager || true
}

need_npm_install() {
  local file
  [[ -d "$DEST/node_modules" ]] || return 0
  for file in package.json package-lock.json; do
    [[ -f "$DEST/$file" && -f "$stage/$file" ]] || return 0
    cmp -s "$DEST/$file" "$stage/$file" || return 0
  done
  return 1
}

run_git() {
  sudo -u "$GIT_USER" -- env "PATH=$PATH" git -C "$SRC" "$@"
}

rollback() {
  [[ "$rolling_back" -eq 1 ]] && return 0
  rolling_back=1
  phase=rollback
  set +e
  say "De nieuwe versie komt niet in de lucht. Vorige versie wordt teruggezet uit $backup."
  if [[ ! -d "$backup" ]]; then
    printf 'FOUT: backup ontbreekt op %s.\n' "$backup" >&2
    return 1
  fi
  local failed
  failed="$(dirname "$DEST")/$(basename "$DEST").failed-$$"
  if [[ -d "$DEST" ]]; then
    mv -- "$DEST" "$failed" || {
      printf 'FOUT: de nieuwe boom kon niet aan de kant.\n' >&2
      return 1
    }
  fi
  if ! mv -- "$backup" "$DEST"; then
    printf 'FOUT: terugzetten mislukt. Nieuwe boom: %s. Backup: %s.\n' "$failed" "$backup" >&2
    return 1
  fi
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$DEST"
  chmod 750 "$DEST"
  [[ -f "$DEST/.env" ]] && chmod 600 "$DEST/.env"
  remove_tree "$failed"
  say "Service $SERVICE herstarten."
  if ! systemctl restart "$SERVICE"; then
    printf 'FOUT: herstart na terugzetten is mislukt.\n' >&2
    journal_hint
    return 1
  fi
  if wait_for_health; then
    say "Teruggezette versie antwoordt op /health. De update is niet actief."
  else
    say "Teruggezette versie antwoordt niet op /health. Zie journalctl -u $SERVICE."
    journal_hint
  fi
  return 0
}

prune_backups() {
  local -a dirs=()
  local d count keep i
  shopt -s nullglob
  for d in "$BACKUP_ROOT"/*; do
    [[ -d "$d" ]] && dirs+=("$d")
  done
  shopt -u nullglob
  count="${#dirs[@]}"
  keep=3
  if (( count > keep )); then
    for (( i = 0; i < count - keep; i++ )); do
      rm -rf -- "${dirs[$i]}"
    done
  fi
}

on_exit() {
  local status=$?
  if [[ "$phase" == "live" ]]; then
    rollback || true
  elif [[ "$phase" == "stage" ]]; then
    remove_tree "$stage"
  fi
  if [[ -n "${MIMIR_UPDATE_REEXEC_COPY:-}" && -f "${MIMIR_UPDATE_REEXEC_COPY}" ]]; then
    rm -f -- "$MIMIR_UPDATE_REEXEC_COPY"
  fi
  exit "$status"
}
trap on_exit EXIT

if [[ "$#" -gt 1 ]]; then
  die "Gebruik: $0 [branch]"
fi
if [[ "$#" -eq 1 ]]; then
  BRANCH="$1"
else
  BRANCH="${MIMIR_BRANCH:-master}"
fi
if [[ ! "$BRANCH" =~ ^[A-Za-z0-9._/][A-Za-z0-9._/-]*$ || "$BRANCH" == *..* ]]; then
  die "Branchnaam is ongeldig."
fi

[[ -d "$SRC" ]] || die "Checkout ontbreekt: $SRC"
[[ -d "$DEST" ]] || die "Installatie ontbreekt: $DEST"
SRC="$(realpath "$SRC")"
DEST="$(realpath "$DEST")"
[[ "$SRC" != "$DEST" ]] || die "Bron en bestemming zijn hetzelfde pad."
[[ -f "$DEST/.env" && ! -L "$DEST/.env" ]] || die "Geen gewoon bestand $DEST/.env. Maak die eerst; dit script overschrijft hem niet."

getent passwd "$SERVICE_USER" >/dev/null || die "Gebruiker $SERVICE_USER bestaat niet."
getent group "$SERVICE_GROUP" >/dev/null || die "Groep $SERVICE_GROUP bestaat niet."
GIT_USER="${MIMIR_GIT_USER:-$(stat -c '%U' "$SRC")}"
getent passwd "$GIT_USER" >/dev/null || die "Git-gebruiker $GIT_USER bestaat niet."

command -v git >/dev/null || die "git ontbreekt."
command -v tar >/dev/null || die "tar ontbreekt."
command -v curl >/dev/null || die "curl ontbreekt."
command -v systemctl >/dev/null || die "systemctl ontbreekt."

if ! systemctl cat "$SERVICE" >/dev/null 2>&1; then
  die "systemd-unit $SERVICE bestaat niet."
fi

if ! token="$(env_value "$DEST/.env" TUNNEL_TOKEN)" || [[ -z "$token" ]]; then
  die "TUNNEL_TOKEN ontbreekt in $DEST/.env."
fi
[[ "$token" != *$'\n'* && "$token" != *$'\r'* ]] || die "TUNNEL_TOKEN bevat een regeleinde."
if ! port="$(env_value "$DEST/.env" TUNNEL_PORT)" || [[ -z "$port" ]]; then
  port="8787"
fi
[[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] || die "TUNNEL_PORT is ongeldig."

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  die "Er loopt al een update."
fi

say "Bron $SRC bijwerken naar branch $BRANCH."
if ! run_git remote get-url origin >/dev/null 2>&1; then
  die "Remote origin ontbreekt in $SRC."
fi
if [[ -n "$(run_git status --porcelain)" ]]; then
  die "Werkboom in $SRC is niet schoon. Ruim lokale wijzigingen op en draai opnieuw."
fi
run_git fetch --prune origin
if run_git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  run_git checkout "$BRANCH"
else
  run_git checkout -B "$BRANCH" "origin/$BRANCH"
fi
run_git pull --ff-only origin "$BRANCH"
rev="$(run_git rev-parse --short HEAD)"
say "Branch $BRANCH staat op $rev."

install -d -m 700 "$BACKUP_ROOT"
stage="$(mktemp -d "$(dirname "$DEST")/.mimir-bc-bridge-stage.XXXXXX")"
phase=stage
say "Nieuwe boom klaarzetten vanuit $rev."
tar -C "$SRC" \
  --exclude=.git \
  --exclude=.env \
  --exclude=node_modules \
  --exclude=vendor \
  --exclude=logs \
  --exclude=.state \
  --exclude='*.tgz' \
  -cf - . | tar -C "$stage" -xf -
[[ ! -e "$stage/.env" ]] || die "De nieuwe boom bevat een .env. Kopiëren gestopt."
cp -a -- "$DEST/.env" "$stage/.env"

if need_npm_install; then
  command -v npm >/dev/null || die "npm ontbreekt."
  say "package.json of package-lock.json gewijzigd; npm install --omit=dev."
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$stage"
  # Cache in de stage, zodat de draaiende installatie niet wordt beschreven.
  sudo -u "$SERVICE_USER" -- env "PATH=$PATH" "HOME=$stage" "npm_config_cache=$stage/.npm-cache" \
    bash -c 'cd "$1" && npm install --omit=dev' bash "$stage"
  rm -rf -- "$stage/.npm" "$stage/.npm-cache"
else
  say "package.json en package-lock.json ongewijzigd; npm install overgeslagen."
  cp -a -- "$DEST/node_modules" "$stage/node_modules"
fi

say "Rechten zetten voor $SERVICE_USER."
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$stage"
chmod 750 "$stage"
chmod 600 "$stage/.env"

backup="$BACKUP_ROOT/$(date +%Y%m%dT%H%M%S)-$$"
say "Huidige versie bewaren in $backup."
mv -- "$DEST" "$backup"
if ! mv -- "$stage" "$DEST"; then
  mv -- "$backup" "$DEST" || true
  remove_tree "$stage"
  phase=init
  die "Plaatsen mislukt. De oude versie staat terug; de service is niet herstart."
fi
phase=live

say "Service $SERVICE herstarten."
if ! systemctl restart "$SERVICE"; then
  journal_hint
  exit 1
fi

say "/health op 127.0.0.1:${port}."
if ! wait_for_health; then
  say "Healthcheck gaf geen ok."
  journal_hint
  exit 1
fi
say "Healthcheck geslaagd."
printf '%s\n' "$health_body"

phase=done
prune_backups
say "Klaar. $SERVICE draait branch $BRANCH op $rev."
