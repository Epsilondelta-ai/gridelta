import { store } from '../store/index.ts';
import { config } from '../config.ts';
import { ApprovalCenter } from './approvals.ts';
import { AiModels } from './models.ts';

export * from './approvals.ts';
export * from './models.ts';

const g = globalThis as { __grideltaApprovals?: ApprovalCenter };
export const approvals: ApprovalCenter = (g.__grideltaApprovals ??= new ApprovalCenter(store));

const gm = globalThis as { __grideltaModels?: AiModels };
export const aiModels: AiModels = (gm.__grideltaModels ??= new AiModels(store, config.aiModel, config.aiFaux));
