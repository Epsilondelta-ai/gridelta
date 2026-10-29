//go:build windows

package pty

import (
	"syscall"

	gopty "github.com/aymanbagabas/go-pty"

	"github.com/Epsilondelta-ai/gridelta/agent/internal/winjob"
)

// windowsTree: ConPTY 셸과 그 자식을 Job Object 로 묶는다 (go-pty 는 자식 프로세스를 정리하지 않는다).
type windowsTree struct {
	cmd *gopty.Cmd
	job *winjob.Job
}

func newProcTree(cmd *gopty.Cmd) procTree {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= winjob.CreationFlags
	return &windowsTree{cmd: cmd}
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

func (t *windowsTree) kill() error {
	if t.job != nil {
		return t.job.Terminate(1)
	}
	return t.cmd.Process.Kill()
}

func (t *windowsTree) release() {
	if t.job != nil {
		t.job.Close()
	}
}
