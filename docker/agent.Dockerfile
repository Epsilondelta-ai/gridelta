# 테스트용 에이전트 이미지. 바이너리만 넣고, 등록·실행은 e2e 스크립트가 컨테이너 안에서 한다.
#   기본(alpine): 서비스 관리자 없이 `gridelta-agent run` 을 직접 띄운다
#   --target systemd: systemd 가 PID 1 인 debian. `gridelta-agent install/start` 로 서비스 등록을 확인한다

FROM golang:1.27 AS build
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent .
RUN CGO_ENABLED=0 go build -o /out/gridelta-agent ./cmd/gridelta-agent

FROM debian:trixie-slim AS systemd
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv procps \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/gridelta-agent /usr/local/bin/gridelta-agent
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

FROM alpine:3.22 AS plain
COPY --from=build /out/gridelta-agent /usr/local/bin/gridelta-agent
CMD ["sleep", "infinity"]
