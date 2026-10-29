// Package paths 는 프로토콜의 POSIX 경로와 OS 경로를 바꾼다.
// 프로토콜(Flue 샌드박스)은 POSIX 절대 경로만 쓴다. unix 에서는 그대로이고, Windows 는 다음 규칙을 따른다.
//
//	/c/Users/me      ↔ C:\Users\me       (드라이브는 소문자 한 글자 세그먼트)
//	/c               ↔ C:\
//	/unc/srv/share/x ↔ \\srv\share\x
//	/                → 가상 루트 (드라이브 목록). OS 경로가 없다
package paths

import (
	"errors"
	"path"
	"runtime"
	"strings"
)

var (
	// ErrInvalid 는 지원하지 않는 형식의 경로다 (상대 경로, 장치 경로, C:foo 등).
	ErrInvalid = errors.New("unsupported path")
	// ErrVirtualRoot 는 Windows 의 "/" 처럼 OS 경로가 없는 가상 디렉터리다.
	ErrVirtualRoot = errors.New("virtual root has no native path")
)

// Native 는 프로토콜 경로를 이 OS 의 경로로 바꾼다.
func Native(p string) (string, error) {
	if runtime.GOOS == "windows" {
		return ToWindows(p)
	}
	return cleanPosix(p)
}

// Protocol 은 이 OS 의 절대 경로를 프로토콜 경로로 바꾼다.
func Protocol(p string) (string, error) {
	if runtime.GOOS == "windows" {
		return FromWindows(p)
	}
	return cleanPosix(p)
}

func cleanPosix(p string) (string, error) {
	if !strings.HasPrefix(p, "/") {
		return "", ErrInvalid
	}
	return path.Clean(p), nil
}

// ToWindows 는 POSIX 프로토콜 경로를 Windows 경로로 바꾼다. 테스트를 위해 OS 와 무관하게 동작한다.
func ToWindows(p string) (string, error) {
	clean, err := cleanPosix(p)
	if err != nil {
		return "", err
	}
	if clean == "/" {
		return "", ErrVirtualRoot
	}
	segs := strings.Split(strings.TrimPrefix(clean, "/"), "/")
	switch {
	case isDriveSegment(segs[0]):
		return strings.ToUpper(segs[0]) + `:\` + strings.Join(segs[1:], `\`), nil
	case segs[0] == "unc":
		if len(segs) < 3 {
			// /unc, /unc/server 는 나열할 방법이 없다
			return "", ErrInvalid
		}
		return `\\` + strings.Join(segs[1:], `\`), nil
	default:
		return "", ErrInvalid
	}
}

// FromWindows 는 Windows 절대 경로를 POSIX 프로토콜 경로로 바꾼다.
func FromWindows(p string) (string, error) {
	switch {
	case strings.HasPrefix(p, `\\?\UNC\`):
		p = `\\` + p[len(`\\?\UNC\`):]
	case strings.HasPrefix(p, `\\?\`):
		p = p[len(`\\?\`):]
	case strings.HasPrefix(p, `\\.\`):
		return "", ErrInvalid // 장치 경로 (\\.\PIPE\... 등)
	}
	p = strings.ReplaceAll(p, `\`, "/")

	if strings.HasPrefix(p, "//") {
		segs := strings.Split(strings.Trim(p, "/"), "/")
		if len(segs) < 2 || segs[0] == "" || segs[1] == "" {
			return "", ErrInvalid
		}
		return path.Clean("/unc/" + strings.Join(segs, "/")), nil
	}
	// C:/... 만 허용. C:foo(드라이브 상대 경로)와 상대 경로는 거부한다
	if len(p) < 3 || !isDriveLetter(p[0]) || p[1] != ':' || p[2] != '/' {
		return "", ErrInvalid
	}
	return path.Clean("/" + strings.ToLower(p[:1]) + p[2:]), nil
}

func isDriveSegment(s string) bool {
	return len(s) == 1 && isDriveLetter(s[0])
}

func isDriveLetter(c byte) bool {
	return ('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z')
}
