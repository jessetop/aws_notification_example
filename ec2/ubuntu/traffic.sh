#!/usr/bin/env bash
# Traffic generator for the demo PHP app (Ubuntu).
# Normal requests run continuously; every QUIET_SECONDS a BURST of one problem
# kind is sent (CVE-style probes, failed logins, or requests that crash PHP).
# Everything lands in the real Apache access log and PHP error log, which the
# CloudWatch Agent ships to the fleet log groups.
set -u

BASE="${BASE_URL:-http://127.0.0.1}"
BURST_LINES="${BURST_LINES:-8}"        # requests per burst (default rule thresholds are 3-5)
BURST_INTERVAL="${BURST_INTERVAL:-5}"  # seconds between burst requests
QUIET_SECONDS="${QUIET_SECONDS:-900}"  # normal traffic between bursts
NORMAL_INTERVAL="${NORMAL_INTERVAL:-10}"

PROBES=("/cgi-bin/php-cgi?%ADd+allow_url_include%3D1+%ADd+auto_prepend_file%3Dphp://input"
        "/wp-login.php"
        "/.env"
        "/index.php?file=../../../../etc/passwd"
        "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php")
USERS=(admin clerk01 permits svc_backup jdoe)

pick() { local arr=("$@"); echo "${arr[RANDOM % ${#arr[@]}]}"; }
rand_ip() { echo "203.0.113.$((RANDOM % 254 + 1))"; }
req() { curl -s -o /dev/null --max-time 5 --path-as-is "$@" || true; }

normal() {
  case $((RANDOM % 4)) in
    0|1) req "$BASE/" ;;
    2) req "$BASE/permits.php?id=$((RANDOM % 500 + 1))" ;;
    3) req "$BASE/report.php" ;;
  esac
}
probe()    { req -A "Mozilla/5.0 zgrab/0.x" "$BASE$(pick "${PROBES[@]}")"; }
authfail() { req -X POST -H "X-Forwarded-For: $(rand_ip)" --data "user=$(pick "${USERS[@]}")&pass=wrong" "$BASE/login.php"; }
apperror() { if ((RANDOM % 2)); then req "$BASE/permits.php?id=abc"; else req "$BASE/permits.php?id=db"; fi; }

# Give Apache a moment on first boot.
sleep 30
while true; do
  kind="$(pick probe authfail apperror)"
  for ((i = 0; i < BURST_LINES; i++)); do
    "$kind"
    sleep "$BURST_INTERVAL"
  done
  end=$((SECONDS + QUIET_SECONDS))
  while ((SECONDS < end)); do
    normal
    sleep "$NORMAL_INTERVAL"
  done
done
