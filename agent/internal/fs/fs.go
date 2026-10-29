// Package fs 는 AI 샌드박스의 파일 작업을 처리한다. 경로는 프로토콜(POSIX) 형식으로 받는다.
package fs

import (
	"errors"
	"io"
	iofs "io/fs"
	"os"
	"runtime"
	"slices"

	grideltav1 "github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1"
	"github.com/Epsilondelta-ai/gridelta/agent/internal/paths"
)

// MaxFileBytes 는 한 번에 읽고 쓸 수 있는 파일 크기다 (메시지 상한 4 MiB 에서 여유를 둠).
const MaxFileBytes = 3 << 20

// Error 는 Response.error 로 보낼 코드가 붙은 에러다.
type Error struct {
	Code string
	Err  error
}

func (e *Error) Error() string { return e.Err.Error() }
func (e *Error) Unwrap() error { return e.Err }

func codeErr(code string, err error) error { return &Error{Code: code, Err: err} }

// classify 는 OS 에러를 프로토콜 에러 코드로 바꾼다.
func classify(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, iofs.ErrNotExist):
		return codeErr("not_found", err)
	case errors.Is(err, iofs.ErrPermission):
		return codeErr("permission_denied", err)
	case errors.Is(err, paths.ErrInvalid):
		return codeErr("invalid_argument", err)
	default:
		return codeErr("internal", err)
	}
}

// native 는 프로토콜 경로를 OS 경로로 바꾼다. Windows 의 "/" (가상 루트)는 virtual=true.
func native(p string) (path string, virtual bool, err error) {
	path, err = paths.Native(p)
	if errors.Is(err, paths.ErrVirtualRoot) {
		return "", true, nil
	}
	return path, false, classify(err)
}

func errVirtual() error {
	return codeErr("permission_denied", errors.New("the virtual root is read-only"))
}

func Read(req *grideltav1.FsReadRequest) (*grideltav1.FsReadResult, error) {
	p, virtual, err := native(req.GetPath())
	if err != nil {
		return nil, err
	}
	if virtual {
		return nil, codeErr("invalid_argument", errors.New("is a directory"))
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, classify(err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
	if err != nil {
		return nil, classify(err)
	}
	if len(data) > MaxFileBytes {
		return nil, codeErr("too_large", errors.New("file is larger than 3 MiB"))
	}
	return &grideltav1.FsReadResult{Data: data}, nil
}

func Write(req *grideltav1.FsWriteRequest) error {
	if len(req.GetData()) > MaxFileBytes {
		return codeErr("too_large", errors.New("data is larger than 3 MiB"))
	}
	p, virtual, err := native(req.GetPath())
	if err != nil {
		return err
	}
	if virtual {
		return errVirtual()
	}
	// 이미 있는 파일은 권한을 유지한다
	mode := os.FileMode(0o644)
	if st, err := os.Stat(p); err == nil {
		mode = st.Mode().Perm()
	}
	return classify(os.WriteFile(p, req.GetData(), mode))
}

func Stat(req *grideltav1.FsStatRequest) (*grideltav1.FsStatResult, error) {
	p, virtual, err := native(req.GetPath())
	if err != nil {
		return nil, err
	}
	if virtual {
		return &grideltav1.FsStatResult{IsDir: true}, nil
	}
	lst, err := os.Lstat(p)
	if err != nil {
		return nil, classify(err)
	}
	st := lst
	if lst.Mode()&os.ModeSymlink != 0 {
		// 링크가 가리키는 대상의 종류와 크기를 쓴다. 대상이 없으면 링크 자체 정보
		if target, err := os.Stat(p); err == nil {
			st = target
		}
	}
	size := uint64(st.Size())
	mtime := st.ModTime().UnixMilli()
	mode := uint32(st.Mode().Perm())
	return &grideltav1.FsStatResult{
		IsDir:     st.IsDir(),
		IsSymlink: lst.Mode()&os.ModeSymlink != 0,
		Size:      &size,
		MtimeMs:   &mtime,
		Mode:      &mode,
	}, nil
}

func Readdir(req *grideltav1.FsReaddirRequest) (*grideltav1.FsReaddirResult, error) {
	p, virtual, err := native(req.GetPath())
	if err != nil {
		return nil, err
	}
	if virtual {
		return &grideltav1.FsReaddirResult{Names: windowsRoots()}, nil
	}
	entries, err := os.ReadDir(p)
	if err != nil {
		return nil, classify(err)
	}
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.Name()
	}
	return &grideltav1.FsReaddirResult{Names: names}, nil
}

func Mkdir(req *grideltav1.FsMkdirRequest) error {
	p, virtual, err := native(req.GetPath())
	if err != nil {
		return err
	}
	if virtual {
		return errVirtual()
	}
	if req.GetRecursive() {
		return classify(os.MkdirAll(p, 0o755))
	}
	return classify(os.Mkdir(p, 0o755))
}

func Rm(req *grideltav1.FsRmRequest) error {
	p, virtual, err := native(req.GetPath())
	if err != nil {
		return err
	}
	if virtual {
		return errVirtual()
	}
	if req.GetRecursive() {
		// RemoveAll 은 없는 경로에도 성공한다. force 가 아니면 먼저 확인한다
		if _, err := os.Lstat(p); err != nil && !(req.GetForce() && errors.Is(err, iofs.ErrNotExist)) {
			return classify(err)
		}
		return classify(os.RemoveAll(p))
	}
	err = os.Remove(p)
	if req.GetForce() && errors.Is(err, iofs.ErrNotExist) {
		return nil
	}
	return classify(err)
}

// windowsRoots 는 가상 루트 "/" 의 항목: 존재하는 드라이브 문자. UNC 는 나열할 수 없어 뺀다.
func windowsRoots() []string {
	if runtime.GOOS != "windows" {
		return nil
	}
	var roots []string
	for c := 'a'; c <= 'z'; c++ {
		if _, err := os.Stat(string(c) + `:\`); err == nil {
			roots = append(roots, string(c))
		}
	}
	return slices.Clip(roots)
}
