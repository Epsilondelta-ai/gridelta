import { config } from '../config.ts';
import { openDb } from './db.ts';
import { JobStore } from './jobs.ts';
import { Store } from './store.ts';

export * from './jobs.ts';
export * from './store.ts';

// Vite 개발 모드 재로드에도 연결 하나만 유지한다
const g = globalThis as { __grideltaStore?: Store };
export const store: Store = (g.__grideltaStore ??= new Store(openDb(config.dbPath, config.migrationsDir)));

const gj = globalThis as { __grideltaJobStore?: JobStore };
export const jobStore: JobStore = (gj.__grideltaJobStore ??= new JobStore(store.db));
