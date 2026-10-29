import http2 from 'node:http2';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { type AgentMessage, AgentGateway, type ServerMessage, ServerMessageSchema } from '@gridelta/proto/gateway';
import { type AgentHub, IDLE_TIMEOUT_MS, PING_INTERVAL_MS } from '../hub/index.ts';

export const SERVER_VERSION = '0.1.0-dev';
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export function gatewayRoutes(hub: AgentHub) {
  return (router: ConnectRouter) => {
    router.service(AgentGateway, {
      async *connect(requests: AsyncIterable<AgentMessage>, ctx): AsyncIterable<ServerMessage> {
        const it = requests[Symbol.asyncIterator]();
        const first = await it.next();
        if (first.done || first.value.msg.case !== 'hello') {
          throw new ConnectError('first message must be Hello', Code.InvalidArgument);
        }
        const hello = first.value.msg.value;
        if (!hello.agentId) throw new ConnectError('agent_id is required', Code.InvalidArgument);

        const conn = hub.attach(hello);
        console.info(`[gateway] online ${hello.agentId} (${hello.os}/${hello.arch}, ${hello.hostname})`);

        // 수신: 응답·하트비트를 처리하고, 스트림이 끝나면 송신 큐를 닫는다
        void (async () => {
          try {
            for (let r = await it.next(); !r.done; r = await it.next()) {
              conn.lastRecv = Date.now();
              const msg = r.value.msg;
              if (msg.case === 'response') hub.resolveResponse(conn, msg.value);
            }
          } catch {
            // 연결 끊김. 아래 finally 에서 정리한다
          } finally {
            conn.outbox.close();
          }
        })();

        // 하트비트: 주기적으로 Ping, 45초 동안 아무것도 받지 못하면 끊는다
        const timer = setInterval(() => {
          if (Date.now() - conn.lastRecv > IDLE_TIMEOUT_MS) {
            console.warn(`[gateway] ${hello.agentId} idle for ${IDLE_TIMEOUT_MS}ms, closing`);
            conn.outbox.close();
            return;
          }
          conn.ping();
        }, PING_INTERVAL_MS);
        const onAbort = () => conn.outbox.close();
        ctx.signal.addEventListener('abort', onAbort);

        try {
          yield create(ServerMessageSchema, {
            msg: {
              case: 'welcome',
              value: { serverVersion: SERVER_VERSION, minAgentVersion: '0.1.0', pingIntervalMs: PING_INTERVAL_MS },
            },
          });
          yield* conn.outbox;
        } finally {
          clearInterval(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          hub.detach(conn);
          console.info(`[gateway] offline ${hello.agentId}`);
        }
      },

      enroll() {
        throw new ConnectError('enroll is implemented in M2', Code.Unimplemented);
      },
    });
  };
}

/**
 * 에이전트용 HTTP/2 서버를 띄운다. bidi 스트림에는 HTTP/2 가 필수다.
 * M1 은 평문 HTTP/2(h2c)이며, TLS 는 M2 에서 붙인다.
 */
export function startGateway(hub: AgentHub, port: number): http2.Http2Server {
  const handler = connectNodeAdapter({
    routes: gatewayRoutes(hub),
    readMaxBytes: MAX_MESSAGE_BYTES,
  });
  const server = http2.createServer(handler);
  server.listen(port, () => console.info(`[gateway] listening on :${port} (h2c)`));
  return server;
}
