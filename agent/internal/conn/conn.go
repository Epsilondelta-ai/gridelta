// Package conn 은 서버와의 연결·재연결과 요청 디스패치를 맡는다.
package conn

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connecthttp"

	grideltav1 "github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1"
	"github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1/grideltav1connect"
	"github.com/Epsilondelta-ai/gridelta/agent/internal/exec"
)

const (
	maxMessageBytes = 4 << 20
	// 이 시간 동안 서버에게서 아무것도 받지 못하면 스스로 끊고 재연결한다
	idleTimeout = 45 * time.Second
	// 이만큼 연결이 유지되었으면 다음 재연결은 백오프를 처음부터 시작한다
	stableAfter = 30 * time.Second
	// 버전 비호환으로 거부되면 이 간격으로만 재시도한다
	incompatibleRetry = time.Hour
)

// Config 는 에이전트 연결 설정이다.
type Config struct {
	ServerURL   string
	Credential  string
	Hello       *grideltav1.Hello
	OutputLimit int
}

// Client 는 서버와의 연결 하나를 유지한다.
type Client struct {
	cfg    Config
	gw     grideltav1connect.AgentGatewayClient
	logger *slog.Logger
}

func New(cfg Config, logger *slog.Logger) *Client {
	transport := connecthttp.NewTransport(newHTTPClient(cfg.ServerURL), cfg.ServerURL,
		connecthttp.WithReadMaxBytes(maxMessageBytes),
		connecthttp.WithSendMaxBytes(maxMessageBytes),
	)
	return &Client{
		cfg:    cfg,
		gw:     grideltav1connect.NewAgentGatewayClient(connect.NewClient(transport)),
		logger: logger,
	}
}

// newHTTPClient 는 긴 bidi 스트림에 맞춘 HTTP/2 클라이언트를 만든다.
// http:// 이면 h2c(평문 HTTP/2), https:// 이면 TLS 위 HTTP/2 만 쓴다.
func newHTTPClient(serverURL string) *http.Client {
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
			TLSClientConfig:   &tls.Config{MinVersion: tls.VersionTLS12},
			HTTP2: &http.HTTP2Config{
				SendPingTimeout:  20 * time.Second,
				PingTimeout:      10 * time.Second,
				WriteByteTimeout: 15 * time.Second,
			},
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// Run 은 ctx 가 끝날 때까지 연결을 유지하고, 끊기면 백오프 후 재연결한다.
func (c *Client) Run(ctx context.Context) {
	bo := newBackoff()
	for ctx.Err() == nil {
		started := time.Now()
		err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) >= stableAfter {
			bo.reset()
		}
		wait := bo.next()
		if connect.CodeOf(err) == connect.CodeFailedPrecondition {
			wait = incompatibleRetry
		}
		c.logger.Warn("disconnected", "err", err, "retry_in", wait.Round(time.Millisecond))
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
	}
}

// session 은 연결 하나의 수명이다. 연결이 끊기면 에러를 돌려준다.
func (c *Client) session(parent context.Context) error {
	ctx, cancel := context.WithCancelCause(parent)
	defer cancel(nil)

	ctx, info := connect.NewClientContext(ctx)
	if c.cfg.Credential != "" {
		info.RequestHeader().Set("Authorization", "Bearer "+c.cfg.Credential)
	}
	stream, err := c.gw.Connect(ctx)
	if err != nil {
		return err
	}
	defer stream.Close()

	s := &session{
		client:  c,
		ctx:     ctx,
		out:     make(chan *grideltav1.AgentMessage, 64),
		running: map[string]context.CancelFunc{},
	}
	s.lastRecv.Store(time.Now().UnixNano())

	// 단일 writer: 스트림 송신은 이 goroutine 에서만 한다
	writeErr := make(chan error, 1)
	go func() {
		for {
			select {
			case <-ctx.Done():
				writeErr <- context.Cause(ctx)
				return
			case msg := <-s.out:
				if err := stream.Send(msg); err != nil {
					cancel(err)
					writeErr <- err
					return
				}
			}
		}
	}()

	s.send(&grideltav1.AgentMessage{Msg: &grideltav1.AgentMessage_Hello{Hello: c.cfg.Hello}})

	go s.watchIdle(cancel)

	for {
		msg, err := stream.Receive()
		if err != nil {
			if errors.Is(err, io.EOF) {
				err = errors.New("server closed stream")
			}
			if cause := context.Cause(ctx); cause != nil && !errors.Is(cause, context.Canceled) {
				err = cause
			}
			cancel(err)
			return err
		}
		s.lastRecv.Store(time.Now().UnixNano())
		s.dispatch(msg)
	}
}

