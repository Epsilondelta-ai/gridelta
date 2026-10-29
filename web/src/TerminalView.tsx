import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { TerminalSession } from './terminal-session.ts';

export type TerminalStatus = 'connecting' | 'live' | 'reconnecting' | 'gone' | 'exited';

interface Props {
  sessionId: string;
  active: boolean;
  onStatus: (status: TerminalStatus, exitCode?: number) => void;
  onSession?: (session: TerminalSession | undefined) => void;
}

declare global {
  interface Window {
    /** e2e 테스트가 터미널 버퍼를 읽기 위한 훅 */
    __gridelta?: { terminals: Map<string, Terminal>; sessions: Map<string, TerminalSession> };
  }
}
const registry = (window.__gridelta ??= { terminals: new Map(), sessions: new Map() });

/** xterm.js 인스턴스 하나. 탭을 바꿔도 지우지 않고 숨겨 두어 스크롤백을 유지한다. */
export function TerminalView({ sessionId, active, onStatus, onSession }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon>(null);
  const termRef = useRef<Terminal>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  useEffect(() => {
    const term = new Terminal({
      allowProposedApi: true, // unicode11
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "D2Coding", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      scrollback: 10_000,
      theme: { background: '#0b0f14', foreground: '#d6dde6', cursor: '#7dd3fc', selectionBackground: '#334155' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(container.current!);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose()); // DOM 렌더러로 돌아간다
      term.loadAddon(webgl);
    } catch {
      // WebGL 이 없으면 DOM 렌더러
    }
    fitRef.current = fit;
    termRef.current = term;

    // 지난 출력을 다시 그리는 동안 xterm 이 터미널 질의에 자동으로 답한 것은 셸로 보내지 않는다
    let replaying = 0;
    const session = new TerminalSession(sessionId, {
      write: (data, replay) => {
        if (!replay) return term.write(data);
        replaying++;
        term.write(data, () => replaying--);
      },
      reset: () => term.reset(),
      exited: (code) => {
        term.write(`\r\n\x1b[2m[프로세스 종료: ${code}]\x1b[0m\r\n`);
        statusRef.current('exited', code);
      },
      status: (s) => statusRef.current(s),
    });
    const onData = term.onData((d) => {
      if (replaying === 0) session.input(d);
    });
    const onResize = term.onResize(({ cols, rows }) => session.resize(cols, rows));
    registry.terminals.set(sessionId, term);
    registry.sessions.set(sessionId, session);
    onSession?.(session);

    const observer = new ResizeObserver(() => {
      if (container.current?.offsetParent) fit.fit();
    });
    observer.observe(container.current!);

    return () => {
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      session.detach();
      registry.terminals.delete(sessionId);
      registry.sessions.delete(sessionId);
      onSession?.(undefined);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 보이는 탭만 출력 스트림을 연다 (TerminalSession 주석 참고). 숨기면 스트림만 닫고 화면은 남긴다
  useEffect(() => {
    const session = registry.sessions.get(sessionId);
    if (!active) {
      session?.pause();
      return;
    }
    session?.resume();
    // 보이게 된 뒤에 크기를 맞추고 포커스를 준다. 다른 입력칸(탭 이름 편집 등)에 포커스가 있으면 뺏지 않는다
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      const el = document.activeElement;
      const typing = el instanceof HTMLElement && el.matches('input, select, textarea:not(.xterm-helper-textarea)');
      if (!typing) termRef.current?.focus();
    });
  }, [active, sessionId]);

  return <div ref={container} className={`h-full w-full ${active ? '' : 'hidden'}`} data-session-id={sessionId} />;
}
