import type { Approval } from '@gridelta/proto/console';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { consoleClient, isUnauthenticated, sleep } from './api.ts';
import { describeSchedule } from './JobsView.tsx';

interface ApprovalState {
  pending: Approval[];
  busy: string;
  decide: (id: string, approve: boolean) => Promise<void>;
}

const ApprovalContext = createContext<ApprovalState>({ pending: [], busy: '', decide: async () => {} });

/** 승인 대기열을 한 번만 구독해 화면 위 대기열과 AI 대화 안의 카드가 함께 쓴다 */
export function ApprovalsProvider({ onLoggedOut, children }: { onLoggedOut: () => void; children: ReactNode }) {
  const [pending, setPending] = useState<Map<string, Approval>>(new Map());
  const [busy, setBusy] = useState('');

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

  const decide = useCallback(async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      await consoleClient.decideApproval({ id, approve });
    } catch {
      // 이미 결정·만료된 요청이면 스트림이 목록을 정리한다
    } finally {
      setBusy('');
    }
  }, []);

  return <ApprovalContext value={{ pending: [...pending.values()], busy, decide }}>{children}</ApprovalContext>;
}

export const useApprovals = () => useContext(ApprovalContext);

/** 승인 카드 하나: 명령 실행 또는 위험 명령이 든 잡 (설계 14.4) */
export function ApprovalCard({ approval: a, testId = 'approval' }: { approval: Approval; testId?: string }) {
  const { busy, decide } = useApprovals();
  const job = a.kind === 'job' ? a.job : undefined;
  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm" data-testid={testId} data-kind={a.kind || 'exec'}>
      {job ? (
        <>
          <p className="mb-1 text-xs text-muted">AI 가 위험 명령이 든 잡을 켜려고 합니다</p>
          <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted">잡</dt>
            <dd className="font-medium">{job.name}</dd>
            <dt className="text-muted">대상</dt>
            <dd>{a.targetName}</dd>
            <dt className="text-muted">주기</dt>
            <dd>
              {describeSchedule(job)} <span className="text-muted">({job.timezone})</span>
            </dd>
            {job.kind === 'ai' ? (
              <>
                <dt className="text-muted">지시</dt>
                <dd className="whitespace-pre-wrap">{job.aiPrompt}</dd>
              </>
            ) : (
              <>
                {job.commandUnix && (
                  <>
                    <dt className="text-muted">명령</dt>
                    <dd className="whitespace-pre-wrap break-all font-mono">{job.commandUnix}</dd>
                  </>
                )}
                {job.commandWindows && (
                  <>
                    <dt className="text-muted">Windows</dt>
                    <dd className="whitespace-pre-wrap break-all font-mono">{job.commandWindows}</dd>
                  </>
                )}
                {job.recordName && (
                  <>
                    <dt className="text-muted">상태 저장</dt>
                    <dd className="font-mono">{job.recordName}</dd>
                  </>
                )}
              </>
            )}
          </dl>
        </>
      ) : (
        <>
          <p className="mb-1 text-xs text-muted">AI 가 {a.hostname || a.endpointId}에서 실행하려고 합니다</p>
          <pre className="mb-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">{a.command}</pre>
        </>
      )}
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
  );
}

/** AI 가 요청한 위험 명령·잡의 승인 대기열. 어느 화면을 보고 있든 항상 보인다. */
export function Approvals() {
  const { pending } = useApprovals();
  if (pending.length === 0) return null;
  return (
    <section aria-label="승인 대기" className="space-y-2 border-b border-line bg-panel p-3">
      {pending.map((a) => (
        <ApprovalCard key={a.id} approval={a} />
      ))}
    </section>
  );
}