type session struct {
	client   *Client
	ctx      context.Context
	out      chan *grideltav1.AgentMessage
	lastRecv atomic.Int64

	mu      sync.Mutex
	running map[string]context.CancelFunc
}

func (s *session) send(msg *grideltav1.AgentMessage) {
	select {
	case s.out <- msg:
	case <-s.ctx.Done():
	}
}

func (s *session) watchIdle(cancel context.CancelCauseFunc) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-t.C:
			if time.Since(time.Unix(0, s.lastRecv.Load())) > idleTimeout {
				cancel(fmt.Errorf("no message from server for %s", idleTimeout))
				return
			}
		}
	}
}

func (s *session) dispatch(msg *grideltav1.ServerMessage) {
	switch m := msg.Msg.(type) {
	case *grideltav1.ServerMessage_Welcome:
		s.client.logger.Info("connected", "server_version", m.Welcome.GetServerVersion())
	case *grideltav1.ServerMessage_Ping:
		s.send(&grideltav1.AgentMessage{Msg: &grideltav1.AgentMessage_Heartbeat{
			Heartbeat: &grideltav1.Heartbeat{Nonce: m.Ping.GetNonce()},
		}})
	case *grideltav1.ServerMessage_Request:
		go s.handle(m.Request)
	}
}

func (s *session) handle(req *grideltav1.Request) {
	res := &grideltav1.Response{RequestId: req.GetRequestId()}
	switch op := req.Op.(type) {
	case *grideltav1.Request_Exec:
		s.handleExec(req.GetRequestId(), op.Exec, res)
	case *grideltav1.Request_Cancel:
		if s.cancelRunning(op.Cancel.GetTargetRequestId()) {
			res.Result = &grideltav1.Response_Ok{Ok: &grideltav1.Empty{}}
		} else {
			res.Error = &grideltav1.Error{Code: "not_found", Message: "no running request with that id"}
		}
	default:
		res.Error = &grideltav1.Error{Code: "unsupported", Message: fmt.Sprintf("%T is not supported yet", op)}
	}
	s.send(&grideltav1.AgentMessage{Msg: &grideltav1.AgentMessage_Response{Response: res}})
}

func (s *session) handleExec(id string, req *grideltav1.ExecRequest, res *grideltav1.Response) {
	// 연결이 끊겨도 실행 중인 명령은 계속 돈다(결과만 버린다). 그래서 session ctx 가 아닌 별도 ctx 를 쓴다.
	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.running[id] = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.running, id)
		s.mu.Unlock()
		cancel()
	}()

	result, err := exec.Run(ctx, req, s.client.cfg.Hello.GetDefaultShell(), s.client.cfg.OutputLimit)
	switch {
	case errors.Is(err, exec.ErrCanceled):
		res.Error = &grideltav1.Error{Code: "canceled", Message: "canceled by server"}
	case err != nil:
		res.Error = &grideltav1.Error{Code: "internal", Message: err.Error()}
	default:
		res.Result = &grideltav1.Response_Exec{Exec: result}
	}
}

func (s *session) cancelRunning(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	cancel, ok := s.running[id]
	if ok {
		cancel()
	}
	return ok
}
