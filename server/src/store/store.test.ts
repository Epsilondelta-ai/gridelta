import { resolve } from 'node:path';
import { verify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from './db.ts';
import { users } from './schema.ts';
import { NameTakenError, Store, UsernameTakenError } from './store.ts';

let store: Store;

beforeEach(() => {
  store = new Store(openDb(':memory:', resolve(import.meta.dirname, '../../drizzle')));
});

describe('enroll tokens', () => {
  it('can be used exactly once by default and returns the target group', async () => {
    const { token } = await store.createEnrollToken(60_000);
    expect(await store.consumeEnrollToken(token)).toBe('default');
    expect(await store.consumeEnrollToken(token)).toBeUndefined();
  });

  it('cannot be used after expiry or revocation', async () => {
    const now = Date.now();
    const { token } = await store.createEnrollToken(1_000, {}, now);
    expect(await store.consumeEnrollToken(token, now + 2_000)).toBeUndefined();
    const second = await store.createEnrollToken(60_000);
    expect(await store.revokeEnrollToken(second.tokenHash)).toBe(true);
    expect(await store.consumeEnrollToken(second.token)).toBeUndefined();
  });

  it('allows max_uses PCs, or unlimited with 0, and is listed until exhausted', async () => {
    const group = await store.createGroup('dev');
    const twice = await store.createEnrollToken(60_000, { groupId: group.id, maxUses: 2 });
    expect(await store.consumeEnrollToken(twice.token)).toBe(group.id);
    expect((await store.listEnrollTokens(group.id)).map((t) => t.uses)).toEqual([1]);
    expect(await store.consumeEnrollToken(twice.token)).toBe(group.id);
    expect(await store.consumeEnrollToken(twice.token)).toBeUndefined();
    expect(await store.listEnrollTokens(group.id)).toEqual([]);

    const unlimited = await store.createEnrollToken(60_000, { maxUses: 0 });
    for (let i = 0; i < 5; i++) expect(await store.consumeEnrollToken(unlimited.token)).toBe('default');
  });

  it('rejects unknown tokens', async () => {
    expect(await store.consumeEnrollToken('nope')).toBeUndefined();
  });
});

describe('groups', () => {
  it('moves PCs back to the default group and revokes tokens when deleted', async () => {
    const g = await store.createGroup('ops');
    await expect(store.createGroup('ops')).rejects.toBeInstanceOf(NameTakenError);
    const { id } = await store.enrollEndpoint({ hostname: 'h', os: 'linux', arch: 'arm64' }, g.id);
    const { token } = await store.createEnrollToken(60_000, { groupId: g.id, maxUses: 0 });
    expect((await store.listGroups()).find((x) => x.id === g.id)?.endpointCount).toBe(1);

    expect(await store.deleteGroup(g.id)).toBe(true);
    expect((await store.getEndpoint(id))?.groupId).toBe('default');
    expect(await store.consumeEnrollToken(token)).toBeUndefined();
    await expect(store.deleteGroup('default')).rejects.toThrow();
  });

  it('finds groups by id or name and renames them', async () => {
    const g = await store.createGroup('a');
    expect((await store.findGroup('a'))?.id).toBe(g.id);
    expect(await store.renameGroup(g.id, 'b')).toBe(true);
    expect((await store.findGroup(g.id))?.name).toBe('b');
    expect((await store.findGroup('기본'))?.id).toBe('default');
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
