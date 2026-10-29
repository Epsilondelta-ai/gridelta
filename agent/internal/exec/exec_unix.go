//go:build !windows

package exec

import (
	"os"
	osexec "os/exec"
	"syscall"
	"time"
)

const killGrace = 2 * time.Second

func shellArgs(_ string, command string) []string {
	return []string{"-lc", command}
}

// configureProcessTree 는 명령을 새 프로세스 그룹으로 띄우고, 취소 시 그룹 전체에
// SIGTERM → 2초 후 SIGKILL 을 보낸다.
func configureProcessTree(cmd *osexec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		pgid := -cmd.Process.Pid
		_ = syscall.Kill(pgid, syscall.SIGTERM)
		time.AfterFunc(killGrace, func() { _ = syscall.Kill(pgid, syscall.SIGKILL) })
		return nil
	}
	// 손자 프로세스가 파이프를 쥐고 있어도 Wait 가 멈추지 않게 한다
	cmd.WaitDelay = killGrace + time.Second
}

// DefaultShell 은 OS 기본 셸을 고른다.
func DefaultShell() string {
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	for _, s := range []string{"/bin/bash", "/bin/sh"} {
		if _, err := os.Stat(s); err == nil {
			return s
		}
	}
	return "/bin/sh"
}
