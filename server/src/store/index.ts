import { config } from '../config.ts';
import { openDb } from './db.ts';
import { Store } from './store.ts';

export * from './store.ts';

// Vite 개발 모드 재로드에도 연결 하나만 유지한다
const g = globalThis as { __grideltaStore?: Store };
export const store: Store = (g.__grideltaStore ??= new Store(openDb(config.dbPath, config.migrationsDir)));
