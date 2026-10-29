//go:build windows

package pty

import (
	"strings"
	"sync"
	"testing"
	"time"

	grideltav1 "github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1"
)

// Windows PC 에서 `go test ./...` 로 확인한다. 서비스(LocalSystem, session 0)에서의
// 동작은 설치 후 웹 터미널로 따로 확인해야 한다.

type sink struct {
	mu   sync.Mutex
	out  strings.Builder
	exit chan int
}

func (s *sink) PtyOutput(_ string, d []byte) { s.mu.Lock(); s.out.Write(d); s.mu.Unlock() }
func (s *sink) PtyExit(_ string, c int)      { s.exit <- c }
func (s *sink) text() string                 { s.mu.Lock(); defer s.mu.Unlock(); return s.out.String() }

func TestConPTYRoundTrip(t *testing.T) {
	s := &sink{exit: make(chan int, 1)}
	m := NewManager(s, "powershell.exe")
	if _, err := m.Open(&grideltav1.PtyOpenRequest{SessionId: "s1", Cols: 100, Rows: 30}); err != nil {
		t.Fatal(err)
	}
	_ = m.Input("s1", []byte("Write-Output (\"ping-\" + (40+2))\r"))
	deadline := time.Now().Add(15 * time.Second)
	for !strings.Contains(s.text(), "ping-42") {
		if time.Now().After(deadline) {
			t.Fatalf("no output: %q", s.text())
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := m.Close("s1"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-s.exit:
	case <-time.After(10 * time.Second):
		t.Fatal("no exit after Close")
	}
}
