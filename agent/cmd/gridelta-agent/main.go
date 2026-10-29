// gridelta-agent 는 원격 PC 에 설치되어 서버와 연결을 유지하며 요청을 실행한다.
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"os/user"
	"runtime"
	"syscall"

	grideltav1 "github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1"
	"github.com/Epsilondelta-ai/gridelta/agent/internal/conn"
	"github.com/Epsilondelta-ai/gridelta/agent/internal/exec"
)

// Version 은 빌드 시 -ldflags "-X main.Version=..." 로 덮어쓴다.
var Version = "0.1.0-dev"

func main() {
	// M1: 등록(enroll)과 설정 파일은 M2 에서 붙인다. 지금은 플래그/환경변수로 받는다.
	serverURL := flag.String("server", envOr("GRIDELTA_SERVER", "http://localhost:8443"), "server URL")
	agentID := flag.String("agent-id", os.Getenv("GRIDELTA_AGENT_ID"), "agent id")
	outputLimit := flag.Int("exec-output-limit", 1<<20, "exec stdout+stderr limit in bytes")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))

	hostname, _ := os.Hostname()
	if *agentID == "" {
		*agentID = hostname
	}
	home, _ := os.UserHomeDir()
	osUser := ""
	if u, err := user.Current(); err == nil {
		osUser = u.Username
	}

	client := conn.New(conn.Config{
		ServerURL:   *serverURL,
		Credential:  os.Getenv("GRIDELTA_CREDENTIAL"),
		OutputLimit: min(*outputLimit, 3<<20),
		Hello: &grideltav1.Hello{
			AgentId:      *agentID,
			Os:           runtime.GOOS,
			Arch:         runtime.GOARCH,
			Hostname:     hostname,
			AgentVersion: Version,
			HomeDir:      home,
			DefaultShell: exec.DefaultShell(),
			OsUser:       osUser,
		},
	}, logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger.Info("starting", "version", Version, "server", *serverURL, "agent_id", *agentID)
	client.Run(ctx)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
