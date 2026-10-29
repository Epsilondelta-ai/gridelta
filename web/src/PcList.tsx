import type { CreateEnrollTokenResponse, Endpoint, EnrollToken, Group } from '@gridelta/proto/console';
import { useCallback, useEffect, useState } from 'react';
import { consoleClient } from './api.ts';
import { NameInput } from './NameInput.tsx';

const DEFAULT_GROUP = 'default';

export function pcName(e: Endpoint): string {
  return e.displayName || e.hostname;
}

interface Props {
  endpoints: Map<string, Endpoint>;
  selected: string;
  onSelect: (id: string) => void;
  /** 이름·그룹을 바꾼 뒤 화면에 바로 반영 (WatchEndpoints 도 곧 다시 보낸다) */
  onEndpointChange: (e: Endpoint) => void;
  onError: (err: unknown) => void;
}

/** 그룹별 PC 목록. 그룹 만들기·이름 바꾸기·지우기, PC 이름 바꾸기·그룹 이동, 그룹에 PC 추가(등록 토큰) */
export function PcList({ endpoints, selected, onSelect, onEndpointChange, onError }: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  /** 이름을 바꾸는 중인 것: `pc:<id>`, `group:<id>`, `new-group` */
  const [editing, setEditing] = useState('');
  const [moving, setMoving] = useState('');
  const [enrollGroup, setEnrollGroup] = useState<Group>();

  const refreshGroups = useCallback(async () => {
    try {
      setGroups((await consoleClient.listGroups({})).groups);
    } catch (err) {
      onError(err);
    }
  }, [onError]);
  useEffect(() => {
    void refreshGroups();
  }, [refreshGroups]);
  // PC 가 늘거나 그룹을 옮기면 그룹별 대수가 바뀐다
  const groupSignature = [...endpoints.values()].map((e) => e.id + e.groupId).join();
  useEffect(() => {
    void refreshGroups();
  }, [groupSignature, refreshGroups]);

  async function run(fn: () => Promise<unknown>) {
    setEditing('');
    try {
      await fn();
    } catch (err) {
      onError(err);
    }
    await refreshGroups();
  }

  const renamePc = (e: Endpoint, name: string) =>
    run(async () => {
      await consoleClient.renameEndpoint({ endpointId: e.id, displayName: name });
      onEndpointChange({ ...e, displayName: name });
    });
  const movePc = (e: Endpoint, groupId: string) => {
    setMoving('');
    return run(async () => {
      await consoleClient.moveEndpoint({ endpointId: e.id, groupId });
      onEndpointChange({ ...e, groupId });
    });
  };
  const createGroup = (name: string) => (name ? run(() => consoleClient.createGroup({ name })) : Promise.resolve(setEditing('')));
  const renameGroup = (g: Group, name: string) => (name ? run(() => consoleClient.renameGroup({ id: g.id, name })) : Promise.resolve(setEditing('')));
  const deleteGroup = (g: Group) => {
    if (!confirm(`"${g.name}" 그룹을 지울까요? 그룹의 PC 는 기본 그룹으로 옮겨지고, 그룹의 등록 토큰은 폐기됩니다.`)) return;
    void run(async () => {
      await consoleClient.deleteGroup({ id: g.id });
      for (const e of endpoints.values()) if (e.groupId === g.id) onEndpointChange({ ...e, groupId: DEFAULT_GROUP });
    });
  };

  const known = new Set(groups.map((g) => g.id));
  const byGroup = (groupId: string) =>
    [...endpoints.values()]
      .filter((e) => (known.has(e.groupId) ? e.groupId : DEFAULT_GROUP) === groupId)
      .sort((a, b) => pcName(a).localeCompare(pcName(b)));

  return (
    <nav aria-label="PC 목록" className="flex-1 overflow-y-auto px-2 pb-2 max-md:max-h-48">
      <div className="mb-1 flex justify-end px-1">
        <button type="button" onClick={() => setEditing('new-group')} className="text-xs text-accent">
          + 그룹
        </button>
      </div>
      {editing === 'new-group' && (
        <div className="px-1 pb-2">
          <NameInput value="" placeholder="새 그룹 이름" label="새 그룹 이름" onSave={(n) => void createGroup(n)} onCancel={() => setEditing('')} />
        </div>
      )}

      {groups.map((g) => (
        <section key={g.id} aria-label={`${g.name} 그룹`} className="mb-2" data-group-id={g.id}>
          <div className="group/header flex items-center gap-1 px-1 py-1">
            {editing === `group:${g.id}` ? (
              <NameInput value={g.name} placeholder={g.name} label="그룹 이름" onSave={(n) => void renameGroup(g, n)} onCancel={() => setEditing('')} />
            ) : (
              <h3
                className="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide text-muted"
                onDoubleClick={() => setEditing(`group:${g.id}`)}
                title="더블클릭해서 이름 바꾸기"
              >
                {g.name} <span className="font-normal">({byGroup(g.id).length})</span>
              </h3>
            )}
            <button type="button" onClick={() => setEnrollGroup(g)} className="text-xs text-accent" aria-label={`${g.name} 그룹에 PC 추가`}>
              PC 추가
            </button>
            <button
              type="button"
              aria-label={`${g.name} 그룹 이름 바꾸기`}
              onClick={() => setEditing(`group:${g.id}`)}
              className="px-1 text-xs text-muted opacity-0 hover:text-fg focus:opacity-100 group-hover/header:opacity-100"
            >
              ✎
            </button>
            {g.id !== DEFAULT_GROUP && (
              <button
                type="button"
                aria-label={`${g.name} 그룹 지우기`}
                onClick={() => deleteGroup(g)}
                className="px-1 text-xs text-muted opacity-0 hover:text-fg focus:opacity-100 group-hover/header:opacity-100"
              >
                🗑
              </button>
            )}
          </div>

          {byGroup(g.id).length === 0 && <p className="px-2 pb-1 text-xs text-muted">PC 없음</p>}
          {byGroup(g.id).map((e) =>
            editing === `pc:${e.id}` ? (
              <div key={e.id} className="px-2 py-2">
                <NameInput value={e.displayName} placeholder={e.hostname} label="PC 이름" onSave={(n) => void renamePc(e, n)} onCancel={() => setEditing('')} />
              </div>
            ) : (
              <div key={e.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onSelect(e.id)}
                  onDoubleClick={() => setEditing(`pc:${e.id}`)}
                  onKeyDown={(ev) => ev.key === 'F2' && setEditing(`pc:${e.id}`)}
                  title="더블클릭하거나 F2 로 이름 바꾸기"
                  data-endpoint-id={e.id}
                  aria-current={e.id === selected}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-2 pr-14 text-left text-sm ${
                    e.id === selected ? 'bg-accent-soft' : 'hover:bg-hover'
                  }`}
                >
                  <span className={`size-2 shrink-0 rounded-full ${e.online ? 'bg-ok' : 'bg-line'}`} aria-label={e.online ? '온라인' : '오프라인'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{pcName(e)}</span>
                    <span className="block truncate text-xs text-muted">
                      {e.displayName && `${e.hostname} · `}
                      {e.os}/{e.arch}
                      {!e.online && e.lastSeenMs > 0n && ` · ${new Date(Number(e.lastSeenMs)).toLocaleString()}`}
                    </span>
                  </span>
                </button>
                <div className="absolute top-1/2 right-1 flex -translate-y-1/2 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                  <button type="button" aria-label={`${pcName(e)} 그룹 옮기기`} onClick={() => setMoving(e.id)} className="rounded px-1 text-muted hover:text-fg">
                    ⇄
                  </button>
                  <button type="button" aria-label={`${pcName(e)} 이름 바꾸기`} onClick={() => setEditing(`pc:${e.id}`)} className="rounded px-1 text-muted hover:text-fg">
                    ✎
                  </button>
                </div>
                {moving === e.id && (
                  <select
                    aria-label={`${pcName(e)} 의 그룹`}
                    autoFocus
                    value={known.has(e.groupId) ? e.groupId : DEFAULT_GROUP}
                    onChange={(ev) => void movePc(e, ev.target.value)}
                    onBlur={() => setMoving('')}
                    className="mx-2 mb-1 w-[calc(100%-1rem)] rounded-md border border-line bg-bg px-2 py-1 text-xs"
                  >
                    {groups.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ),
          )}
        </section>
      ))}

      {enrollGroup && <EnrollDialog group={enrollGroup} onClose={() => setEnrollGroup(undefined)} onError={onError} />}
    </nav>
  );
}

const TTLS = [
  { label: '1시간', seconds: 3600 },
  { label: '24시간', seconds: 86400 },
  { label: '7일', seconds: 7 * 86400 },
];

/** 그룹에 PC 를 추가하는 창: 등록 토큰을 만들고 OS 별 설치 명령을 보여 준다 */
function EnrollDialog({ group, onClose, onError }: { group: Group; onClose: () => void; onError: (err: unknown) => void }) {
  const [ttl, setTtl] = useState(3600);
  const [maxUses, setMaxUses] = useState(1);
  const [result, setResult] = useState<CreateEnrollTokenResponse>();
  const [tokens, setTokens] = useState<EnrollToken[]>([]);
  const [copied, setCopied] = useState('');

  const refresh = useCallback(async () => {
    setTokens((await consoleClient.listEnrollTokens({ groupId: group.id })).tokens);
  }, [group.id]);
  useEffect(() => {
    void refresh().catch(onError);
  }, [refresh, onError]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function create() {
    try {
      setResult(await consoleClient.createEnrollToken({ groupId: group.id, ttlSeconds: ttl, maxUses }));
      await refresh();
    } catch (err) {
      onError(err);
    }
  }

  async function revoke(id: string) {
    await consoleClient.revokeEnrollToken({ id }).catch(onError);
    await refresh();
  }

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setCopied(''); // HTTP(보안 컨텍스트 아님)에서는 클립보드 API 가 없다. 직접 선택해 복사한다
    }
  }

  return (
    <div className="fixed inset-0 z-10 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label={`${group.name} 그룹에 PC 추가`}
        className="max-h-full w-full max-w-2xl space-y-4 overflow-y-auto rounded-xl border border-line bg-panel p-5 text-sm shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center">
          <h2 className="font-semibold">{group.name} 그룹에 PC 추가</h2>
          <button type="button" aria-label="닫기" onClick={onClose} className="ml-auto text-muted hover:text-fg">
            ×
          </button>
        </div>
        <p className="text-muted">등록 명령을 만든 뒤, PC 에 gridelta-agent 를 두고 관리자 권한으로 실행하면 이 그룹에 등록됩니다.</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-xs text-muted">유효 시간</span>
            <select aria-label="유효 시간" value={ttl} onChange={(e) => setTtl(Number(e.target.value))} className="rounded-md border border-line bg-bg px-2 py-1">
              {TTLS.map((t) => (
                <option key={t.seconds} value={t.seconds}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted">등록할 수 있는 PC</span>
            <select aria-label="사용 횟수" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} className="rounded-md border border-line bg-bg px-2 py-1">
              <option value={1}>1대</option>
              <option value={0}>여러 대 (만료 전까지)</option>
            </select>
          </label>
          <button type="button" onClick={() => void create()} className="btn-primary">
            등록 명령 만들기
          </button>
        </div>

        {result && (
          <div className="space-y-3" data-testid="enroll-commands">
            {[
              { label: 'macOS · Linux', text: result.unixCommand },
              { label: 'Windows (관리자 PowerShell)', text: result.windowsCommand },
            ].map((c) => (
              <div key={c.label}>
                <div className="mb-1 flex items-center text-xs text-muted">
                  {c.label}
                  <button type="button" onClick={() => void copy(c.label, c.text)} className="ml-auto text-accent">
                    {copied === c.label ? '복사됨' : '복사'}
                  </button>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-term p-2 font-mono text-xs text-slate-200">{c.text}</pre>
              </div>
            ))}
            <p className="text-xs text-muted">
              만료: {new Date(Number(result.expiresAtMs)).toLocaleString()} · 토큰 원문은 지금만 볼 수 있습니다.
            </p>
          </div>
        )}

        <div>
          <h3 className="mb-1 text-xs font-semibold text-muted">쓸 수 있는 등록 토큰</h3>
          {tokens.length === 0 && <p className="text-xs text-muted">없음</p>}
          <ul className="space-y-1" aria-label="등록 토큰">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-xs">
                <span className="font-mono text-muted">{t.id.slice(0, 8)}</span>
                <span>
                  {t.maxUses === 0 ? `${t.uses}대 등록 (무제한)` : `${t.uses}/${t.maxUses}대`} · {new Date(Number(t.expiresAtMs)).toLocaleString()} 만료
                </span>
                <button type="button" onClick={() => void revoke(t.id)} className="ml-auto text-danger">
                  폐기
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
