import type { ApprovalPolicy } from '../store/index.ts';

/**
 * AI 가 실행하려는 셸 명령을 분류한다. 완벽한 파서가 아니라 보수적인 휴리스틱이다:
 * 읽기 전용으로 확신할 수 없으면 "보통", 위험 패턴이 하나라도 보이면 "위험".
 */

// 파이프·연결로 이어진 각 명령이 모두 이 목록에 있고 출력 리디렉션이 없으면 읽기 전용
const READ_ONLY = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'ls', 'dir', 'pwd', 'echo', 'printf', 'whoami', 'id', 'hostname',
  'uname', 'date', 'uptime', 'df', 'du', 'free', 'ps', 'pgrep', 'stat', 'file', 'wc', 'sort', 'uniq', 'cut',
  'tr', 'grep', 'egrep', 'rg', 'which', 'type', 'env', 'printenv', 'lsblk', 'ip', 'ss', 'netstat', 'lscpu',
  'nproc', 'basename', 'dirname', 'realpath', 'readlink', 'md5sum', 'sha256sum', 'true', 'test',
  'get-childitem', 'get-content', 'get-item', 'get-process', 'get-service', 'get-location', 'get-date',
  'get-volume', 'get-psdrive', 'select-object', 'sort-object', 'where-object', 'measure-object',
  'format-table', 'format-list', 'select-string', 'write-output', 'test-path',
]);

const DANGEROUS: RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, // rm -r, rm -f, rm -rf
  /\brm\s+.*--(recursive|force)\b/i,
  /\bsudo\b/i,
  /\b(shutdown|reboot|poweroff|halt|init\s+[06])\b/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+.*\bof=/i,
  /\b(fdisk|parted|sfdisk|wipefs|diskpart|format(-volume)?)\b/i,
  /\bchmod\s+(-[a-z]*R|.*\s777\b)/i,
  /\bchown\s+-[a-z]*R/i,
  /\b(apt(-get)?|dnf|yum|zypper|pacman|apk|brew|choco|winget)\s+(remove|purge|erase|uninstall|autoremove|-R)/i,
  /\bsystemctl\s+(stop|disable|mask|kill)\b/i,
  /\bkill(all)?\s+-9\b/i,
  /\bcrontab\s+-r\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)\b/i,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  />\s*\/dev\/(sd|nvme|disk)/i,
  /\b(del|erase|rd|rmdir)\s+.*\/[sq]\b/i, // cmd.exe
  /\bremove-item\b.*-recurse/i,
  /\b(reg\s+(delete|add)|remove-itemproperty|set-itemproperty)\b/i,
  /\b(stop-computer|restart-computer|clear-disk|remove-partition)\b/i,
];

export type CommandRisk = 'read-only' | 'normal' | 'dangerous';

export function classifyCommand(command: string): CommandRisk {
  if (DANGEROUS.some((re) => re.test(command))) return 'dangerous';
  if (/[`$]\(|`/.test(command)) return 'normal'; // 명령 치환은 내용을 알 수 없다
  if (/(^|[^0-9&])>{1,2}(?!&)/.test(command.replaceAll(/2>&1|>\s*\/dev\/null/g, ''))) return 'normal';
  const segments = command.split(/\|\||&&|[|;\n]/).map((s) => s.trim()).filter(Boolean);
  const readOnly = segments.every((seg) => {
    const first = seg.replace(/^(\w+=\S+\s+)+/, '').split(/\s+/)[0]?.toLowerCase() ?? '';
    return READ_ONLY.has(first.replace(/^.*[\\/]/, ''));
  });
  return readOnly && segments.length > 0 ? 'read-only' : 'normal';
}

/** PC 정책과 명령 위험도로 승인이 필요한지 정한다 (설계 8.5). */
export function needsApproval(policy: ApprovalPolicy, command: string): boolean {
  if (policy === 'auto') return false;
  const risk = classifyCommand(command);
  if (risk === 'read-only') return false;
  return policy === 'always' || risk === 'dangerous';
}
