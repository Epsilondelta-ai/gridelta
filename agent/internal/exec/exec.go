// Package exec 는 단발 셸 명령을 실행한다.
package exec

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"sync"
	"time"

	grideltav1 "github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1"
	"github.com/Epsilondelta-ai/gridelta/agent/internal/paths"
)

// TimeoutExitCode 는 timeout_ms 를 넘겨 강제 종료된 명령의 종료 코드다.
const TimeoutExitCode = 124

// ErrCanceled 는 CancelRequest 로 취소된 경우 돌려준다.
var ErrCanceled = errors.New("canceled")

// processTree 는 OS 별로 명령과 그 자식 프로세스를 함께 정리하는 방법이다.
type processTree interface {
	// started 는 프로세스가 시작된 직후 호출한다 (Windows: Job 에 넣고 재개).
	started() error
	// release 는 Wait 가 끝난 뒤 호출한다.
	release()
}

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
	if cwd := req.GetCwd(); cwd != "" {
		dir, err := paths.Native(cwd)
		if err != nil {
			return nil, fmt.Errorf("cwd %q: %w", cwd, err)
		}
		cmd.Dir = dir
	}
	cmd.Env = BuildEnv(req.GetEnv())
	tree := configureProcessTree(cmd)
	defer tree.release()

	out := &limitedOutput{limit: outputLimit}
	cmd.Stdout = out.writer(&out.stdout)
	cmd.Stderr = out.writer(&out.stderr)

	if err := cmd.Start(); err != nil {
		// 셸 실행 자체가 실패한 경우 (셸 없음, cwd 없음 등)
		return nil, err
	}
	if err := tree.started(); err != nil {
		_ = cmd.Wait()
		return nil, err
	}
	err := cmd.Wait()
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
