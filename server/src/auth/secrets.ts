import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 현재 암호화 키 버전. 마스터 키를 바꾸면 올리고, 이전 버전 키로 복호화 후 다시 암호화한다 */
export const KEY_VERSION = 1;

/**
 * 마스터 키: GRIDELTA_MASTER_KEY(base64, 32바이트) 또는 데이터 디렉터리의 master.key.
 * 둘 다 없으면 master.key 를 새로 만든다 (0600). 이 파일을 잃으면 저장한 OAuth 토큰을 복호화할 수 없다.
 */
export function loadMasterKey(keyPath: string, fromEnv = process.env.GRIDELTA_MASTER_KEY): Buffer {
  if (fromEnv) return checkKey(Buffer.from(fromEnv, 'base64'));
  if (existsSync(keyPath)) return checkKey(Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64'));
  mkdirSync(dirname(keyPath), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  return key;
}

function checkKey(key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('master key must be 32 bytes (base64)');
  return key;
}

/** 용도별 키를 HKDF 로 파생해 마스터 키를 직접 쓰지 않는다 */
function deriveKey(master: Buffer, version: number): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `gridelta oauth v${version}`, 32));
}

/** AES-256-GCM. 결과는 base64(iv 12B | tag 16B | ciphertext). aad 로 행(provider)에 묶는다 */
export function encrypt(master: Buffer, plaintext: string, aad: string, version = KEY_VERSION): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(master, version), iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decrypt(master: Buffer, sealed: string, aad: string, version = KEY_VERSION): string {
  const buf = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(master, version), buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
