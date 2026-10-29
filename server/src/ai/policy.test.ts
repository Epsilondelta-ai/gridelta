import { describe, expect, it } from 'vitest';
import { classifyCommand, needsApproval } from './policy.ts';

describe('classifyCommand', () => {
  it.each([
    'du -sh /usr/* 2>/dev/null | sort -rh | head -5',
    'ls -la /tmp',
    'cat /etc/os-release',
    'Get-ChildItem C:\\ | Sort-Object Length',
    'df -h && free -m',
  ])('read-only: %s', (cmd) => expect(classifyCommand(cmd)).toBe('read-only'));

  it.each([
    'rm -rf /tmp/x',
    'rm -r build',
    'sudo apt-get remove nginx',
    'shutdown -h now',
    'dd if=/dev/zero of=/dev/sda',
    'mkfs.ext4 /dev/sdb1',
    'del /s /q C:\\temp',
    'Remove-Item -Recurse C:\\temp',
    'reg delete HKLM\\Software\\X',
    'systemctl stop sshd',
    'echo ok; reboot',
  ])('dangerous: %s', (cmd) => expect(classifyCommand(cmd)).toBe('dangerous'));

  it.each(['echo hi > /etc/motd', 'mkdir /tmp/x', 'cat $(which foo)', 'python3 script.py', 'ls | xargs touch'])(
    'normal: %s',
    (cmd) => expect(classifyCommand(cmd)).toBe('normal'),
  );
});

describe('needsApproval', () => {
  it('follows the per-PC policy', () => {
    expect(needsApproval('dangerous', 'rm -rf /tmp/x')).toBe(true);
    expect(needsApproval('dangerous', 'mkdir /tmp/x')).toBe(false);
    expect(needsApproval('always', 'mkdir /tmp/x')).toBe(true);
    expect(needsApproval('always', 'ls /')).toBe(false);
    expect(needsApproval('auto', 'rm -rf /tmp/x')).toBe(false);
  });
});
