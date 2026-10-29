#!/usr/bin/env bash
# 직접 써 볼 수 있게 서버와 리눅스 에이전트 2대를 띄운다 (웹 로그인 없음, 실제 OpenAI 모델).
#   ./docker/up.sh        띄우기
#   ./docker/up.sh down   내리기 (데이터도 지움)
set -euo pipefail
cd "$(dirname "$0")"
export GRIDELTA_WEB_AUTH=off GRIDELTA_AI_FAUX=0 GRIDELTA_E2E_PORT=${GRIDELTA_PORT:-3900}
dc() { docker compose -p gridelta-local -f compose.yaml "$@"; }

if [[ "${1:-}" == down ]]; then
  dc down -v --remove-orphans
  exit 0
fi

mkdir -p .e2e/certs
if [[ ! -f .e2e/certs/server.crt ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=gridelta-local \
    -addext subjectAltName=DNS:server -keyout .e2e/certs/server.key -out .e2e/certs/server.crt 2>/dev/null
  chmod 644 .e2e/certs/server.key
fi

dc up -d --build server agent-debian agent-alpine
echo -n "서버 기다리는 중"
until [[ "$(curl -sf "http://127.0.0.1:$GRIDELTA_E2E_PORT/healthz" 2>/dev/null)" == ok ]]; do echo -n .; sleep 1; done
echo

enroll() { # enroll <service>
  if ! dc exec -T "$1" test -f /etc/gridelta/agent.yaml; then
    cmd=$(dc exec -T server gridelta enroll-token create --ttl 10m | grep -o 'gridelta-agent enroll .*')
    dc exec -T "$1" sh -c "$cmd" >/dev/null
  fi
}
enroll agent-debian
dc exec -T agent-debian sh -c 'gridelta-agent install >/dev/null 2>&1 || true; gridelta-agent start >/dev/null 2>&1 || true'
enroll agent-alpine
dc exec -T agent-alpine pgrep -f "gridelta-agent run" >/dev/null || dc exec -d agent-alpine gridelta-agent run

cat <<MSG

gridelta 가 떠 있습니다: http://127.0.0.1:$GRIDELTA_E2E_PORT  (웹 로그인 없음)

AI 를 쓰려면 OpenAI 에 로그인하세요:
  docker compose -p gridelta-local -f docker/compose.yaml exec server gridelta login openai
상태 확인:
  docker compose -p gridelta-local -f docker/compose.yaml exec server gridelta auth status
내리기:
  ./docker/up.sh down
MSG
