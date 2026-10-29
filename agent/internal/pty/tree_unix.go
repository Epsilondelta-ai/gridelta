//go:build !windows

package pty

import (
	"syscall"

	gopty "github.com/aymanbagabas/go-pty"
)

// unixTree: PTY 셸은 Setsid 로 자기 세션·프로세스 그룹의 리더가 되므로 그룹 전체를 끝낸다.
type unixTree struct{ cmd *gopty.Cmd }

func newProcTree(cmd *gopty.Cmd) procTree { return &unixTree{cmd: cmd} }

func (t *unixTree) started() error { return nil }

func (t *unixTree) kill() error {
	if err := syscall.Kill(-t.cmd.Process.Pid, syscall.SIGKILL); err != nil {
		return t.cmd.Process.Kill()
	}
	return nil
}

func (t *unixTree) release() {}
