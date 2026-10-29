#!/usr/bin/env bash
# docker 로 서버와 에이전트를 띄워 M1·M2 완료 기준을 확인한다.
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

fail() { echo "FAIL: $*" >&2; dc logs --tail 40 server >&2; exit 1; }
pass() { echo "PASS: $*"; }

# JSON 문자열 이스케이프, JSON 필드 추출 (jq 없이 node 로)
json_str() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=new Function("d","return ("+process.argv[1]+")")(JSON.parse(s));process.stdout.write(String(v))})' "$1"; }

list() { curl -sf -XPOST "$BASE/rpc/gridelta.v1.ConsoleService/ListEndpoints" -H 'content-type: application/json' -d '{}'; }
id_of() { list | jget "((d.endpoints||[]).find(e => e.hostname === '$1') || {}).id || ''"; }
is_online() { list 2>/dev/null | jget "(d.endpoints||[]).some(e => e.id === '$1' && e.online === true)" 2>/dev/null; }
is_offline() { [[ "$(is_online "$1")" == false ]] && echo true || echo false; }
exec_on() {
  curl -s -XPOST "$BASE/_debug/exec" -H 'content-type: application/json' \
    -d "{\"endpointId\":\"$1\",\"command\":$(json_str "$2"),\"timeoutMs\":${3:-10000}}"
}
wait_for() { # wait_for <설명> <초> <명령...>  명령이 "true" 를 출력할 때까지
  local desc=$1 secs=$2; shift 2
  for ((i = 0; i < secs * 2; i++)); do
    if [[ "$("$@" 2>/dev/null || true)" == true ]]; then return 0; fi
    sleep 0.5
  done
  fail "timed out waiting for: $desc"
}
healthy() { [[ "$(curl -sf "$BASE/healthz" 2>/dev/null)" == ok ]] && echo true || echo false; }
cli() { dc exec -T server gridelta "$@"; }
enroll_cmd() { cli enroll-token create --ttl 10m | grep -o 'gridelta-agent enroll .*'; }

echo "== TLS 인증서 생성 (자체 서명)"
mkdir -p .e2e/certs
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=gridelta-e2e \
  -addext subjectAltName=DNS:server -keyout .e2e/certs/server.key -out .e2e/certs/server.crt 2>/dev/null
chmod 644 .e2e/certs/server.key

echo "== build & start"
dc up -d --build >/dev/null 2>&1 || { dc up -d --build; exit 1; }
wait_for "server healthy" 60 healthy

echo "== M2: 계정·등록·인증"
out=$(echo 'correct-horse-battery' | cli user create admin --password-stdin)
[[ "$out" == *"계정을 만들었습니다"* ]] || fail "user create: $out"
if out=$(echo 'correct-horse-battery' | cli user create admin --password-stdin 2>&1); then fail "duplicate user accepted"; fi
[[ "$out" == *"already exists"* ]] || fail "duplicate user message: $out"
pass "CLI user create (argon2 저장, 중복 거부)"

cmd=$(enroll_cmd)
[[ "$cmd" == *"--ca-fingerprint "* ]] || fail "enroll command has no fingerprint: $cmd"
out=$(dc exec -T agent-debian sh -c "$cmd")
[[ "$out" == enrolled* ]] || fail "debian enroll: $out"
[[ "$(dc exec -T agent-debian stat -c %a /etc/gridelta/agent.yaml)" == 600 ]] || fail "config file mode is not 600"
pass "enroll-token create → gridelta-agent enroll (설정 파일 0600)"

dc exec -T agent-debian gridelta-agent install >/dev/null
dc exec -T agent-debian gridelta-agent start >/dev/null
[[ "$(dc exec -T agent-debian systemctl is-active gridelta-agent)" == active ]] || fail "systemd unit not active"
[[ "$(dc exec -T agent-debian systemctl is-enabled gridelta-agent)" == enabled ]] || fail "systemd unit not enabled"
DEBIAN=$(id_of agent-debian)
wait_for "agent-debian online" 30 is_online "$DEBIAN"
pass "systemd 서비스로 상주 (active, enabled) → 온라인 ($DEBIAN)"

if out=$(dc exec -T agent-alpine sh -c "$cmd" 2>&1); then fail "used token accepted on alpine"; fi
[[ "$out" == *"invalid, used or expired"* ]] || fail "reused token message: $out"
pass "사용한 등록 토큰 재사용 거부"

cmd2=$(enroll_cmd)
bad=$(sed -E 's/--ca-fingerprint [0-9a-f]+/--ca-fingerprint '"$(printf '0%.0s' {1..64})"'/' <<<"$cmd2")
if out=$(dc exec -T agent-alpine sh -c "$bad" 2>&1); then fail "wrong fingerprint accepted"; fi
[[ "$out" == *"does not match pinned CA fingerprint"* ]] || fail "wrong fingerprint message: $out"
pass "다른 인증서 지문이면 TLS 단계에서 거부 (중간자 방지)"

out=$(dc exec -T agent-alpine sh -c "$cmd2")
[[ "$out" == enrolled* ]] || fail "alpine enroll after failed attempt: $out"
dc exec -d agent-alpine gridelta-agent run
ALPINE=$(id_of agent-alpine)
wait_for "agent-alpine online" 30 is_online "$ALPINE"
pass "지문이 맞으면 같은 토큰으로 등록 성공 → 포그라운드 실행으로 온라인 ($ALPINE)"

