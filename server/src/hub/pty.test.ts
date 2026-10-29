import { describe, expect, it } from 'vitest';
import type { AsyncQueue } from './async-queue.ts';
import { type PtyEvent, PtySession, RING_BUFFER_BYTES } from './pty.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** 큐에 이미 들어 있는 이벤트만 꺼낸다 */
async function drain(q: AsyncQueue<PtyEvent>, n: number): Promise<PtyEvent[]> {
  const it = q[Symbol.asyncIterator]();
  const out: PtyEvent[] = [];
  for (let i = 0; i < n; i++) {
    const r = await it.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

const newSession = () => new PtySession('pc1', 80, 24, () => {});

describe('PtySession', () => {
  it('replays from from_seq and then streams live output', async () => {
    const s = newSession();
    s.pushOutput(bytes('a'));
    s.pushOutput(bytes('b'));
    const { events, needsRedraw } = s.subscribe(1n);
    s.pushOutput(bytes('c'));
    const got = await drain(events, 2);
    expect(got.map((e) => e.kind === 'output' && `${e.seq}:${text(e.data)}`)).toEqual(['1:b', '2:c']);
    expect(needsRedraw).toBe(false);
    s.dispose();
  });

  it('sends reset from the oldest chunk when from_seq was evicted', async () => {
    const s = newSession();
    const big = new Uint8Array(RING_BUFFER_BYTES / 2 + 1);
    s.pushOutput(big); // seq 0, 곧 밀려남
    s.pushOutput(big); // seq 1
    s.pushOutput(big); // seq 2
    const { events, needsRedraw } = s.subscribe(0n);
    const [first] = await drain(events, 1);
    expect(first).toMatchObject({ kind: 'output', reset: true });
    expect(first?.seq).toBeGreaterThan(0n);
    expect(needsRedraw).toBe(false); // 처음 붙는 탭(from_seq=0)은 다시 그릴 필요 없음
    s.dispose();
  });

  it('asks for a redraw when a reconnecting tab lost output', async () => {
    const s = newSession();
    for (let i = 0; i < 5; i++) s.pushOutput(new Uint8Array(RING_BUFFER_BYTES / 2));
    expect(s.subscribe(1n).needsRedraw).toBe(true);
    s.dispose();
  });

  it('treats a future from_seq (server restarted) as a gap', async () => {
    const s = newSession();
    s.pushOutput(bytes('x'));
    const [first] = await drain(s.subscribe(99n).events, 1);
    expect(first).toMatchObject({ kind: 'output', seq: 0n, reset: true });
    s.dispose();
  });

  it('delivers the exit code and ends subscriptions', async () => {
    const s = newSession();
    const { events } = s.subscribe(0n);
    s.markExited(3);
    expect(await drain(events, 5)).toEqual([{ kind: 'exit', seq: 0n, exitCode: 3 }]);
    s.dispose();
  });

  it('ignores duplicate input sequence numbers per client', () => {
    const s = newSession();
    expect(s.acceptInput('tab1', 0n)).toBe(true);
    expect(s.acceptInput('tab1', 0n)).toBe(false);
    expect(s.acceptInput('tab1', 1n)).toBe(true);
    // 새로고침한 탭은 seq 를 0 부터 다시 센다
    expect(s.acceptInput('tab2', 0n)).toBe(true);
    s.dispose();
  });
});
