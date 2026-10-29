BUF_VERSION := v1.75.0
BIN := $(CURDIR)/bin

.PHONY: generate lint-proto plugins agent test-e2e

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

# docker 로 서버와 에이전트를 띄워 실제 동작을 확인한다
test-e2e:
	./docker/e2e.sh
