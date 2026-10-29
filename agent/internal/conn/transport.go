package conn

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connecthttp"

	"github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1/grideltav1connect"
)

const maxMessageBytes = 4 << 20

// NewGatewayClient 는 게이트웨이 클라이언트를 만든다. caFingerprint 가 있으면 그 인증서를 고정한다.
func NewGatewayClient(serverURL, caFingerprint string) grideltav1connect.AgentGatewayClient {
	transport := connecthttp.NewTransport(newHTTPClient(serverURL, caFingerprint), serverURL,
		connecthttp.WithReadMaxBytes(maxMessageBytes),
		connecthttp.WithSendMaxBytes(maxMessageBytes),
	)
	return grideltav1connect.NewAgentGatewayClient(connect.NewClient(transport))
}

// newHTTPClient 는 긴 bidi 스트림에 맞춘 HTTP/2 클라이언트를 만든다.
// http:// 이면 h2c(평문 HTTP/2), https:// 이면 TLS 위 HTTP/2 만 쓴다.
func newHTTPClient(serverURL, caFingerprint string) *http.Client {
	protocols := new(http.Protocols)
	if strings.HasPrefix(serverURL, "http://") {
		protocols.SetUnencryptedHTTP2(true)
	} else {
		protocols.SetHTTP2(true)
	}
	return &http.Client{
		// 스트림 전체에 걸리므로 0 으로 두고 context 로 취소한다
		Timeout: 0,
		Transport: &http.Transport{
			ForceAttemptHTTP2: true,
			Protocols:         protocols,
			TLSClientConfig:   tlsConfig(caFingerprint),
			HTTP2: &http.HTTP2Config{
				SendPingTimeout:  20 * time.Second,
				PingTimeout:      10 * time.Second,
				WriteByteTimeout: 15 * time.Second,
			},
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// ErrFingerprintMismatch 는 서버 인증서 체인에 고정한 지문이 없을 때 돌려준다.
var ErrFingerprintMismatch = errors.New("server certificate does not match pinned CA fingerprint")

// tlsConfig: 지문이 없으면 OS 신뢰 저장소로 검증한다(공인 인증서).
// 지문이 있으면(자체 서명) 서버가 보낸 체인 중 하나가 그 지문과 같아야 한다. 이 경우 호스트 이름 대신 지문으로 신원을 확인한다.
func tlsConfig(caFingerprint string) *tls.Config {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12}
	pin := NormalizeFingerprint(caFingerprint)
	if pin == "" {
		return cfg
	}
	cfg.InsecureSkipVerify = true
	cfg.VerifyPeerCertificate = func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		for _, raw := range rawCerts {
			sum := sha256.Sum256(raw)
			if hex.EncodeToString(sum[:]) == pin {
				return nil
			}
		}
		return ErrFingerprintMismatch
	}
	return cfg
}

// NormalizeFingerprint 는 "AB:CD:..." 와 "abcd..." 를 같은 형태(소문자 hex)로 맞춘다.
func NormalizeFingerprint(fp string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(fp), ":", ""))
}
