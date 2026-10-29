/** crypto.randomUUID 는 HTTPS(보안 컨텍스트)에서만 있으므로 getRandomValues 로 만든다 */
export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
