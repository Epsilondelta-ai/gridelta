import type { Endpoint } from '@gridelta/proto/console';
import { type SubmitEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AiPanel } from './AiPanel.tsx';
import { NameInput } from './NameInput.tsx';
import { JobsView } from './JobsView.tsx';
import { PcList, pcName } from './PcList.tsx';
import { StatusView } from './StatusView.tsx';
import { consoleClient, fetchMe, isUnauthenticated, login, logout, sleep, type User } from './api.ts';
import { Approvals, ApprovalsProvider } from './Approvals.tsx';
import type { TerminalSession } from './terminal-session.ts';
import { type TerminalStatus, TerminalView } from './TerminalView.tsx';

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    void fetchMe().then((u) => setUser(u ?? null));
  }, []);

  if (user === undefined) return null;
  if (user === null) return <Login onLogin={setUser} />;
  return <Console user={user} onLoggedOut={() => setUser(null)} />;
}

function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      onLogin(await login(String(form.get('username')), String(form.get('password'))));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-panel p-6 shadow-sm">
        <h1 className="text-lg font-semibold">gridelta</h1>
        <label className="block space-y-1">
          <span className="text-sm text-muted">아이디</span>
          <input name="username" autoComplete="username" required className="field" />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-muted">비밀번호</span>
          <input name="password" type="password" autoComplete="current-password" required className="field" />
        </label>
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        <button type="submit" disabled={busy} className="btn-primary w-full">
          {busy ? '로그인 중…' : '로그인'}
        </button>
      </form>
    </main>
  );
}

interface Tab {
  sessionId: string;
  endpointId: string;
  /** 기본 이름 (터미널 N) */
  title: string;
  /** 사용자가 붙인 이름. 서버에 저장되어 새로고침 후에도 남는다 */
  customTitle: string;
  status: TerminalStatus;
  exitCode?: number;
}

function selectedFromUrl(): string {
  return new URLSearchParams(location.search).get('pc') ?? '';
}

