import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { create } from '@bufbuild/protobuf';
import {
  type Hello,
  type Request,
  RequestSchema,
  type Response,
  type ServerMessage,
  ServerMessageSchema,
} from '@gridelta/proto/gateway';
import { AsyncQueue } from './async-queue.ts';

export const PING_INTERVAL_MS = 15_000;
export const IDLE_TIMEOUT_MS = 45_000;

export type RequestOp = Request['op'];

export interface RequestOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface EndpointInfo {
  id: string;
  os: string;
  arch: string;
  hostname: string;
  homeDir: string;
  defaultShell: string;
  agentVersion: string;
  online: boolean;
  lastSeen: Date;
}

/** PC 가 연결되어 있지 않거나 호출 도중 연결이 끊겼다. */
export class EndpointOfflineError extends Error {
  constructor(readonly endpointId: string) {
    super(`PC ${endpointId} 가 오프라인입니다.`);
    this.name = 'EndpointOfflineError';
  }
}

/** 에이전트가 Response.error 로 돌려준 실패. */
export class AgentRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'AgentRequestError';
  }
}

export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`agent did not respond within ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
  }
}

interface Pending {
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
}

/** 연결된 에이전트 하나. 송신은 outbox 큐로만 한다(게이트웨이가 스트림으로 내보냄). */
export class EndpointConn {
  readonly outbox = new AsyncQueue<ServerMessage>();
  readonly pending = new Map<string, Pending>();
  lastRecv = Date.now();
  #nonce = 0n;

  constructor(readonly hello: Hello) {}

  send(msg: ServerMessage): void {
    this.outbox.push(msg);
  }

  ping(): void {
    this.send(create(ServerMessageSchema, { msg: { case: 'ping', value: { nonce: ++this.#nonce } } }));
  }
}

type HubEvents = {
  online: [EndpointInfo];
  offline: [EndpointInfo];
};

/** 모든 원격 작업이 거쳐 가는 연결 레지스트리. */
export class AgentHub {
  readonly events = new EventEmitter<HubEvents>();
  readonly #conns = new Map<string, EndpointConn>();
  readonly #known = new Map<string, EndpointInfo>();

  list(): EndpointInfo[] {
    return [...this.#known.values()];
  }

  get(id: string): EndpointConn | undefined {
    return this.#conns.get(id);
  }

  /** 에이전트가 Hello 를 보내면 등록한다. 같은 id 의 기존 연결은 닫는다. */
  attach(hello: Hello): EndpointConn {
    const previous = this.#conns.get(hello.agentId);
    if (previous) this.detach(previous);

    const conn = new EndpointConn(hello);
    this.#conns.set(hello.agentId, conn);
    const info = this.#toInfo(hello, true);
    this.#known.set(hello.agentId, info);
    this.events.emit('online', info);
    return conn;
  }

  /** 연결을 닫고 대기 중인 요청을 모두 EndpointOfflineError 로 reject 한다. */
  detach(conn: EndpointConn): void {
    const id = conn.hello.agentId;
    if (this.#conns.get(id) !== conn) {
      conn.outbox.close();
      return;
    }
    this.#conns.delete(id);
    conn.outbox.close();
    for (const p of conn.pending.values()) p.reject(new EndpointOfflineError(id));
    conn.pending.clear();
    const info = { ...this.#known.get(id)!, online: false, lastSeen: new Date(conn.lastRecv) };
    this.#known.set(id, info);
    this.events.emit('offline', info);
  }

  /** 에이전트 응답을 대기 중인 요청과 짝지어 처리한다. */
  resolveResponse(conn: EndpointConn, res: Response): void {
    const p = conn.pending.get(res.requestId);
    if (!p) return; // 이미 타임아웃·취소된 요청
    conn.pending.delete(res.requestId);
    if (res.error) p.reject(new AgentRequestError(res.error.code, res.error.message));
    else p.resolve(res);
  }

  request(id: string, op: RequestOp, opts: RequestOpts = {}): Promise<Response> {
    const conn = this.#conns.get(id);
    if (!conn) return Promise.reject(new EndpointOfflineError(id));
    if (opts.signal?.aborted) return Promise.reject(opts.signal.reason);

    const requestId = randomUUID();
    return new Promise<Response>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        cleanup();
        conn.send(
          create(ServerMessageSchema, {
            msg: {
              case: 'request',
              value: { requestId: randomUUID(), op: { case: 'cancel', value: { targetRequestId: requestId } } },
            },
          }),
        );
        reject(opts.signal!.reason);
      };
      const cleanup = () => {
        conn.pending.delete(requestId);
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      };

      conn.pending.set(requestId, {
        resolve: (res) => {
          cleanup();
          resolve(res);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          cleanup();
          reject(new RequestTimeoutError(opts.timeoutMs!));
        }, opts.timeoutMs);
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      conn.send(
        create(ServerMessageSchema, {
          msg: { case: 'request', value: create(RequestSchema, { requestId, op }) },
        }),
      );
    });
  }

  #toInfo(hello: Hello, online: boolean): EndpointInfo {
    return {
      id: hello.agentId,
      os: hello.os,
      arch: hello.arch,
      hostname: hello.hostname,
      homeDir: hello.homeDir,
      defaultShell: hello.defaultShell,
      agentVersion: hello.agentVersion,
      online,
      lastSeen: new Date(),
    };
  }
}
