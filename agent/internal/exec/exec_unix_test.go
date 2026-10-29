//go:build !windows

package exec

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	grideltav1 "github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1"
)

func run(t *testing.T, ctx context.Context, req *grideltav1.ExecRequest, limit int) (*grideltav1.ExecResult, error) {
	t.Helper()
	return Run(ctx, req, "/bin/sh", limit)
}

func TestRunCapturesOutputAndExitCode(t *testing.T) {
	res, err := run(t, context.Background(), &grideltav1.ExecRequest{Command: "echo out; echo err >&2; exit 3"}, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(res.GetStdout()); got != "out\n" {
		t.Errorf("stdout = %q", got)
	}
	if got := string(res.GetStderr()); got != "err\n" {
		t.Errorf("stderr = %q", got)
	}
	if res.GetExitCode() != 3 {
		t.Errorf("exit code = %d, want 3", res.GetExitCode())
	}
}

func TestRunTruncatesCombinedOutput(t *testing.T) {
	res, err := run(t, context.Background(), &grideltav1.ExecRequest{Command: "head -c 5000 /dev/zero; head -c 5000 /dev/zero >&2"}, 6000)
	if err != nil {
		t.Fatal(err)
	}
	if total := len(res.GetStdout()) + len(res.GetStderr()); total != 6000 {
		t.Errorf("combined output = %d bytes, want 6000", total)
	}
	if !res.GetTruncated() {
		t.Error("truncated = false, want true")
	}
}

func TestRunTimeoutReturns124AndKillsChildren(t *testing.T) {
	start := time.Now()
	// 자식 프로세스(sleep)가 파이프를 쥐고 있어도 그룹 종료로 빠르게 끝나야 한다
	res, err := run(t, context.Background(), &grideltav1.ExecRequest{Command: "sleep 30 & sleep 30", TimeoutMs: 200}, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if res.GetExitCode() != TimeoutExitCode {
		t.Errorf("exit code = %d, want %d", res.GetExitCode(), TimeoutExitCode)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("took %s, child processes were not killed", elapsed)
	}
}

func TestRunCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(100*time.Millisecond, cancel)
	_, err := run(t, ctx, &grideltav1.ExecRequest{Command: "sleep 30"}, 1<<20)
	if !errors.Is(err, ErrCanceled) {
		t.Fatalf("err = %v, want ErrCanceled", err)
	}
}

func TestRunStripsSecretEnv(t *testing.T) {
	t.Setenv("GRIDELTA_CREDENTIAL", "secret")
	res, err := run(t, context.Background(), &grideltav1.ExecRequest{Command: "env", Env: map[string]string{"FOO": "bar"}}, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	out := string(res.GetStdout())
	if strings.Contains(out, "GRIDELTA_CREDENTIAL") {
		t.Error("credential leaked into exec environment")
	}
	if !strings.Contains(out, "FOO=bar") {
		t.Error("request env not applied")
	}
}