dc exec -T agent-alpine sh -c "sed 's/^credential: .*/credential: forged/' /etc/gridelta/agent.yaml > /tmp/bad.yaml"
out=$(dc exec -T agent-alpine sh -c "timeout 5 gridelta-agent run --config /tmp/bad.yaml 2>&1 || true")
[[ "$out" == *"invalid or revoked agent credential"* ]] || fail "forged credential: $out"
pass "위조한 자격 증명으로는 연결 거부"

echo "== M1: TLS 위 왕복 exec"
out=$(exec_on "$DEBIAN" "uname -a")
[[ "$(jget 'd.exitCode' <<<"$out")" == 0 && "$(jget 'd.stdout' <<<"$out")" == Linux* ]] || fail "uname -a: $out"
pass "uname -a → $(jget 'd.stdout.trim()' <<<"$out")"

out=$(exec_on "$DEBIAN" "id -un")
[[ "$(jget 'd.stdout.trim()' <<<"$out")" == root ]] || fail "agent is not running as root: $out"
pass "에이전트가 root 로 실행됨"

out=$(exec_on "$ALPINE" "cat /etc/os-release")
[[ "$(jget 'd.stdout' <<<"$out")" == *Alpine* ]] || fail "alpine os-release: $out"
pass "alpine 에이전트에서 실행 (/bin/sh)"

out=$(exec_on "$DEBIAN" "echo oops >&2; exit 7")
[[ "$(jget 'd.exitCode' <<<"$out")" == 7 && "$(jget 'd.stderr' <<<"$out")" == "oops"* ]] || fail "exit code: $out"
pass "non-zero exit 코드와 stderr 전달"

start=$(date +%s)
out=$(exec_on "$DEBIAN" "sleep 30 & sleep 30" 500)
elapsed=$(($(date +%s) - start))
[[ "$(jget 'd.exitCode' <<<"$out")" == 124 && $elapsed -lt 6 ]] || fail "timeout (${elapsed}s): $out"
pass "타임아웃 → exit 124, 자식 프로세스까지 정리 (${elapsed}s)"

out=$(exec_on "$DEBIAN" "head -c 2000000 /dev/zero | tr '\\\\0' a")
[[ "$(jget 'd.truncated' <<<"$out")" == true && "$(jget 'd.stdout.length' <<<"$out")" == 1048576 ]] ||
  fail "truncation: $(jget 'd.truncated + " " + d.stdout.length' <<<"$out")"
pass "출력 상한 1 MiB에서 잘리고 truncated 표시"

code=$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/_debug/exec" -H 'content-type: application/json' -d '{"endpointId":"nope","command":"true"}')
[[ "$code" == 404 ]] || fail "unknown endpoint returned $code"
pass "연결되지 않은 PC → EndpointOfflineError"

echo "== 재연결"
# WatchEndpoints 서버 스트림을 HTTP/1.1 로 구독해 둔다 (Connect 스트리밍 envelope: flags 1B + length 4B)
printf '\x00\x00\x00\x00\x02{}' | curl -sN -m 90 -XPOST "$BASE/rpc/gridelta.v1.ConsoleService/WatchEndpoints" \
  -H 'content-type: application/connect+json' --data-binary @- >"$WORK/watch.bin" &
WATCH_PID=$!
sleep 1

dc exec -T agent-debian systemctl kill -s KILL gridelta-agent
wait_for "agent-debian offline after kill" 20 is_offline "$DEBIAN"
wait_for "agent-debian restarted by systemd" 30 is_online "$DEBIAN"
pass "에이전트 프로세스가 죽으면 systemd 가 다시 띄워 재연결"

sleep 1
events=$(grep -ao "$DEBIAN" "$WORK/watch.bin" | wc -l | tr -d ' ')
[[ $events -ge 3 ]] || fail "WatchEndpoints events for debian = $events, want >= 3 (initial, offline, online)"
pass "WatchEndpoints 스트림으로 초기 목록·오프라인·온라인 이벤트 수신 (${events}건)"

dc restart server >/dev/null 2>&1
wait_for "server healthy after restart" 60 healthy
wait_for "agent-debian reconnect after server restart" 60 is_online "$DEBIAN"
wait_for "agent-alpine reconnect after server restart" 60 is_online "$ALPINE"
out=$(exec_on "$ALPINE" "echo after-restart")
[[ "$(jget 'd.stdout.trim()' <<<"$out")" == after-restart ]] || fail "exec after server restart: $out"
pass "서버 재시작 → 등록 정보 유지, 에이전트가 백오프 후 재연결"

echo "== M2: 폐기"
cli endpoints revoke "$DEBIAN" >/dev/null
wait_for "agent-debian offline after revoke" 5 is_offline "$DEBIAN"
sleep 8
[[ "$(list | jget "(d.endpoints||[]).some(e => e.id === '$DEBIAN')")" == false ]] || fail "revoked endpoint still listed"
dc exec -T agent-debian journalctl -u gridelta-agent --no-pager | grep -q "invalid or revoked agent credential" ||
  fail "agent was not rejected after revoke"
pass "revoke → 즉시 끊기고 재접속 거부"

[[ "$(cli endpoints list --json | jget "d.length === 1 && d[0].id === '$ALPINE' && d[0].online")" == true ]] ||
  fail "CLI endpoints list: $(cli endpoints list --json)"
pass "CLI endpoints list"

echo "== all passed"
