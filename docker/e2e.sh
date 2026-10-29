#!/usr/bin/env bash
# docker 로 서버와 에이전트를 띄워 M1 완료 기준을 확인한다.
# KEEP=1 이면 끝난 뒤에도 컨테이너를 남겨 둔다.
set -euo pipefail
cd "$(dirname "$0")"

PORT=${GRIDELTA_E2E_PORT:-3900}
BASE="http://127.0.0.1:$PORT"
WORK=$(mktemp -d)

dc() { docker compose -f compose.yaml "$@"; }
cleanup() {
  [[ -n "${WATCH_PID:-}" ]] && kill "$WATCH_PID" 2>/dev/null || true
  [[ "${KEEP:-}" == 1 ]] || dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; dc logs --tail 40 >&2; exit 1; }
pass() { echo "PASS: $*"; }

# JSON 문자열 이스케이프, JSON 필드 추출 (jq 없이 node 로)
json_str() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=new Function("d","return ("+process.argv[1]+")")(JSON.parse(s));process.stdout.write(String(v))})' "$1"; }

list() {
  curl -sf -XPOST "$BASE/rpc/gridelta.v1.ConsoleService/ListEndpoints" -H 'content-type: application/json' -d '{}'
}
is_online() { list 2>/dev/null | jget "(d.endpoints||[]).some(e => e.id === '$1' && e.online === true)" 2>/dev/null; }
exec_on() {
  curl -s -XPOST "$BASE/_debug/exec" -H 'content-type: application/json' \
    -d "{\"endpointId\":\"$1\",\"command\":$(json_str "$2"),\"timeoutMs\":${3:-10000}}"
}
wait_for() { # wait_for <설명> <초> <명령...>
  local desc=$1 secs=$2; shift 2
  for ((i = 0; i < secs * 2; i++)); do
    if [[ "$("$@" 2>/dev/null || true)" == true ]]; then return 0; fi
    sleep 0.5
  done
  fail "timed out waiting for: $desc"
}
is_offline() { [[ "$(is_online "$1")" == false ]] && echo true || echo false; }

echo "== build & start"
dc up -d --build --wait-timeout 120 >/dev/null

echo "== tests"
wait_for "e2e-debian online" 60 is_online e2e-debian
wait_for "e2e-alpine online" 60 is_online e2e-alpine
pass "두 에이전트가 서버에 연결됨"

out=$(exec_on e2e-debian "uname -a")
[[ "$(jget 'd.exitCode' <<<"$out")" == 0 && "$(jget 'd.stdout' <<<"$out")" == Linux* ]] || fail "uname -a: $out"
pass "uname -a → $(jget 'd.stdout.trim()' <<<"$out")"

out=$(exec_on e2e-alpine "cat /etc/os-release")
[[ "$(jget 'd.stdout' <<<"$out")" == *Alpine* ]] || fail "alpine os-release: $out"
pass "alpine 에이전트에서 실행 (/bin/sh)"

out=$(exec_on e2e-debian "echo oops >&2; exit 7")
[[ "$(jget 'd.exitCode' <<<"$out")" == 7 && "$(jget 'd.stderr' <<<"$out")" == "oops"* ]] || fail "exit code: $out"
pass "non-zero exit 코드와 stderr 전달"

start=$(date +%s)
out=$(exec_on e2e-debian "sleep 30 & sleep 30" 500)
elapsed=$(($(date +%s) - start))
[[ "$(jget 'd.exitCode' <<<"$out")" == 124 && $elapsed -lt 6 ]] || fail "timeout (${elapsed}s): $out"
pass "타임아웃 → exit 124, 자식 프로세스까지 정리 (${elapsed}s)"

out=$(exec_on e2e-debian "head -c 2000000 /dev/zero | tr '\\\\0' a")
[[ "$(jget 'd.truncated' <<<"$out")" == true && "$(jget 'd.stdout.length' <<<"$out")" == 1048576 ]] ||
  fail "truncation: $(jget 'd.truncated + " " + d.stdout.length' <<<"$out")"
pass "출력 상한 1 MiB에서 잘리고 truncated 표시"

code=$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/_debug/exec" -H 'content-type: application/json' -d '{"endpointId":"nope","command":"true"}')
[[ "$code" == 404 ]] || fail "unknown endpoint returned $code"
pass "연결되지 않은 PC → EndpointOfflineError"

# WatchEndpoints 서버 스트림을 HTTP/1.1 로 구독해 둔다 (Connect 스트리밍 envelope: flags 1B + length 4B)
printf '\x00\x00\x00\x00\x02{}' | curl -sN -m 60 -XPOST "$BASE/rpc/gridelta.v1.ConsoleService/WatchEndpoints" \
  -H 'content-type: application/connect+json' --data-binary @- >"$WORK/watch.bin" &
WATCH_PID=$!
sleep 1

dc kill agent-debian >/dev/null 2>&1
wait_for "e2e-debian offline" 20 is_offline e2e-debian
pass "에이전트 종료 → 오프라인 처리"

dc start agent-debian >/dev/null 2>&1
wait_for "e2e-debian back online" 30 is_online e2e-debian
pass "에이전트 재시작 → 자동 재연결"

sleep 1
events=$(grep -ao 'e2e-debian' "$WORK/watch.bin" | wc -l | tr -d ' ')
[[ $events -ge 3 ]] || fail "WatchEndpoints events for e2e-debian = $events, want >= 3 (initial, offline, online)"
pass "WatchEndpoints 스트림으로 초기 목록·오프라인·온라인 이벤트 수신 (${events}건)"

dc restart server >/dev/null 2>&1
wait_for "e2e-debian reconnect after server restart" 60 is_online e2e-debian
wait_for "e2e-alpine reconnect after server restart" 60 is_online e2e-alpine
out=$(exec_on e2e-alpine "echo after-restart")
[[ "$(jget 'd.stdout.trim()' <<<"$out")" == after-restart ]] || fail "exec after server restart: $out"
pass "서버 재시작 → 에이전트가 백오프 후 재연결하고 다시 실행됨"

echo "== all passed"
