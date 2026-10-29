// Package pty 는 웹 터미널용 PTY 세션을 관리한다.
// PTY 는 서버 연결이 아니라 에이전트 프로세스에 속하므로, 잠깐 끊겼다 다시 연결되어도 이어진다.
package pty

import (
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"sync"
	"time"

	gopty "github.com/aymanbagabas/go-pty"

	grideltav1 "github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1"
	"github.com/Epsilondelta-ai/gridelta/agent/internal/exec"
)

// chunkSize 만큼 모아 PtyOutput 하나로 보낸다.
const chunkSize = 32 << 10

// ErrNotFound 는 없는 세션에 대한 요청이다.
var ErrNotFound = errors.New("pty session not found")

// Sink 는 PTY 출력과 종료를 서버로 보낸다. 연결이 없으면 버린다.
type Sink interface {
	PtyOutput(sessionID string, data []byte)
	PtyExit(sessionID string, exitCode int)
}

type Manager struct {
	sink         Sink
	defaultShell string

	mu         sync.Mutex
	sessions   map[string]*session
	closeTimer *time.Timer
}

type session struct {
	pty gopty.Pty
	cmd *gopty.Cmd
}

func NewManager(sink Sink, defaultShell string) *Manager {
	return &Manager{sink: sink, defaultShell: defaultShell, sessions: map[string]*session{}}
}

// Open 은 로그인 셸을 PTY 에 붙여 띄운다.
func (m *Manager) Open(req *grideltav1.PtyOpenRequest) (int, error) {
	id := req.GetSessionId()
	m.mu.Lock()
	_, exists := m.sessions[id]
	m.mu.Unlock()
	if exists {
		return 0, fmt.Errorf("pty session %s already exists", id)
	}

	p, err := gopty.New()
	if err != nil {
		return 0, err
	}
	if err := p.Resize(int(max(req.GetCols(), 1)), int(max(req.GetRows(), 1))); err != nil {
		p.Close()
		return 0, err
	}

	shell := req.GetShell()
	if shell == "" {
		shell = m.defaultShell
	}
	var args []string
	if runtime.GOOS != "windows" {
		args = []string{"-l"}
	}
	cmd := p.Command(shell, args...)
	cmd.Env = exec.BuildEnv(map[string]string{"TERM": "xterm-256color", "COLORTERM": "truecolor"})
	cmd.Dir = req.GetCwd()
	if cmd.Dir == "" {
		cmd.Dir, _ = os.UserHomeDir()
	}
	if err := cmd.Start(); err != nil {
		p.Close()
		return 0, err
	}

	s := &session{pty: p, cmd: cmd}
	m.mu.Lock()
	m.sessions[id] = s
	m.mu.Unlock()

	go m.pump(id, s)
	return cmd.Process.Pid, nil
}

// pump 는 PTY 출력을 서버로 보내고, 셸이 끝나면 세션을 정리한다.
func (m *Manager) pump(id string, s *session) {
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buf := make([]byte, chunkSize)
		for {
			n, err := s.pty.Read(buf)
			if n > 0 {
				m.sink.PtyOutput(id, append([]byte(nil), buf[:n]...))
			}
			if err != nil {
				return
			}
		}
	}()

	code := 0
	if err := s.cmd.Wait(); err != nil {
		code = -1
		if st := s.cmd.ProcessState; st != nil {
			code = st.ExitCode()
		}
	}
	// 셸이 끝난 뒤 남은 출력을 잠깐 더 읽고 닫는다
	select {
	case <-readDone:
	case <-time.After(200 * time.Millisecond):
	}
	s.pty.Close()
	<-readDone

	m.mu.Lock()
	delete(m.sessions, id)
	m.mu.Unlock()
	m.sink.PtyExit(id, code)
}

// IDs 는 살아 있는 세션 id 목록이다. 재연결할 때 Hello 에 담아 보낸다.
func (m *Manager) IDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	return ids
}

func (m *Manager) get(id string) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	return s, nil
}

func (m *Manager) Input(id string, data []byte) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	_, err = s.pty.Write(data)
	return err
}

func (m *Manager) Resize(id string, cols, rows uint32) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	return s.pty.Resize(int(max(cols, 1)), int(max(rows, 1)))
}

// Close 는 셸을 끝낸다. 정리와 PtyExit 전송은 pump 가 한다.
func (m *Manager) Close(id string) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	return kill(s)
}

func kill(s *session) error {
	if s.cmd.Process == nil {
		return nil
	}
	err := s.cmd.Process.Kill()
	_ = s.pty.Close()
	if errors.Is(err, os.ErrProcessDone) || errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

// CloseAllAfter 는 서버 연결이 끊긴 뒤 d 안에 다시 연결되지 않으면 모든 세션을 닫는다.
func (m *Manager) CloseAllAfter(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closeTimer != nil {
		return
	}
	m.closeTimer = time.AfterFunc(d, func() {
		m.mu.Lock()
		sessions := make([]*session, 0, len(m.sessions))
		for _, s := range m.sessions {
			sessions = append(sessions, s)
		}
		m.closeTimer = nil
		m.mu.Unlock()
		for _, s := range sessions {
			_ = kill(s)
		}
	})
}

// CancelCloseAll 은 다시 연결되었을 때 예약된 정리를 취소한다.
func (m *Manager) CancelCloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closeTimer != nil {
		m.closeTimer.Stop()
		m.closeTimer = nil
	}
}
