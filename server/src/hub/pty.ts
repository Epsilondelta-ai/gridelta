import { randomUUID } from 'node:crypto';
import { AsyncQueue } from './async-queue.ts';

/** 세션별 출력 링버퍼 크기. 넘치면 오래된 청크부터 버린다. */
export const RING_BUFFER_BYTES = 256 * 1024;
/** 구독자 없이 이만큼 지나면 세션을 닫는다. */
export const IDLE_SESSION_MS = 30 * 60 * 1000;
/** 셸이 끝난 세션을 목록에 남겨 두는 시간 (재접속한 탭이 종료 코드를 볼 수 있게) */
export const EXITED_RETENTION_MS = 60 * 1000;
const MAX_INPUT_CLIENTS = 32;

export interface Chunk {
  seq: bigint;
  data: Uint8Array;
}

/** 구독자에게 보내는 이벤트. TerminalOutput 메시지와 1:1 이다. */
export type PtyEvent =
  | { kind: 'output'; seq: bigint; data: Uint8Array; reset: boolean }
  | { kind: 'exit'; seq: bigint; exitCode: number };

/** 서버 쪽 PTY 세션. 출력은 seq 와 함께 링버퍼에 쌓고, 구독자(브라우저 탭)마다 큐로 흘려보낸다. */
export class PtySession {
  readonly id = randomUUID();
  readonly createdAt = new Date();
  exitCode: number | undefined;

  #chunks: Chunk[] = [];
  #bytes = 0;
  #nextSeq = 0n;
  /** 입력을 보내는 탭(client_id)별 마지막 input_seq. 탭이 바뀌면 seq 가 0 부터 다시 시작하므로 따로 센다 */
  #lastInputSeq = new Map<string, bigint>();
  #subscribers = new Set<AsyncQueue<PtyEvent>>();
  #idleTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly endpointId: string,
    public cols: number,
    public rows: number,
    private readonly onIdle: (s: PtySession) => void,
  ) {
    this.#armIdleTimer();
  }

  get exited(): boolean {
    return this.exitCode !== undefined;
  }

  get nextSeq(): bigint {
    return this.#nextSeq;
  }

  /** 에이전트에서 받은 출력을 버퍼에 넣고 구독자에게 보낸다. */
  pushOutput(data: Uint8Array): void {
    if (this.exited || data.length === 0) return;
    const chunk = { seq: this.#nextSeq++, data };
    this.#chunks.push(chunk);
    this.#bytes += data.length;
    while (this.#bytes > RING_BUFFER_BYTES && this.#chunks.length > 1) {
      this.#bytes -= this.#chunks.shift()!.data.length;
    }
    for (const q of this.#subscribers) q.push({ kind: 'output', seq: chunk.seq, data, reset: false });
  }

  /** 셸 종료. 구독자에게 종료 코드를 보내고 스트림을 끝낸다. */
  markExited(exitCode: number): void {
    if (this.exited) return;
    this.exitCode = exitCode;
    for (const q of this.#subscribers) {
      q.push({ kind: 'exit', seq: this.#nextSeq, exitCode });
      q.close();
    }
    this.#subscribers.clear();
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.onIdle(this), EXITED_RETENTION_MS);
    this.#idleTimer.unref();
  }

  /**
   * 구독을 시작한다. from_seq 부터 버퍼에 남은 출력을 먼저 보내고 실시간 출력을 이어 보낸다.
   * from_seq 가 이미 밀려났거나 미래 값이면 reset 을 붙여 남은 가장 오래된 청크부터 보낸다.
   * 반환값의 needsRedraw 가 true 면 호출자가 화면을 다시 그리게(SIGWINCH) 해야 한다.
   */
  subscribe(fromSeq: bigint): { events: AsyncQueue<PtyEvent>; needsRedraw: boolean } {
    const q = new AsyncQueue<PtyEvent>();
    const oldest = this.#chunks[0]?.seq ?? this.#nextSeq;
    const gap = fromSeq < oldest || fromSeq > this.#nextSeq;
    const start = gap ? oldest : fromSeq;

    let first = true;
    for (const c of this.#chunks) {
      if (c.seq < start) continue;
      q.push({ kind: 'output', seq: c.seq, data: c.data, reset: gap && first });
      first = false;
    }
    if (gap && first) q.push({ kind: 'output', seq: this.#nextSeq, data: new Uint8Array(), reset: true });

    if (this.exited) {
      q.push({ kind: 'exit', seq: this.#nextSeq, exitCode: this.exitCode! });
      q.close();
      return { events: q, needsRedraw: false };
    }
    this.#subscribers.add(q);
    clearTimeout(this.#idleTimer);
    return { events: q, needsRedraw: gap && fromSeq > 0n };
  }

  unsubscribe(q: AsyncQueue<PtyEvent>): void {
    this.#subscribers.delete(q);
    q.close();
    if (this.#subscribers.size === 0 && !this.exited) this.#armIdleTimer();
  }

  /** 이미 처리한 입력이면 false (재시도로 온 중복). 처리할 입력이면 true. */
  acceptInput(clientId: string, inputSeq: bigint): boolean {
    const last = this.#lastInputSeq.get(clientId) ?? -1n;
    if (inputSeq <= last) return false;
    // 오래된 탭 기록이 쌓이지 않도록 최근에 입력한 탭만 남긴다
    this.#lastInputSeq.delete(clientId);
    this.#lastInputSeq.set(clientId, inputSeq);
    if (this.#lastInputSeq.size > MAX_INPUT_CLIENTS) this.#lastInputSeq.delete(this.#lastInputSeq.keys().next().value!);
    return true;
  }

  dispose(): void {
    clearTimeout(this.#idleTimer);
    for (const q of this.#subscribers) q.close();
    this.#subscribers.clear();
  }

  #armIdleTimer(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.onIdle(this), IDLE_SESSION_MS);
    this.#idleTimer.unref();
  }
}
