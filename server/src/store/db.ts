import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';

export type Db = ReturnType<typeof openDb>;

/** SQLite 를 열고 마이그레이션을 적용한다. path 가 ':memory:' 면 테스트용 메모리 DB. */
export function openDb(path: string, migrationsFolder: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = drizzle({ connection: { path } });
  db.$client.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const result = migrate(db, { migrationsFolder });
  if (result) throw new Error(`database migration failed: ${JSON.stringify(result)}`);
  return db;
}
