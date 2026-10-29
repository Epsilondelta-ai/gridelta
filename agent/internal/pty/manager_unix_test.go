//go:build !windows

package pty

import (
	"strings"
	"sync"
	"testing"
	"time"

	grideltav1 "github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1"
)

type fakeSink struct {
	mu   sync.Mutex
	out  strings.Builder
	exit chan int
}

func (f *fakeSink) PtyOutput(_ string, data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.out.Write(data)
}

func (f *fakeSink) PtyExit(_ string, code int) { f.exit <- code }

func (f *fakeSink) output() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.out.String()
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestShellRoundTrip(t *testing.T) {
	sink := &fakeSink{exit: make(chan int, 1)}
	m := NewManager(sink, "/bin/sh")
	if _, err := m.Open(&grideltav1.PtyOpenRequest{SessionId: "s1", Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	if err := m.Input("s1", []byte("stty size; echo ping-$((40+2))\n")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return strings.Contains(sink.output(), "ping-42") })
	if !strings.Contains(sink.output(), "24 80") {
		t.Errorf("terminal size not applied: %q", sink.output())
	}

	if err := m.Resize("s1", 100, 30); err != nil {
		t.Fatal(err)
	}
	_ = m.Input("s1", []byte("stty size\n"))
	waitFor(t, func() bool { return strings.Contains(sink.output(), "30 100") })

	_ = m.Input("s1", []byte("exit 3\n"))
	select {
	case code := <-sink.exit:
		if code != 3 {
			t.Errorf("exit code = %d, want 3", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no exit")
	}
	if err := m.Input("s1", []byte("x")); err != ErrNotFound {
		t.Errorf("input after exit: err = %v, want ErrNotFound", err)
	}
}

func TestCloseKillsShell(t *testing.T) {
	sink := &fakeSink{exit: make(chan int, 1)}
	m := NewManager(sink, "/bin/sh")
	if _, err := m.Open(&grideltav1.PtyOpenRequest{SessionId: "s1", Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	if err := m.Close("s1"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-sink.exit:
	case <-time.After(5 * time.Second):
		t.Fatal("no exit after Close")
	}
}
