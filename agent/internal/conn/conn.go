// Package conn 은 서버와의 연결·재연결과 요청 디스패치를 맡는다.
package conn

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect/v2"
	"google.golang.org/protobuf/proto"

	grideltav1 "github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1"
	"github.com/Epsilondelta-ai/gridelta/agent/gen/gridelta/v1/grideltav1connect"
	"github.com/Epsilondelta-ai/gridelta/agent/internal/exec"
	"github.com/Epsilondelta-ai/gridelta/agent/internal/fs"
	"github.com/Epsilondelta-ai/gridelta/agent/internal/pty"
)

const (
	// 이 시간 동안 서버에게서 아무것도 받지 못하면 스스로 끊고 재연결한다
	idleTimeout = 45 * time.Second
	// 이만큼 연결이 유지되었으면 다음 재연결은 백오프를 처음부터 시작한다
	stableAfter = 30 * time.Second
	// 버전 비호환이거나 자격 증명이 폐기되면 이 간격으로만 재시도한다
	rejectedRetry = time.Hour
	// 연결이 끊긴 뒤 이 시간 안에 다시 연결되지 않으면 PTY 세션을 모두 닫는다
	ptyGrace = 30 * time.Second
)

// Config 는 에이전트 연결 설정이다.
type Config struct {
	ServerURL     string
	CAFingerprint string
	Credential    string
	Hello         *grideltav1.Hello
	OutputLimit   int
}

// Client 는 서버와의 연결 하나를 유지한다.
type Client struct {
	cfg    Config
	gw     grideltav1connect.AgentGatewayClient
	logger *slog.Logger
	ptys   *pty.Manager

	mu  sync.Mutex
	cur *session // 현재 연결. 끊겨 있으면 nil
}

func New(cfg Config, logger *slog.Logger) *Client {
	c := &Client{cfg: cfg, gw: NewGatewayClient(cfg.ServerURL, cfg.CAFingerprint), logger: logger}
	c.ptys = pty.NewManager(c, cfg.Hello.GetDefaultShell())
	return c
}

// sendCurrent 는 현재 연결로 보낸다. 연결이 없으면 버린다(PTY 출력 등 비동기 메시지).
func (c *Client) sendCurrent(msg *grideltav1.AgentMessage) {
	c.mu.Lock()
	s := c.cur
	c.mu.Unlock()
	if s != nil {
		s.send(msg)
	}
}

// PtyOutput 은 pty.Sink 구현이다.
func (c *Client) PtyOutput(sessionID string, data []byte) {
	c.sendCurrent(&grideltav1.AgentMessage{Msg: &grideltav1.AgentMessage_PtyOutput{
		PtyOutput: &grideltav1.PtyOutput{SessionId: sessionID, Data: data},
	}})
}

// PtyExit 은 pty.Sink 구현이다.
func (c *Client) PtyExit(sessionID string, exitCode int) {
	c.sendCurrent(&grideltav1.AgentMessage{Msg: &grideltav1.AgentMessage_PtyExit{
		PtyExit: &grideltav1.PtyExit{SessionId: sessionID, ExitCode: int32(exitCode)},
	}})
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
		switch connect.CodeOf(err) {
		case connect.CodeFailedPrecondition, connect.CodeUnauthenticated:
			wait = rejectedRetry
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
	c.mu.Lock()
	c.cur = s
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.cur = nil
		c.mu.Unlock()
		c.ptys.CloseAllAfter(ptyGrace)
	}()

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

	hello := proto.CloneOf(c.cfg.Hello)
	hello.PtySessionIds = c.ptys.IDs()
	s.send(&grideltav1.AgentMessage{Msg: &grideltav1.AgentMessage_Hello{Hello: hello}})

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
		s.client.ptys.CancelCloseAll()
	case *grideltav1.ServerMessage_Ping:
		s.send(&grideltav1.AgentMessage{Msg: &grideltav1.AgentMessage_Heartbeat{
			Heartbeat: &grideltav1.Heartbeat{Nonce: m.Ping.GetNonce()},
		}})
	case *grideltav1.ServerMessage_Request:
		go s.handle(m.Request)
	case *grideltav1.ServerMessage_PtyInput:
		_ = s.client.ptys.Input(m.PtyInput.GetSessionId(), m.PtyInput.GetData())
	case *grideltav1.ServerMessage_PtyResize:
		_ = s.client.ptys.Resize(m.PtyResize.GetSessionId(), m.PtyResize.GetCols(), m.PtyResize.GetRows())
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
	case *grideltav1.Request_FsRead:
		r, err := fs.Read(op.FsRead)
		setResult(res, err, func() { res.Result = &grideltav1.Response_FsRead{FsRead: r} })
	case *grideltav1.Request_FsWrite:
		setResult(res, fs.Write(op.FsWrite), okResult(res))
	case *grideltav1.Request_FsStat:
		r, err := fs.Stat(op.FsStat)
		setResult(res, err, func() { res.Result = &grideltav1.Response_FsStat{FsStat: r} })
	case *grideltav1.Request_FsReaddir:
		r, err := fs.Readdir(op.FsReaddir)
		setResult(res, err, func() { res.Result = &grideltav1.Response_FsReaddir{FsReaddir: r} })
	case *grideltav1.Request_FsMkdir:
		setResult(res, fs.Mkdir(op.FsMkdir), okResult(res))
	case *grideltav1.Request_FsRm:
		setResult(res, fs.Rm(op.FsRm), okResult(res))
	case *grideltav1.Request_PtyOpen:
		if pid, err := s.client.ptys.Open(op.PtyOpen); err != nil {
			res.Error = &grideltav1.Error{Code: "internal", Message: err.Error()}
		} else {
			res.Result = &grideltav1.Response_PtyOpen{PtyOpen: &grideltav1.PtyOpenResult{Pid: int32(pid)}}
		}
	case *grideltav1.Request_PtyClose:
		if err := s.client.ptys.Close(op.PtyClose.GetSessionId()); errors.Is(err, pty.ErrNotFound) {
			res.Error = &grideltav1.Error{Code: "not_found", Message: err.Error()}
		} else if err != nil {
			res.Error = &grideltav1.Error{Code: "internal", Message: err.Error()}
		} else {
			res.Result = &grideltav1.Response_Ok{Ok: &grideltav1.Empty{}}
		}
	default:
		res.Error = &grideltav1.Error{Code: "unsupported", Message: fmt.Sprintf("%T is not supported yet", op)}
	}
	s.send(&grideltav1.AgentMessage{Msg: &grideltav1.AgentMessage_Response{Response: res}})
}

// setResult 는 err 가 있으면 Response.error 를, 없으면 ok() 로 결과를 채운다.
func setResult(res *grideltav1.Response, err error, ok func()) {
	if err == nil {
		ok()
		return
	}
	code := "internal"
	var fe *fs.Error
	if errors.As(err, &fe) {
		code = fe.Code
	}
	res.Error = &grideltav1.Error{Code: code, Message: err.Error()}
}

func okResult(res *grideltav1.Response) func() {
	return func() { res.Result = &grideltav1.Response_Ok{Ok: &grideltav1.Empty{}} }
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
