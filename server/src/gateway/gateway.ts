import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { type AgentMessage, AgentGateway, type ServerMessage, ServerMessageSchema } from '@gridelta/proto/gateway';
import { type AgentHub, IDLE_TIMEOUT_MS, PING_INTERVAL_MS } from '../hub/index.ts';
import type { Store } from '../store/index.ts';

export const SERVER_VERSION = '0.1.0-dev';
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

function bearer(header: string | null): string {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

export function gatewayRoutes(hub: AgentHub, store: Store) {
  return (router: ConnectRouter) => {
    router.service(AgentGateway, {
      async *connect(requests: AsyncIterable<AgentMessage>, ctx): AsyncIterable<ServerMessage> {
        const it = requests[Symbol.asyncIterator]();
        const first = await it.next();
        if (first.done || first.value.msg.case !== 'hello') {
          throw new ConnectError('first message must be Hello', Code.InvalidArgument);
        }
        const hello = first.value.msg.value;
        const row = await store.authenticateEndpoint(hello.agentId, bearer(ctx.requestHeader.get('authorization')));
        if (!row) throw new ConnectError('invalid or revoked agent credential', Code.Unauthenticated);

        await store.updateFromHello(hello.agentId, hello);
        const conn = hub.attach(hello);
        console.info(`[gateway] online ${hello.agentId} (${hello.os}/${hello.arch}, ${hello.hostname})`);

        // 수신: 응답·하트비트를 처리하고, 스트림이 끝나면 송신 큐를 닫는다
        void (async () => {
          try {
            for (let r = await it.next(); !r.done; r = await it.next()) {
              conn.lastRecv = Date.now();
              const msg = r.value.msg;
              switch (msg.case) {
                case 'response':
                  hub.resolveResponse(conn, msg.value);
                  break;
                case 'ptyOutput':
                  hub.ptyOutput(conn, msg.value.sessionId, msg.value.data);
                  break;
                case 'ptyExit':
                  hub.ptyExit(conn, msg.value.sessionId, msg.value.exitCode);
                  break;
              }
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
          await store.touchEndpoint(hello.agentId, new Date(conn.lastRecv)).catch(() => {});
          console.info(`[gateway] offline ${hello.agentId}`);
        }
      },

      async enroll(req) {
        if (!(await store.consumeEnrollToken(req.enrollToken))) {
          throw new ConnectError('invalid, used or expired enroll token', Code.PermissionDenied);
        }
        const { id, credential } = await store.enrollEndpoint(req);
        console.info(`[gateway] enrolled ${id} (${req.os}/${req.arch}, ${req.hostname})`);
        return { agentId: id, credential };
      },
    });
  };
}

export interface GatewayOptions {
  port: number;
  tlsCert?: string;
  tlsKey?: string;
}

/**
 * 에이전트용 HTTP/2 서버를 띄운다. bidi 스트림에는 HTTP/2 가 필수다.
 * 인증서가 주어지면 TLS, 아니면 h2c (앞단 프록시가 TLS 를 맡는 경우).
 */
export function startGateway(hub: AgentHub, store: Store, opts: GatewayOptions): http2.Http2Server {
  const handler = connectNodeAdapter({ routes: gatewayRoutes(hub, store), readMaxBytes: MAX_MESSAGE_BYTES });
  const tls = opts.tlsCert && opts.tlsKey;
  const server = tls
    ? http2.createSecureServer({ cert: readFileSync(opts.tlsCert!), key: readFileSync(opts.tlsKey!) }, handler)
    : http2.createServer(handler);
  server.listen(opts.port, () => console.info(`[gateway] listening on :${opts.port} (${tls ? 'TLS' : 'h2c'})`));
  return server;
}

/**
 * 인증서 파일에서 고정용 지문(SHA-256, 소문자 hex)을 구한다.
 * 체인 파일이면 마지막 인증서(가장 상위 CA)를 쓴다. 자체 서명이면 그 인증서 자신이다.
 */
export function certFingerprint(certPath: string): string {
  const pems = readFileSync(certPath, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!pems?.length) throw new Error(`no certificate found in ${certPath}`);
  return new X509Certificate(pems.at(-1)!).fingerprint256.replaceAll(':', '').toLowerCase();
}
