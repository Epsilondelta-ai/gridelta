import { randomBytes } from 'node:crypto';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, loadMasterKey } from './secrets.ts';

describe('secrets', () => {
  const key = randomBytes(32);

  it('round-trips and binds ciphertext to its row', () => {
    const sealed = encrypt(key, '{"access":"a"}', 'openai-codex');
    expect(sealed).not.toContain('access');
    expect(decrypt(key, sealed, 'openai-codex')).toBe('{"access":"a"}');
    expect(() => decrypt(key, sealed, 'other-provider')).toThrow();
    expect(() => decrypt(randomBytes(32), sealed, 'openai-codex')).toThrow();
  });

  it('creates a 0600 master key file once and reuses it', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'gd-')), 'master.key');
    const a = loadMasterKey(path, undefined);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadMasterKey(path, undefined).equals(a)).toBe(true);
  });
});