function Console({ user, onLoggedOut }: { user: User; onLoggedOut: () => void }) {
  const [endpoints, setEndpoints] = useState<Map<string, Endpoint>>(new Map());
  const [selected, setSelected] = useState(selectedFromUrl);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<string>('');
  const [error, setError] = useState('');
  const sessions = useRef(new Map<string, TerminalSession>());
  const [latency, setLatency] = useState<number>();
  const [showAi, setShowAi] = useState(true);
  /** 가운데 화면: PC(터미널·상태) 또는 스케줄 */
  const [view, setView] = useState<'pc' | 'jobs'>('pc');
  /** 선택한 PC 화면에서 터미널과 상태 중 무엇을 보는지 */
  const [pane, setPane] = useState<'terminal' | 'status'>('terminal');
  /** 이름을 바꾸는 중인 터미널 세션 id */
  const [renaming, setRenaming] = useState('');
  /** AI 패널에서 열 세션 (스케줄 회차의 "대화 보기") */
  const [aiRequest, setAiRequest] = useState<{ id: string; n: number }>();

  const handleError = useCallback(
    (err: unknown) => {
      if (isUnauthenticated(err)) onLoggedOut();
      else setError(err instanceof Error ? err.message : String(err));
    },
    [onLoggedOut],
  );

  // PC 목록: WatchEndpoints 스트림. 끊기면 다시 구독한다
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      while (!ac.signal.aborted) {
        try {
          for await (const ev of consoleClient.watchEndpoints({}, { signal: ac.signal })) {
            const e = ev.endpoint;
            if (!e) continue;
            setEndpoints((prev) => new Map(prev).set(e.id, e));
          }
        } catch (err) {
          if (ac.signal.aborted) return;
          if (isUnauthenticated(err)) return onLoggedOut();
        }
        await sleep(1000);
      }
    })();
    return () => ac.abort();
  }, [onLoggedOut]);

  // 새로고침 후 서버에 남아 있는 터미널 세션을 탭으로 복원한다
  useEffect(() => {
    consoleClient
      .listTerminals({})
      .then((res) => {
        const restored = res.terminals
          .filter((t) => !t.exited)
          .map((t, i) => ({
            sessionId: t.sessionId,
            endpointId: t.endpointId,
            title: `터미널 ${i + 1}`,
            customTitle: t.title,
            status: 'connecting' as const,
          }));
        setTabs(restored);
        const pc = selectedFromUrl();
        setActiveTab(restored.find((t) => t.endpointId === pc)?.sessionId ?? '');
      })
      .catch(handleError);
  }, [handleError]);

  // 선택한 PC 를 URL 에 남겨 새로고침해도 유지한다
  useEffect(() => {
    const url = new URL(location.href);
    if (selected) url.searchParams.set('pc', selected);
    else url.searchParams.delete('pc');
    history.replaceState(null, '', url);
  }, [selected]);

  // 상태 표시줄: 현재 탭의 입력 지연(최근 값들의 중앙값)
  useEffect(() => {
    const t = setInterval(() => {
      const l = sessions.current.get(activeTab)?.latencies ?? [];
      const sorted = [...l].sort((a, b) => a - b);
      setLatency(sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined);
    }, 1000);
    return () => clearInterval(t);
  }, [activeTab]);

  const pcTabs = tabs.filter((t) => t.endpointId === selected);
  const endpoint = endpoints.get(selected);

  async function openTerminal() {
    setError('');
    try {
      const { sessionId } = await consoleClient.openTerminal({ endpointId: selected, cols: 80, rows: 24 });
      setTabs((prev) => [
        ...prev,
        {
          sessionId,
          endpointId: selected,
          title: `터미널 ${prev.filter((t) => t.endpointId === selected).length + 1}`,
          customTitle: '',
          status: 'connecting',
        },
      ]);
      setActiveTab(sessionId);
      setPane('terminal');
    } catch (err) {
      handleError(err);
    }
  }

  async function closeTab(tab: Tab) {
    if (tab.status !== 'exited' && tab.status !== 'gone') {
      await consoleClient.closeTerminal({ sessionId: tab.sessionId }).catch(() => {});
    }
    setTabs((prev) => prev.filter((t) => t.sessionId !== tab.sessionId));
    if (activeTab === tab.sessionId) setActiveTab(pcTabs.find((t) => t.sessionId !== tab.sessionId)?.sessionId ?? '');
  }

  async function renameTab(tab: Tab, name: string) {
    setRenaming('');
    try {
      await consoleClient.renameTerminal({ sessionId: tab.sessionId, title: name });
      setTabs((prev) => prev.map((t) => (t.sessionId === tab.sessionId ? { ...t, customTitle: name } : t)));
    } catch (err) {
      handleError(err);
    }
  }

  function selectPc(id: string) {
    setView('pc');
    setSelected(id);
    setActiveTab(tabs.find((t) => t.endpointId === id)?.sessionId ?? '');
  }

  /** scope 가 PC 면 그 PC 를 고른 뒤 AI 패널에서 세션을 연다 */
  function openAiSession(id: string, scope: string) {
    if (scope !== 'all') selectPc(scope);
    setShowAi(true);
    setAiRequest({ id, n: Date.now() });
  }

  const updateTab = useCallback((sessionId: string, status: TerminalStatus, exitCode?: number) => {
    setTabs((prev) => prev.map((t) => (t.sessionId === sessionId ? { ...t, status, exitCode } : t)));
  }, []);

  const endpointName = (id: string) => {
    const e = endpoints.get(id);
    return e ? pcName(e) : id.slice(0, 8);
  };

  return (
    <ApprovalsProvider onLoggedOut={onLoggedOut}>
    <div className="flex h-dvh flex-col bg-bg text-fg md:flex-row">
      <aside className="flex shrink-0 flex-col border-line bg-panel md:w-64 md:border-r max-md:border-b">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-semibold">gridelta</span>
          {!user.authDisabled && (
            <button
              type="button"
              className="text-sm text-muted hover:text-fg"
              onClick={() => void logout().then(onLoggedOut)}
              title={`${user.username} 로그아웃`}
            >
              로그아웃
            </button>
          )}
        </div>
        <div className="px-2 pb-1">
          <button
            type="button"
            onClick={() => setView('jobs')}
            aria-pressed={view === 'jobs'}
            className={`w-full rounded-md px-2 py-2 text-left text-sm ${view === 'jobs' ? 'bg-accent-soft' : 'hover:bg-hover'}`}
          >
            스케줄
          </button>
        </div>
        <PcList
          endpoints={endpoints}
          selected={selected}
          onSelect={selectPc}
          onEndpointChange={(e) => setEndpoints((prev) => new Map(prev).set(e.id, e))}
          onError={handleError}
        />
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Approvals />
        <div className="flex min-h-0 flex-1 max-md:flex-col">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {view === 'jobs' ? (
          <JobsView endpoints={endpoints} onError={handleError} onOpenSession={openAiSession} />
        ) : !endpoint ? (
          <div className="grid flex-1 place-items-center p-6 text-muted">왼쪽에서 PC를 선택하세요.</div>
        ) : (
          <>
            <div className="flex items-center gap-1 overflow-x-auto border-b border-line bg-panel px-2" role="tablist">
              {pcTabs.map((t) => (
                <div
                  key={t.sessionId}
                  className={`flex shrink-0 items-center gap-1 rounded-t-md border-b-2 px-3 py-2 text-sm ${
                    t.sessionId === activeTab ? 'border-accent' : 'border-transparent text-muted'
                  }`}
                >
                  {renaming === t.sessionId ? (
                    <NameInput
                      value={t.customTitle}
                      placeholder={t.title}
                      label="터미널 이름"
                      onSave={(name) => void renameTab(t, name)}
                      onCancel={() => setRenaming('')}
                    />
                  ) : (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={t.sessionId === activeTab}
                      onClick={() => {
                        setActiveTab(t.sessionId);
                        setPane('terminal');
                      }}
                      onDoubleClick={() => setRenaming(t.sessionId)}
                      onKeyDown={(ev) => ev.key === 'F2' && setRenaming(t.sessionId)}
                      title="더블클릭하거나 F2 로 이름 바꾸기"
                    >
                      {t.customTitle || t.title}
                      {t.status === 'exited' && ` (종료 ${t.exitCode})`}
                      {t.status === 'reconnecting' && ' (재연결 중)'}
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`${t.customTitle || t.title} 닫기`}
                    className="ml-1 text-muted hover:text-fg"
                    onClick={() => void closeTab(t)}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setPane((p) => (p === 'status' ? 'terminal' : 'status'))}
                aria-pressed={pane === 'status'}
                className="ml-auto shrink-0 px-3 py-2 text-sm text-accent order-last"
              >
                상태
              </button>
              <button
                type="button"
                onClick={() => setShowAi((v) => !v)}
                aria-pressed={showAi}
                className="shrink-0 px-3 py-2 text-sm text-accent order-last"
              >
                AI
              </button>
              <button
                type="button"
                onClick={() => void openTerminal()}
                disabled={!endpoint.online}
                className="shrink-0 px-3 py-2 text-sm text-accent disabled:text-muted"
              >
                + 새 터미널
              </button>
            </div>
            {pane === 'status' && <StatusView endpoint={endpoint} onError={handleError} />}
            <div className={`relative min-h-0 flex-1 bg-term p-2 ${pane === 'status' ? 'hidden' : ''}`}>
              {tabs.map((t) => (
                <TerminalView
                  key={t.sessionId}
                  sessionId={t.sessionId}
                  active={pane === 'terminal' && t.sessionId === activeTab && t.endpointId === selected}
                  onStatus={(s, code) => updateTab(t.sessionId, s, code)}
                  onSession={(s) => (s ? sessions.current.set(t.sessionId, s) : sessions.current.delete(t.sessionId))}
                />
              ))}
              {pcTabs.length === 0 && (
                <div className="grid h-full place-items-center text-sm text-slate-400">
                  {endpoint.online ? '새 터미널을 열어 보세요.' : '이 PC는 오프라인입니다.'}
                </div>
              )}
            </div>
          </>
        )}
        </div>
        {showAi && <AiPanel endpoint={endpoint} endpointName={endpointName} request={aiRequest} />}
        </div>
        <footer className="flex items-center gap-4 border-t border-line bg-panel px-4 py-1 text-xs text-muted">
          <span>{endpoint ? `${pcName(endpoint)} · ${endpoint.defaultShell}` : ''}</span>
          {latency !== undefined && <span data-testid="latency">입력 지연 {Math.round(latency)} ms</span>}
          {error && (
            <span className="text-danger" role="alert">
              {error}
            </span>
          )}
        </footer>
      </main>
    </div>
    </ApprovalsProvider>
  );
}
