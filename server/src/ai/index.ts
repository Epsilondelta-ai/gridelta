import { store } from '../store/index.ts';
import { ApprovalCenter } from './approvals.ts';

export * from './approvals.ts';

const g = globalThis as { __grideltaApprovals?: ApprovalCenter };
export const approvals: ApprovalCenter = (g.__grideltaApprovals ??= new ApprovalCenter(store));
