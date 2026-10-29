//go:build windows

package exec

import (
	osexec "os/exec"
	"path/filepath"
	"strings"
)

func shellArgs(shell string, command string) []string {
	if strings.EqualFold(filepath.Base(shell), "cmd.exe") {
		return []string{"/C", command}
	}
	return []string{"-NoProfile", "-NonInteractive", "-Command", command}
}

// configureProcessTree: Job Object 로 자식 프로세스까지 정리하는 것은 M4 에서 구현한다.
func configureProcessTree(_ *osexec.Cmd) {}

// DefaultShell 은 OS 기본 셸을 고른다.
func DefaultShell() string {
	return "powershell.exe"
}
