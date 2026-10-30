import { hub } from '../hub/index.ts';
import { jobStore, store } from '../store/index.ts';
import { Scheduler } from './scheduler.ts';

export * from './scheduler.ts';

const g = globalThis as { __grideltaScheduler?: Scheduler };
export const scheduler: Scheduler = (g.__grideltaScheduler ??= new Scheduler({ hub, store, jobs: jobStore }));
