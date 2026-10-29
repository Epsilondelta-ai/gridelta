import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 등록 토큰·에이전트 자격 증명용 랜덤 토큰 (256비트, base64url). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 엔트로피가 충분한 토큰은 느린 해시 대신 SHA-256 으로 저장한다. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenMatches(token: string, hash: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** RFC 9562 UUIDv7: 앞 48비트가 밀리초 타임스탬프라 시간순 정렬된다. */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
