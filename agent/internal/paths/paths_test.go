package paths

import (
	"errors"
	"testing"
)

// 설계 문서 5.3 의 변환 표. 모든 행을 양방향으로 확인한다.
var roundTrip = []struct{ posix, windows string }{
	{"/c/Users/me/file.txt", `C:\Users\me\file.txt`},
	{"/c", `C:\`},
	{"/d/data", `D:\data`},
	{"/unc/server/share/dir", `\\server\share\dir`},
	{"/unc/server/share", `\\server\share`},
}

func TestRoundTrip(t *testing.T) {
	for _, tc := range roundTrip {
		got, err := ToWindows(tc.posix)
		if err != nil || got != tc.windows {
			t.Errorf("ToWindows(%q) = %q, %v; want %q", tc.posix, got, err, tc.windows)
		}
		back, err := FromWindows(tc.windows)
		if err != nil || back != tc.posix {
			t.Errorf("FromWindows(%q) = %q, %v; want %q", tc.windows, back, err, tc.posix)
		}
	}
}

func TestToWindows(t *testing.T) {
	cases := []struct {
		in, want string
		err      error
	}{
		{"/C/Users", `C:\Users`, nil},    // 대문자 드라이브도 받는다
		{"/c/a/../b/./c", `C:\b\c`, nil}, // POSIX 기준으로 정규화
		{"/c/..", "", ErrVirtualRoot},    // 루트 위로는 가상 루트
		{"/", "", ErrVirtualRoot},        // 드라이브 목록
		{"/unc/server", "", ErrInvalid},  // 공유 이름 없음
		{"/cc/x", "", ErrInvalid},        // 드라이브는 한 글자
		{"/home/me", "", ErrInvalid},     // 드라이브도 unc 도 아님
		{"c/Users", "", ErrInvalid},      // 상대 경로
		{"", "", ErrInvalid},
	}
	for _, tc := range cases {
		got, err := ToWindows(tc.in)
		if got != tc.want || !errors.Is(err, tc.err) {
			t.Errorf("ToWindows(%q) = %q, %v; want %q, %v", tc.in, got, err, tc.want, tc.err)
		}
	}
}

func TestFromWindows(t *testing.T) {
	cases := []struct {
		in, want string
		err      error
	}{
		{`\\?\C:\very\long\path`, "/c/very/long/path", nil},
		{`\\?\UNC\server\share\x`, "/unc/server/share/x", nil},
		{`C:/mixed\slashes`, "/c/mixed/slashes", nil},
		{`c:\lower`, "/c/lower", nil},
		{`C:\dir\`, "/c/dir", nil},
		{`C:foo`, "", ErrInvalid},         // 드라이브 상대 경로
		{`\\.\PIPE\name`, "", ErrInvalid}, // 장치 경로
		{`relative\path`, "", ErrInvalid},
		{`\\server`, "", ErrInvalid},
	}
	for _, tc := range cases {
		got, err := FromWindows(tc.in)
		if got != tc.want || !errors.Is(err, tc.err) {
			t.Errorf("FromWindows(%q) = %q, %v; want %q, %v", tc.in, got, err, tc.want, tc.err)
		}
	}
}
