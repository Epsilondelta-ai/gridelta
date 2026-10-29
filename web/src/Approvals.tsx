import type { Approval } from '@gridelta/proto/console';
import { useEffect, useState } from 'react';
import { consoleClient, isUnauthenticated, sleep } from './api.ts';

/** AI 가 요청한 위험 명령의 승인 대기열. 어느 PC 를 보고 있든 항상 보인다. */
export function Approvals({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [pending, setPending] = useState<Map<string, Approval>>(new Map());
  const [busy, setBusy] = useState<string>('');

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      while (!ac.signal.aborted) {
        try {
          setPending(new Map());
          for await (const ev of consoleClient.watchApprovals({}, { signal: ac.signal })) {
            const a = ev.approval;
            if (!a) continue;
            setPending((prev) => {
              const next = new Map(prev);
              if (a.status === 'pending') next.set(a.id, a);
              else next.delete(a.id);
              return next;
            });
          }
        } catch (err) {
          if (ac.signal.aborted) return;
          if (isUnauthenticated(err)) return onLoggedOut();
        }
        await sleep(1000);
      }
    })();
    return () => ac.abort();
  }, [onLoggedOut]);

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    try {
      await consoleClient.decideApproval({ id, approve });
    } catch {
      // 이미 결정·만료된 요청이면 스트림이 목록을 정리한다
    } finally {
      setBusy('');
    }
  }

  if (pending.size === 0) return null;
  return (
    <section aria-label="승인 대기" className="space-y-2 border-b border-line bg-panel p-3">
      {[...pending.values()].map((a) => (
        <div key={a.id} className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm" data-testid="approval">
          <p className="mb-1 text-xs text-muted">AI 가 {a.hostname || a.endpointId}에서 실행하려고 합니다</p>
          <pre className="mb-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">{a.command}</pre>
          <div className="flex gap-2">
            <button type="button" disabled={busy === a.id} onClick={() => void decide(a.id, true)} className="btn-primary">
              승인
            </button>
            <button
              type="button"
              disabled={busy === a.id}
              onClick={() => void decide(a.id, false)}
              className="rounded-md border border-line px-3 py-2 text-sm"
            >
              거부
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
