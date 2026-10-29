import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { create } from '@bufbuild/protobuf';
import {
  type Hello,
  PtyCloseRequestSchema,
  PtyOpenRequestSchema,
  type Request,
  RequestSchema,
  type Response,
  type ServerMessage,
  ServerMessageSchema,
} from '@gridelta/proto/gateway';
import { AsyncQueue } from './async-queue.ts';
import { PtySession } from './pty.ts';

export const PING_INTERVAL_MS = 15_000;
export const IDLE_TIMEOUT_MS = 45_000;
/** 에이전트가 끊긴 뒤 이 시간 안에 돌아오지 않으면 그 PC 의 터미널 세션을 종료 처리한다 (에이전트 쪽과 같은 값) */
export const PTY_GRACE_MS = 30_000;

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
  'pty-open': [PtySession];
  'pty-exit': [PtySession];
  /** 이름 등 DB 의 PC 정보가 바뀜 (WatchEndpoints 가 다시 보낸다) */
  changed: [{ id: string }];
};

/** 터미널 세션이 없거나 이미 종료됐다. */
export class PtyNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`terminal session ${sessionId} not found`);
    this.name = 'PtyNotFoundError';
  }
}

/** 모든 원격 작업이 거쳐 가는 연결 레지스트리. */
export class AgentHub {
  readonly events = new EventEmitter<HubEvents>();
  readonly #conns = new Map<string, EndpointConn>();
  readonly #known = new Map<string, EndpointInfo>();
  readonly #ptys = new Map<string, PtySession>();
  readonly #graceTimers = new Map<string, NodeJS.Timeout>();

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

    // 에이전트에 없는 세션(에이전트 재시작 등)은 종료 처리한다
    clearTimeout(this.#graceTimers.get(hello.agentId));
    this.#graceTimers.delete(hello.agentId);
    const alive = new Set(hello.ptySessionIds);
    for (const pty of this.#ptys.values()) {
      if (pty.endpointId === hello.agentId && !pty.exited && !alive.has(pty.id)) this.#exitPty(pty, -1);
    }

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

    // 잠깐 끊긴 것이면 터미널을 이어 쓸 수 있도록 유예한다
    clearTimeout(this.#graceTimers.get(id));
    this.#graceTimers.set(
      id,
      setTimeout(() => {
        this.#graceTimers.delete(id);
        for (const pty of this.#ptys.values()) if (pty.endpointId === id && !pty.exited) this.#exitPty(pty, -1);
      }, PTY_GRACE_MS),
    );

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

  // --- 터미널 ---

  async openPty(endpointId: string, cols: number, rows: number): Promise<PtySession> {
    const pty = new PtySession(endpointId, cols, rows, (p) => this.#removePty(p));
    this.#ptys.set(pty.id, pty);
    try {
      await this.request(
        endpointId,
        { case: 'ptyOpen', value: create(PtyOpenRequestSchema, { sessionId: pty.id, cols, rows }) },
        { timeoutMs: 15_000 },
      );
    } catch (err) {
      this.#removePty(pty);
      throw err;
    }
    this.events.emit('pty-open', pty);
    return pty;
  }

  getPty(sessionId: string): PtySession {
    const pty = this.#ptys.get(sessionId);
    if (!pty) throw new PtyNotFoundError(sessionId);
    return pty;
  }

  listPtys(endpointId?: string): PtySession[] {
    return [...this.#ptys.values()].filter((p) => !endpointId || p.endpointId === endpointId);
  }

  /** 에이전트가 보낸 PTY 출력. 다른 PC 의 세션 id 는 무시한다. */
  ptyOutput(conn: EndpointConn, sessionId: string, data: Uint8Array): void {
    const pty = this.#ptys.get(sessionId);
    if (pty?.endpointId === conn.hello.agentId) pty.pushOutput(data);
  }

  ptyExit(conn: EndpointConn, sessionId: string, exitCode: number): void {
    const pty = this.#ptys.get(sessionId);
    if (pty?.endpointId === conn.hello.agentId) this.#exitPty(pty, exitCode);
  }

  sendPtyInput(sessionId: string, clientId: string, inputSeq: bigint, data: Uint8Array): void {
    const pty = this.getPty(sessionId);
    if (pty.exited) throw new PtyNotFoundError(sessionId);
    const conn = this.#conns.get(pty.endpointId);
    if (!conn) throw new EndpointOfflineError(pty.endpointId);
    if (!pty.acceptInput(clientId, inputSeq)) return;
    conn.send(create(ServerMessageSchema, { msg: { case: 'ptyInput', value: { sessionId, data } } }));
  }

  resizePty(sessionId: string, cols: number, rows: number): void {
    const pty = this.getPty(sessionId);
    pty.cols = cols;
    pty.rows = rows;
    this.#conns
      .get(pty.endpointId)
      ?.send(create(ServerMessageSchema, { msg: { case: 'ptyResize', value: { sessionId, cols, rows } } }));
  }

  /** 크기를 한 줄 줄였다 되돌려 SIGWINCH 를 일으킨다. 전체 화면 프로그램이 화면을 다시 그린다. */
  redrawPty(sessionId: string): void {
    const pty = this.getPty(sessionId);
    const conn = this.#conns.get(pty.endpointId);
    if (!conn || pty.rows < 2) return;
    const resize = (rows: number) =>
      conn.send(create(ServerMessageSchema, { msg: { case: 'ptyResize', value: { sessionId, cols: pty.cols, rows } } }));
    resize(pty.rows - 1);
    setTimeout(() => resize(pty.rows), 50);
  }

  renamePty(sessionId: string, title: string): void {
    this.getPty(sessionId).title = title;
  }

  async closePty(sessionId: string): Promise<void> {
    const pty = this.getPty(sessionId);
    if (pty.exited) {
      this.#removePty(pty);
      return;
    }
    try {
      await this.request(pty.endpointId, { case: 'ptyClose', value: create(PtyCloseRequestSchema, { sessionId }) }, { timeoutMs: 10_000 });
    } catch {
      // 에이전트가 없거나 이미 끝난 세션이면 서버 쪽에서 정리한다
      this.#exitPty(pty, -1);
    }
  }

  #exitPty(pty: PtySession, exitCode: number): void {
    if (pty.exited) return;
    pty.markExited(exitCode);
    this.events.emit('pty-exit', pty);
  }

  #removePty(pty: PtySession): void {
    pty.dispose();
    this.#ptys.delete(pty.id);
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
