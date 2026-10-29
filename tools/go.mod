module github.com/Epsilondelta-ai/gridelta/tools

go 1.26.0

tool (
	connectrpc.com/connect/v2/cmd/protoc-gen-connect-go
	google.golang.org/protobuf/cmd/protoc-gen-go
)

require (
	connectrpc.com/connect/v2 v2.0.2 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
)
