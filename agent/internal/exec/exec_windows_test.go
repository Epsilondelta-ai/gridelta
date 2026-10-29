//go:build windows

package exec

import (
	"context"
	"strings"
	"testing"
	"time"

	grideltav1 "github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1"
)

// Windows PC 에서 `go test ./...` 로 확인한다 (설계 M4).

func TestPowerShellOutputAndExitCode(t *testing.T) {
	res, err := Run(context.Background(), &grideltav1.ExecRequest{Command: "Write-Output out; [Console]::Error.WriteLine('err'); exit 3"}, DefaultShell(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(res.GetStdout()), "out") || !strings.Contains(string(res.GetStderr()), "err") {
		t.Errorf("stdout=%q stderr=%q", res.GetStdout(), res.GetStderr())
	}
	if res.GetExitCode() != 3 {
		t.Errorf("exit code = %d, want 3", res.GetExitCode())
	}
}

func TestCmdExe(t *testing.T) {
	res, err := Run(context.Background(), &grideltav1.ExecRequest{Command: "echo hi & exit /b 2", Shell: "cmd.exe"}, DefaultShell(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(res.GetStdout()), "hi") || res.GetExitCode() != 2 {
		t.Errorf("stdout=%q exit=%d", res.GetStdout(), res.GetExitCode())
	}
}

func TestTimeoutKillsChildTree(t *testing.T) {
	start := time.Now()
	// 자식 프로세스(ping)가 남아 있어도 Job Object 로 함께 끝나야 한다
	res, err := Run(context.Background(), &grideltav1.ExecRequest{
		Command:   "Start-Process -NoNewWindow ping -ArgumentList '-n','60','127.0.0.1'; Start-Sleep 60",
		TimeoutMs: 500,
	}, DefaultShell(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if res.GetExitCode() != TimeoutExitCode {
		t.Errorf("exit code = %d, want %d", res.GetExitCode(), TimeoutExitCode)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Errorf("took %s, child processes were not killed", elapsed)
	}
}
