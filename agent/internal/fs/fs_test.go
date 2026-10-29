//go:build !windows

package fs

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"

	grideltav1 "github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1"
)

func code(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

func TestWriteReadStat(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	if err := Write(&grideltav1.FsWriteRequest{Path: p, Data: []byte("hello")}); err != nil {
		t.Fatal(err)
	}
	r, err := Read(&grideltav1.FsReadRequest{Path: p})
	if err != nil || string(r.GetData()) != "hello" {
		t.Fatalf("read = %q, %v", r.GetData(), err)
	}
	st, err := Stat(&grideltav1.FsStatRequest{Path: p})
	if err != nil || st.GetIsDir() || st.GetSize() != 5 {
		t.Fatalf("stat = %+v, %v", st, err)
	}

	// 기존 파일 권한 유지
	_ = os.Chmod(p, 0o600)
	_ = Write(&grideltav1.FsWriteRequest{Path: p, Data: []byte("x")})
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode changed to %o", fi.Mode().Perm())
	}
}

func TestSymlinkStat(t *testing.T) {
	dir := t.TempDir()
	_ = os.Mkdir(filepath.Join(dir, "target"), 0o755)
	_ = os.Symlink(filepath.Join(dir, "target"), filepath.Join(dir, "link"))
	st, err := Stat(&grideltav1.FsStatRequest{Path: filepath.Join(dir, "link")})
	if err != nil || !st.GetIsSymlink() || !st.GetIsDir() {
		t.Fatalf("stat = %+v, %v", st, err)
	}
}

func TestErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := Read(&grideltav1.FsReadRequest{Path: filepath.Join(dir, "nope")}); code(err) != "not_found" {
		t.Errorf("missing file: %v", err)
	}
	if _, err := Read(&grideltav1.FsReadRequest{Path: "relative"}); code(err) != "invalid_argument" {
		t.Errorf("relative path: %v", err)
	}
	big := filepath.Join(dir, "big")
	_ = os.WriteFile(big, make([]byte, MaxFileBytes+1), 0o644)
	if _, err := Read(&grideltav1.FsReadRequest{Path: big}); code(err) != "too_large" {
		t.Errorf("big file: %v", err)
	}
	if err := Write(&grideltav1.FsWriteRequest{Path: big, Data: make([]byte, MaxFileBytes+1)}); code(err) != "too_large" {
		t.Errorf("big write: %v", err)
	}
}

func TestMkdirReaddirRm(t *testing.T) {
	dir := t.TempDir()
	deep := filepath.Join(dir, "a", "b")
	if err := Mkdir(&grideltav1.FsMkdirRequest{Path: deep}); code(err) != "not_found" {
		t.Errorf("non-recursive mkdir of deep path: %v", err)
	}
	if err := Mkdir(&grideltav1.FsMkdirRequest{Path: deep, Recursive: true}); err != nil {
		t.Fatal(err)
	}
	ls, err := Readdir(&grideltav1.FsReaddirRequest{Path: filepath.Join(dir, "a")})
	if err != nil || !slices.Equal(ls.GetNames(), []string{"b"}) {
		t.Fatalf("readdir = %v, %v", ls.GetNames(), err)
	}

	a := filepath.Join(dir, "a")
	if err := Rm(&grideltav1.FsRmRequest{Path: a}); err == nil {
		t.Error("non-recursive rm of non-empty dir succeeded")
	}
	if err := Rm(&grideltav1.FsRmRequest{Path: a, Recursive: true}); err != nil {
		t.Fatal(err)
	}
	if err := Rm(&grideltav1.FsRmRequest{Path: a, Recursive: true}); code(err) != "not_found" {
		t.Errorf("rm missing without force: %v", err)
	}
	if err := Rm(&grideltav1.FsRmRequest{Path: a, Recursive: true, Force: true}); err != nil {
		t.Errorf("rm missing with force: %v", err)
	}
}
