import { Cron } from 'croner';

export interface Schedule {
  /** cron 식 (5필드, 또는 초를 포함한 6필드). 비어 있으면 runAt 에 한 번만 */
  cron: string;
  runAt: Date | null;
  timezone: string;
}

export class InvalidScheduleError extends Error {}

/** IANA 시간대인지 */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 주기가 올바른지 검사한다. 틀리면 InvalidScheduleError */
export function validateSchedule(s: Schedule): void {
  if (!isValidTimezone(s.timezone)) throw new InvalidScheduleError(`알 수 없는 시간대입니다: ${s.timezone}`);
  if (s.cron) {
    try {
      new Cron(s.cron, { timezone: s.timezone, paused: true });
    } catch (err) {
      throw new InvalidScheduleError(`cron 식이 올바르지 않습니다: ${(err as Error).message}`);
    }
    return;
  }
  if (!s.runAt) throw new InvalidScheduleError('cron 식 또는 실행 일시가 필요합니다');
}

/** after 다음의 실행 시각. 더 이상 실행할 때가 없으면(지난 한 번만 실행) null */
export function nextRunAfter(s: Schedule, after: Date): Date | null {
  if (s.cron) return new Cron(s.cron, { timezone: s.timezone, paused: true }).nextRun(after) ?? null;
  return s.runAt && s.runAt > after ? s.runAt : null;
}
