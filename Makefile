BUF_VERSION := v1.75.0
BIN := $(CURDIR)/bin

.PHONY: generate lint-proto plugins agent agents test-e2e

# protoc 플러그인: Go 는 tools/go.mod 에 고정한 버전, TS 는 루트 node_modules
plugins:
	@mkdir -p $(BIN)
	cd tools && go build -o $(BIN)/protoc-gen-go google.golang.org/protobuf/cmd/protoc-gen-go
	cd tools && go build -o $(BIN)/protoc-gen-connect-go connectrpc.com/connect/v2/cmd/protoc-gen-connect-go

generate: plugins
	PATH="$(BIN):$(CURDIR)/node_modules/.bin:$$PATH" go run github.com/bufbuild/buf/cmd/buf@$(BUF_VERSION) generate

lint-proto:
	go run github.com/bufbuild/buf/cmd/buf@$(BUF_VERSION) lint

agent:
	cd agent && go build -o $(BIN)/gridelta-agent ./cmd/gridelta-agent

# 1차 배포 대상 전부 크로스 컴파일 (bin/gridelta-agent-<os>-<arch>)
AGENT_TARGETS := darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64
agents:
	@for t in $(AGENT_TARGETS); do \
		os=$${t%/*}; arch=$${t#*/}; ext=$$([ $$os = windows ] && echo .exe); \
		echo "build $$os/$$arch"; \
		(cd agent && CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -o $(BIN)/gridelta-agent-$$os-$$arch$$ext ./cmd/gridelta-agent) || exit 1; \
	done

# docker 로 서버와 에이전트를 띄워 실제 동작을 확인한다
test-e2e:
	./docker/e2e.sh
