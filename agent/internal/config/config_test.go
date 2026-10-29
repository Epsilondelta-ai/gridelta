package config

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSaveLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "agent.yaml")
	want := &Config{ServerURL: "https://s:8443", AgentID: "id", Credential: "secret", CAFingerprint: "ab"}
	if err := Save(path, want); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		st, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o600 {
			t.Errorf("mode = %o, want 600", st.Mode().Perm())
		}
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Credential != "secret" || got.CAFingerprint != "ab" || got.ExecOutputLimit != DefaultExecOutputLimit {
		t.Errorf("got %+v", got)
	}
}

func TestLoadMissingIsNotEnrolled(t *testing.T) {
	_, err := Load(filepath.Join(t.TempDir(), "nope.yaml"))
	if !errors.Is(err, ErrNotEnrolled) {
		t.Fatalf("err = %v, want ErrNotEnrolled", err)
	}
}

func TestLoadCapsOutputLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	if err := Save(path, &Config{ServerURL: "u", AgentID: "a", Credential: "c", ExecOutputLimit: 100 << 20}); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.ExecOutputLimit != MaxExecOutputLimit {
		t.Errorf("limit = %d, want %d", got.ExecOutputLimit, MaxExecOutputLimit)
	}
}
