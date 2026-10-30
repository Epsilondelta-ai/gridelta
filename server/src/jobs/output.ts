/** PC 하나당 회차마다 보관하는 출력 상한 (설계 14.3) */
export const OUTPUT_LIMIT_BYTES = 64 * 1024;
/** 상태 기록 값(JSON) 하나의 상한 (설계 14.5) */
export const RECORD_VALUE_LIMIT_BYTES = 64 * 1024;

/** stdout 과 stderr 를 합쳐 64 KB 까지 남긴다. 넘으면 앞 32 KB 와 뒤 32 KB 를 남기고 가운데를 표시로 바꾼다 */
export function keepOutput(stdout: string, stderr: string): { output: string; truncated: boolean } {
  const full = stderr ? `${stdout}${stdout && !stdout.endsWith('\n') ? '\n' : ''}--- stderr ---\n${stderr}` : stdout;
  const buf = Buffer.from(full);
  if (buf.length <= OUTPUT_LIMIT_BYTES) return { output: full, truncated: false };
  const half = OUTPUT_LIMIT_BYTES / 2;
  const omitted = buf.length - OUTPUT_LIMIT_BYTES;
  const output = `${buf.subarray(0, half).toString()}\n… ${omitted} 바이트 생략 …\n${buf.subarray(buf.length - half).toString()}`;
  return { output, truncated: true };
}

export type RecordParse = 'json' | 'kv' | 'text';

export class RecordParseError extends Error {}

/**
 * 명령 출력을 상태 기록(이름 → JSON 문자열)으로 바꾼다 (설계 14.2).
 * - json: 출력 전체가 JSON 하나 → `name`
 * - kv: 한 줄에 하나씩 `key=value` → `name.key`. 값은 JSON 으로 읽히면(숫자·true·"문자열"·{…}) 그대로, 아니면 문자열
 * - text: 출력 전체(앞뒤 공백 제거)를 문자열로 → `name`
 */
export function parseRecords(name: string, parse: RecordParse, stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  const add = (key: string, value: unknown) => {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > RECORD_VALUE_LIMIT_BYTES) throw new RecordParseError(`${key}: 값이 64 KB 를 넘습니다`);
    out.set(key, json);
  };
  switch (parse) {
    case 'json': {
      try {
        add(name, JSON.parse(stdout.trim()));
      } catch (err) {
        if (err instanceof RecordParseError) throw err;
        throw new RecordParseError('출력이 JSON 이 아닙니다');
      }
      break;
    }
    case 'kv': {
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9_][\w.-]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        const [, key, raw] = m as unknown as [string, string, string];
        let value: unknown = raw;
        try {
          value = JSON.parse(raw);
        } catch {
          // JSON 이 아니면 문자열 그대로
        }
        add(`${name}.${key}`, value);
      }
      if (out.size === 0) throw new RecordParseError('key=value 줄이 없습니다');
      break;
    }
    case 'text':
      add(name, stdout.trim());
      break;
  }
  return out;
}
