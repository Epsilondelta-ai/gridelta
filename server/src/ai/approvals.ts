import { EventEmitter } from 'node:events';
import type { ApprovalRow, Store } from '../store/index.ts';

/** 승인을 기다리는 최대 시간. 넘기면 거부와 같게 처리한다 (설계 8.5). */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export type ApprovalDecision = 'approved' | 'denied' | 'expired';

type Events = { change: [ApprovalRow] };

/** 잡 승인 카드에 보일 내용 (approvals.detail 에 JSON 으로 둔다). spec 은 proto JobSpec 과 같은 이름이다 */
export interface ApprovalJobDetail {
  spec: {
    name: string;
    kind: string;
    targetType: string;
    targetId: string;
    cron: string;
    runAtMs: number;
    timezone: string;
    commandUnix: string;
    commandWindows: string;
    aiPrompt: string;
    recordName: string;
    recordParse: string;
  };
  targetName: string;
}

/** AI 명령·잡 승인 대기열. 대기 중인 요청은 메모리에 두고, 기록은 approvals 테이블에 남긴다. */
export class ApprovalCenter {
  readonly events = new EventEmitter<Events>();
  readonly #pending = new Map<string, { row: ApprovalRow; resolve: (d: ApprovalDecision) => void }>();

  constructor(private readonly store: Store) {}

  pending(): ApprovalRow[] {
    return [...this.#pending.values()].map((p) => p.row);
  }

  /** 승인을 요청하고 결정될 때까지 기다린다. signal 이 abort 되면(대화 중단) 만료 처리한다. */
  async request(
    req: Pick<ApprovalRow, 'endpointId' | 'command' | 'requestedBy'> & Partial<Pick<ApprovalRow, 'kind' | 'detail'>>,
    signal?: AbortSignal,
  ): Promise<{ id: string; decision: ApprovalDecision }> {
    const row = await this.store.createApproval(req);
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => void this.#settle(row.id, 'expired'), APPROVAL_TIMEOUT_MS);
      const onAbort = () => void this.#settle(row.id, 'expired');
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(row.id, {
        row,
        resolve: (d) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(d);
        },
      });
      this.events.emit('change', row);
      if (signal?.aborted) onAbort();
    });
    return { id: row.id, decision };
  }

  /** 사람이 승인/거부한다. 이미 결정됐거나 없는 요청이면 false. */
  async decide(id: string, approve: boolean, userId?: string): Promise<boolean> {
    return this.#settle(id, approve ? 'approved' : 'denied', userId);
  }

  async #settle(id: string, decision: ApprovalDecision, userId?: string): Promise<boolean> {
    const p = this.#pending.get(id);
    if (!p) return false;
    this.#pending.delete(id);
    await this.store.decideApproval(id, decision, userId);
    p.resolve(decision);
    this.events.emit('change', { ...p.row, status: decision, decidedBy: userId ?? null, decidedAt: new Date() });
    return true;
  }
}
