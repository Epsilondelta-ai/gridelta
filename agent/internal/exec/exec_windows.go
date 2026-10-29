//go:build windows

package exec

import (
	osexec "os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/Epsilondelta-ai/gridelta/agent/internal/winjob"
)

func shellArgs(shell string, command string) []string {
	if strings.EqualFold(filepath.Base(shell), "cmd.exe") {
		return []string{"/C", command}
	}
	return []string{"-NoProfile", "-NonInteractive", "-Command", command}
}

// windowsTree 는 명령을 Job Object 에 넣어, 취소·타임아웃 시 자식 프로세스까지 함께 끝낸다.
type windowsTree struct {
	cmd *osexec.Cmd
	job *winjob.Job
}

func configureProcessTree(cmd *osexec.Cmd) processTree {
	t := &windowsTree{cmd: cmd}
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: winjob.CreationFlags}
	cmd.Cancel = func() error {
		if t.job != nil {
			return t.job.Terminate(1)
		}
		return cmd.Process.Kill()
	}
	return t
}

func (t *windowsTree) started() error {
	job, err := winjob.New()
	if err != nil {
		_ = t.cmd.Process.Kill()
		return err
	}
	if err := job.AssignAndResume(t.cmd.Process.Pid); err != nil {
		_ = t.cmd.Process.Kill()
		job.Close()
		return err
	}
	t.job = job
	return nil
}

// release 는 Job 핸들을 닫는다. KILL_ON_JOB_CLOSE 라 남은 손자 프로세스도 이때 정리된다.
func (t *windowsTree) release() {
	if t.job != nil {
		t.job.Close()
	}
}

// DefaultShell 은 OS 기본 셸을 고른다.
func DefaultShell() string {
	return "powershell.exe"
}
