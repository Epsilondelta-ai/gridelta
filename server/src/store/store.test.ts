import { resolve } from 'node:path';
import { verify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from './db.ts';
import { users } from './schema.ts';
import { Store, UsernameTakenError } from './store.ts';

let store: Store;

beforeEach(() => {
  store = new Store(openDb(':memory:', resolve(import.meta.dirname, '../../drizzle')));
});

describe('enroll tokens', () => {
  it('can be used exactly once', async () => {
    const { token } = await store.createEnrollToken(60_000);
    expect(await store.consumeEnrollToken(token)).toBe(true);
    expect(await store.consumeEnrollToken(token)).toBe(false);
  });

  it('cannot be used after expiry', async () => {
    const now = Date.now();
    const { token } = await store.createEnrollToken(1_000, now);
    expect(await store.consumeEnrollToken(token, now + 2_000)).toBe(false);
  });

  it('rejects unknown tokens', async () => {
    expect(await store.consumeEnrollToken('nope')).toBe(false);
  });
});

describe('endpoints', () => {
  it('authenticates with the issued credential until revoked', async () => {
    const { id, credential } = await store.enrollEndpoint({ hostname: 'h', os: 'linux', arch: 'arm64' });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((await store.authenticateEndpoint(id, credential))?.hostname).toBe('h');
    expect(await store.authenticateEndpoint(id, 'wrong')).toBeUndefined();

    expect(await store.revokeEndpoint(id)).toBe(true);
    expect(await store.revokeEndpoint(id)).toBe(false);
    expect(await store.authenticateEndpoint(id, credential)).toBeUndefined();
  });

  it('stores the latest Hello info', async () => {
    const { id } = await store.enrollEndpoint({ hostname: 'h', os: 'linux', arch: 'arm64' });
    await store.updateFromHello(id, {
      hostname: 'h2',
      os: 'linux',
      arch: 'arm64',
      homeDir: '/root',
      defaultShell: '/bin/bash',
      agentVersion: '0.1.0',
    });
    const row = await store.getEndpoint(id);
    expect(row?.homeDir).toBe('/root');
    expect(row?.lastSeen).toBeInstanceOf(Date);
  });
});

describe('users', () => {
  it('stores an argon2 hash and rejects duplicate usernames', async () => {
    await store.createUser('admin', 'pw-123456');
    const [row] = await store.db.select().from(users).where(eq(users.username, 'admin'));
    expect(row?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await verify(row!.passwordHash, 'pw-123456')).toBe(true);
    await expect(store.createUser('admin', 'x')).rejects.toBeInstanceOf(UsernameTakenError);
  });
});
