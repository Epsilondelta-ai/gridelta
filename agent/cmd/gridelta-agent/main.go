// gridelta-agent 는 원격 PC 에 설치되어 서버와 연결을 유지하며 요청을 실행한다.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/user"
	"runtime"
	"time"

	"github.com/kardianos/service"

	grideltav1 "github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1"
	"github.com/Epsilondelta-ai/gridelta/agent/internal/config"
	"github.com/Epsilondelta-ai/gridelta/agent/internal/conn"
	"github.com/Epsilondelta-ai/gridelta/agent/internal/exec"
)

// Version 은 빌드 시 -ldflags "-X main.Version=..." 로 덮어쓴다.
var Version = "0.1.0-dev"

const usage = `usage: gridelta-agent <command> [flags]

commands:
  enroll     서버에 등록하고 설정 파일을 만든다
  run        포그라운드로 실행한다 (서비스 관리자가 쓰는 명령)
  install    OS 서비스로 등록한다 (root/관리자 권한 필요)
  uninstall  OS 서비스 등록을 해제한다
  start      서비스를 시작한다
  stop       서비스를 멈춘다
  status     서비스 상태를 출력한다
  version    버전을 출력한다
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "enroll":
		err = enroll(args)
	case "run":
		err = run(args)
	case "install", "uninstall", "start", "stop", "status":
		err = control(cmd, args)
	case "version":
		fmt.Println(Version)
	case "-h", "--help", "help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func enroll(args []string) error {
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	server := fs.String("server", "", "gateway URL (예: https://grid.example.com:8443)")
	token := fs.String("token", "", "등록 토큰 (`gridelta enroll-token create` 로 발급)")
	fingerprint := fs.String("ca-fingerprint", "", "자체 서명 인증서의 SHA-256 지문")
	configPath := fs.String("config", config.DefaultPath(), "설정 파일 경로")
	_ = fs.Parse(args)
	if *server == "" || *token == "" {
		return errors.New("--server and --token are required")
	}

	hostname, _ := os.Hostname()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := conn.NewGatewayClient(*server, *fingerprint).Enroll(ctx, &grideltav1.EnrollRequest{
		EnrollToken: *token,
		Hostname:    hostname,
		Os:          runtime.GOOS,
		Arch:        runtime.GOARCH,
	})
	if err != nil {
		return fmt.Errorf("enroll: %w", err)
	}
	cfg := &config.Config{
		ServerURL:     *server,
		AgentID:       res.GetAgentId(),
		Credential:    res.GetCredential(),
		CAFingerprint: conn.NormalizeFingerprint(*fingerprint),
	}
	if err := config.Save(*configPath, cfg); err != nil {
		return fmt.Errorf("save config: %w", err)
	}
	fmt.Printf("enrolled as %s; config written to %s\n", cfg.AgentID, *configPath)
	fmt.Println("next: gridelta-agent install && gridelta-agent start")
	return nil
}

// systemdUnit 은 kardianos/service 기본 유닛에서 재시작 대기(RestartSec=120 고정)를 5초로 줄이고
// 네트워크가 올라온 뒤 시작하게 한 것이다. kardianos 의 템플릿 문법을 쓴다.
const systemdUnit = `[Unit]
Description={{Description}}
ConditionFileIsExecutable={{Path | cmdEscape}}
After=network-online.target
Wants=network-online.target

[Service]
ExecStart={{Path | cmdEscape}}{{range Arguments}} {{. | cmd}}{{end}}
Restart=always
RestartSec=5
EnvironmentFile=-/etc/sysconfig/{{Name}}

[Install]
WantedBy=multi-user.target
`

// program 은 kardianos/service 가 시작·정지하는 본체다.
type program struct {
	configPath string
	cancel     context.CancelFunc
	done       chan struct{}
}

func (p *program) Start(service.Service) error {
	cfg, err := config.Load(p.configPath)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	p.done = make(chan struct{})
	go func() {
		defer close(p.done)
		newClient(cfg).Run(ctx)
	}()
	return nil
}

func (p *program) Stop(service.Service) error {
	if p.cancel != nil {
		p.cancel()
		select {
		case <-p.done:
		case <-time.After(5 * time.Second):
		}
	}
	return nil
}

func newService(configPath string) (service.Service, error) {
	return service.New(&program{configPath: configPath}, &service.Config{
		Name:        "gridelta-agent",
		DisplayName: "gridelta agent",
		Description: "gridelta remote management agent",
		Arguments:   []string{"run", "--config", configPath},
		Option: service.KeyValue{
			// macOS: LaunchDaemon(root), 계속 살아 있도록
			"KeepAlive": true,
			"RunAtLoad": true,
			// Windows: 실패하면 다시 시작
			"OnFailure": "restart",
			// Linux: systemd 시스템 유닛
			"SystemdScript": systemdUnit,
		},
	})
}

func run(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	configPath := fs.String("config", config.DefaultPath(), "설정 파일 경로")
	_ = fs.Parse(args)
	svc, err := newService(*configPath)
	if err != nil {
		return err
	}
	// 서비스 관리자에게서 실행되면 그쪽 수명 주기를, 터미널이면 Ctrl+C 까지 실행한다
	return svc.Run()
}

func control(action string, args []string) error {
	fs := flag.NewFlagSet(action, flag.ExitOnError)
	configPath := fs.String("config", config.DefaultPath(), "설정 파일 경로")
	_ = fs.Parse(args)
	if action == "install" {
		if _, err := config.Load(*configPath); err != nil {
			return err
		}
	}
	svc, err := newService(*configPath)
	if err != nil {
		return err
	}
	if action == "status" {
		st, err := svc.Status()
		if err != nil {
			return err
		}
		fmt.Println(map[service.Status]string{
			service.StatusRunning: "running",
			service.StatusStopped: "stopped",
		}[st])
		return nil
	}
	if err := service.Control(svc, action); err != nil {
		return err
	}
	fmt.Printf("%s: ok\n", action)
	return nil
}

func newClient(cfg *config.Config) *conn.Client {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	hostname, _ := os.Hostname()
	home, _ := os.UserHomeDir()
	osUser := ""
	if u, err := user.Current(); err == nil {
		osUser = u.Username
	}
	shell := cfg.Shell
	if shell == "" {
		shell = exec.DefaultShell()
	}
	logger.Info("starting", "version", Version, "server", cfg.ServerURL, "agent_id", cfg.AgentID)
	return conn.New(conn.Config{
		ServerURL:     cfg.ServerURL,
		CAFingerprint: cfg.CAFingerprint,
		Credential:    cfg.Credential,
		OutputLimit:   cfg.ExecOutputLimit,
		Hello: &grideltav1.Hello{
			AgentId:      cfg.AgentID,
			Os:           runtime.GOOS,
			Arch:         runtime.GOARCH,
			Hostname:     hostname,
			AgentVersion: Version,
			HomeDir:      home,
			DefaultShell: shell,
			OsUser:       osUser,
		},
	}, logger)
}
