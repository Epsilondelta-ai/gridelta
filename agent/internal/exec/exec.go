// Package exec 는 단발 셸 명령을 실행한다.
package exec

import (
	"bytes"
	"context"
	"errors"
	"os"
	osexec "os/exec"
	"sync"
	"time"

	grideltav1 "github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1"
)

// TimeoutExitCode 는 timeout_ms 를 넘겨 강제 종료된 명령의 종료 코드다.
const TimeoutExitCode = 124

// ErrCanceled 는 CancelRequest 로 취소된 경우 돌려준다.
var ErrCanceled = errors.New("canceled")

// Run 은 명령을 실행하고 결과를 돌려준다. 명령의 non-zero exit 는 에러가 아니다.
// ctx 가 취소되면 프로세스 트리를 정리하고 ErrCanceled 를 돌려준다.
func Run(ctx context.Context, req *grideltav1.ExecRequest, defaultShell string, outputLimit int) (*grideltav1.ExecResult, error) {
	shell := req.GetShell()
	if shell == "" {
		shell = defaultShell
	}

	runCtx := ctx
	if ms := req.GetTimeoutMs(); ms > 0 {
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(ctx, time.Duration(ms)*time.Millisecond)
		defer cancel()
	}

	cmd := osexec.CommandContext(runCtx, shell, shellArgs(shell, req.GetCommand())...)
	cmd.Dir = req.GetCwd()
	cmd.Env = BuildEnv(req.GetEnv())
	configureProcessTree(cmd)

	out := &limitedOutput{limit: outputLimit}
	cmd.Stdout = out.writer(&out.stdout)
	cmd.Stderr = out.writer(&out.stderr)

	err := cmd.Run()
	res := &grideltav1.ExecResult{Stdout: out.stdout.Bytes(), Stderr: out.stderr.Bytes(), Truncated: out.truncated}

	switch {
	case ctx.Err() != nil:
		return nil, ErrCanceled
	case runCtx.Err() != nil:
		res.ExitCode = TimeoutExitCode
		return res, nil
	}

	var exitErr *osexec.ExitError
	switch {
	case err == nil:
		res.ExitCode = 0
	case errors.As(err, &exitErr):
		res.ExitCode = int32(exitErr.ExitCode())
	default:
		// 셸 실행 자체가 실패한 경우 (셸 없음, cwd 없음 등)
		return nil, err
	}
	return res, nil
}

// BuildEnv 는 에이전트 환경을 상속하되 자격 증명 관련 변수는 제거하고, 요청의 env 를 덮어쓴다.
func BuildEnv(extra map[string]string) []string {
	env := make([]string, 0, len(os.Environ())+len(extra))
	for _, kv := range os.Environ() {
		if isSecretEnv(kv) {
			continue
		}
		env = append(env, kv)
	}
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return env
}

func isSecretEnv(kv string) bool {
	for _, prefix := range []string{"GRIDELTA_CREDENTIAL=", "GRIDELTA_ENROLL_TOKEN="} {
		if len(kv) >= len(prefix) && kv[:len(prefix)] == prefix {
			return true
		}
	}
	return false
}

// limitedOutput 은 stdout 과 stderr 를 합쳐 limit 바이트까지만 담는다.
type limitedOutput struct {
	mu        sync.Mutex
	limit     int
	used      int
	truncated bool
	stdout    bytes.Buffer
	stderr    bytes.Buffer
}

type limitedWriter struct {
	o   *limitedOutput
	buf *bytes.Buffer
}

func (o *limitedOutput) writer(buf *bytes.Buffer) *limitedWriter {
	return &limitedWriter{o: o, buf: buf}
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	w.o.mu.Lock()
	defer w.o.mu.Unlock()
	room := w.o.limit - w.o.used
	if room <= 0 {
		w.o.truncated = true
		return len(p), nil
	}
	n := min(len(p), room)
	w.buf.Write(p[:n])
	w.o.used += n
	if n < len(p) {
		w.o.truncated = true
	}
	// 넘친 부분은 버리되 프로세스가 막히지 않도록 다 쓴 것으로 응답한다
	return len(p), nil
}
