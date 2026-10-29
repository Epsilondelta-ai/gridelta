import { Code, ConnectError } from '@connectrpc/connect';
import { consoleClient, sleep } from './api.ts';
import { randomId } from './random.ts';

const INPUT_BATCH_MS = 16;
const RESIZE_DEBOUNCE_MS = 100;

export interface TerminalSink {
  write(data: Uint8Array): void;
  reset(): void;
  exited(code: number): void;
  status(s: 'connecting' | 'live' | 'reconnecting' | 'gone'): void;
}

/**
 * 서버 PTY 세션 하나에 붙는 클라이언트 쪽 상태.
 * 출력: AttachTerminal 서버 스트림. 끊기면 받은 마지막 seq + 1 로 다시 붙는다.
 *   보이는 탭만 스트림을 연다(resume/pause). HTTP/1.1 에서는 브라우저가 서버당 연결을 6개까지만 열어서,
 *   숨긴 탭까지 스트림을 붙잡으면 입력과 새로고침 요청이 빈 연결을 끝없이 기다리게 된다.
 * 입력: 16 ms 동안 모아 SendInput(unary) 을 직렬로 보낸다. input_seq 로 재시도 중복을 서버가 걸러 낸다.
 */
export class TerminalSession {
  #nextSeq = 0n;
  #inputSeq = 0n;
  /** 이 탭의 입력 id. 서버는 (client_id, input_seq) 로 재시도 중복을 거른다 */
  #clientId = randomId();
  #pending: Uint8Array[] = [];
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #sending = false;
  #resizeTimer: ReturnType<typeof setTimeout> | undefined;
  #abort: AbortController | undefined;
  #exited = false;
  #disposed = false;
  #encoder = new TextEncoder();
  #lastInputAt = 0;

  /** 키를 누른 뒤 첫 출력이 오기까지 걸린 시간(ms). 최근 값부터 */
  readonly latencies: number[] = [];

  constructor(
    readonly sessionId: string,
    private readonly sink: TerminalSink,
  ) {}

  /** 출력 스트림을 연다. 멈춰 있던 동안의 출력은 서버 링버퍼에서 이어 받는다 */
  resume(): void {
    if (this.#abort || this.#exited || this.#disposed) return;
    this.#abort = new AbortController();
    void this.#attachLoop(this.#abort.signal);
  }

  /** 출력 스트림만 닫는다. 화면(xterm)과 seq 는 그대로 둔다 */
  pause(): void {
    this.#abort?.abort();
    this.#abort = undefined;
  }

  async #attachLoop(signal: AbortSignal): Promise<void> {
    this.sink.status('connecting');
    let delay = 500;
    while (!signal.aborted) {
      try {
        for await (const out of consoleClient.attachTerminal(
          { sessionId: this.sessionId, fromSeq: this.#nextSeq },
          { signal },
        )) {
          this.sink.status('live');
          delay = 500;
          if (out.exitCode !== undefined) {
            this.#exited = true;
            this.sink.exited(out.exitCode);
            return;
          }
          if (out.reset) this.sink.reset();
          if (out.data.length > 0) {
            if (this.#lastInputAt) {
              this.latencies.unshift(performance.now() - this.#lastInputAt);
              this.latencies.length = Math.min(this.latencies.length, 50);
              this.#lastInputAt = 0;
            }
            this.sink.write(out.data);
          }
          this.#nextSeq = out.seq + 1n;
        }
      } catch (err) {
        if (signal.aborted) return;
        if (ConnectError.from(err).code === Code.NotFound) {
          this.sink.status('gone');
          return;
        }
      }
      if (signal.aborted) return;
      this.sink.status('reconnecting');
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
    }
  }

  input(data: string): void {
    // 체감 지연(키 입력 → 에코)을 재기 위해 묶기 전 시각을 기록한다
    this.#lastInputAt ||= performance.now();
    this.#pending.push(this.#encoder.encode(data));
    this.#flushTimer ??= setTimeout(() => {
      this.#flushTimer = undefined;
      void this.#flush();
    }, INPUT_BATCH_MS);
  }

  async #flush(): Promise<void> {
    if (this.#sending || this.#pending.length === 0) return;
    this.#sending = true;
    const parts = this.#pending.splice(0);
    const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      data.set(p, offset);
      offset += p.length;
    }
    const inputSeq = this.#inputSeq++;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await consoleClient.sendInput({ sessionId: this.sessionId, clientId: this.#clientId, inputSeq, data });
          break;
        } catch (err) {
          const code = ConnectError.from(err).code;
          if (code === Code.NotFound || attempt >= 5 || this.#disposed) return;
          await sleep(200 * 2 ** attempt);
        }
      }
    } finally {
      this.#sending = false;
      if (this.#pending.length > 0) void this.#flush();
    }
  }

  resize(cols: number, rows: number): void {
    clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => {
      void consoleClient.resizeTerminal({ sessionId: this.sessionId, cols, rows }).catch(() => {});
    }, RESIZE_DEBOUNCE_MS);
  }

  /** 화면에서 떼기만 한다 (세션은 서버에 남는다). */
  detach(): void {
    this.#disposed = true;
    this.pause();
    clearTimeout(this.#flushTimer);
    clearTimeout(this.#resizeTimer);
  }
}
