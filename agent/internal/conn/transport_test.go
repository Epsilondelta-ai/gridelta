package conn

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPinnedFingerprint(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer srv.Close()
	sum := sha256.Sum256(srv.Certificate().Raw)
	good := hex.EncodeToString(sum[:])

	// 콜론 구분 대문자 형식도 받아들인다
	colon := strings.ToUpper(good[:2]) + ":" + strings.ToUpper(good[2:])
	for _, fp := range []string{good, colon} {
		client := &http.Client{Transport: &http.Transport{TLSClientConfig: tlsConfig(fp)}}
		resp, err := client.Get(srv.URL)
		if err != nil {
			t.Fatalf("pinned %q: %v", fp, err)
		}
		resp.Body.Close()
	}

	bad := strings.Repeat("0", 64)
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: tlsConfig(bad)}}
	_, err := client.Get(srv.URL)
	if !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("wrong pin: err = %v, want ErrFingerprintMismatch", err)
	}
}

func TestNoPinUsesSystemRoots(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer srv.Close()
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: tlsConfig("")}}
	if _, err := client.Get(srv.URL); err == nil {
		t.Fatal("self-signed server accepted without a pin")
	}
}
