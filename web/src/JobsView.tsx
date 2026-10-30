import type { Endpoint, GetJobRunResponse, Group, Job, JobRun, JobSpec } from '@gridelta/proto/console';
import cronstrue from 'cronstrue/i18n.js';
import { type SubmitEvent, useCallback, useEffect, useState } from 'react';
import { consoleClient } from './api.ts';
import { pcName } from './PcList.tsx';

const POLL_MS = 5000;

const PRESETS = [
  { label: '매시간', cron: '0 * * * *' },
  { label: '매일 오전 9시', cron: '0 9 * * *' },
  { label: '평일 오전 9시', cron: '0 9 * * 1-5' },
  { label: '매주 월요일 오전 9시', cron: '0 9 * * 1' },
  { label: '5분마다', cron: '*/5 * * * *' },
];

const STATUS_LABEL: Record<string, string> = {
  running: '실행 중',
  succeeded: '성공',
  failed: '실패',
  skipped: '건너뜀',
};
const TRIGGER_LABEL: Record<string, string> = { schedule: '주기', manual: '지금 실행', catchup: '놓친 회차' };

/** "매일 오전 9시" 같은 사람이 읽는 주기 설명 */
export function describeSchedule(spec: Pick<JobSpec, 'cron' | 'runAtMs' | 'timezone'>): string {
  if (!spec.cron) return spec.runAtMs ? `한 번: ${new Date(Number(spec.runAtMs)).toLocaleString()}` : '-';
  try {
    return cronstrue.toString(spec.cron, { locale: 'ko', use24HourTimeFormat: false });
  } catch {
    return spec.cron;
  }
}

const fmt = (ms: bigint) => (ms ? new Date(Number(ms)).toLocaleString() : '-');

function StatusBadge({ status }: { status: string }) {
  const color = status === 'succeeded' ? 'text-ok' : status === 'failed' ? 'text-danger' : 'text-muted';
  return <span className={color}>{STATUS_LABEL[status] ?? status}</span>;
}

interface Props {
  endpoints: Map<string, Endpoint>;
  onError: (err: unknown) => void;
}

/** 스케줄 잡 화면: 목록, 만들기·편집, 회차 기록 (설계 14.9) */
export function JobsView({ endpoints, onError }: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [editing, setEditing] = useState<Job | 'new'>();
  const [detail, setDetail] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setJobs((await consoleClient.listJobs({})).jobs);
    } catch (err) {
      onError(err);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
    void consoleClient.listGroups({}).then((r) => setGroups(r.groups), onError);
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh, onError]);

  const targetName = (spec: JobSpec | undefined) => {
    if (!spec) return '';
    if (spec.targetType === 'group') return `그룹 ${groups.find((g) => g.id === spec.targetId)?.name ?? spec.targetId}`;
    const e = endpoints.get(spec.targetId);
    return e ? pcName(e) : spec.targetId.slice(0, 8);
  };

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      onError(err);
    }
    await refresh();
  }

  const detailJob = jobs.find((j) => j.id === detail);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="jobs-view">
      <div className="mb-3 flex items-center">
        <h2 className="text-base font-semibold">스케줄</h2>
        <button type="button" onClick={() => setEditing('new')} className="btn-primary ml-auto">
          + 잡 만들기
        </button>
      </div>

      {jobs.length === 0 && <p className="text-sm text-muted">아직 잡이 없습니다. 정해진 시각에 PC 들에서 명령을 실행하고 결과를 상태로 모을 수 있습니다.</p>}
      {jobs.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-3 py-2">이름</th>
                <th className="px-3 py-2">대상</th>
                <th className="px-3 py-2">주기</th>
                <th className="px-3 py-2">다음 실행</th>
                <th className="px-3 py-2">마지막 결과</th>
                <th className="px-3 py-2">켜짐</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-line last:border-0" data-job-id={j.id}>
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => setDetail(j.id)} className="font-medium hover:underline">
                      {j.spec?.name}
                    </button>
                    {j.createdBy === 'ai' && <span className="ml-1 text-xs text-muted">(AI)</span>}
                  </td>
                  <td className="px-3 py-2">{targetName(j.spec)}</td>
                  <td className="px-3 py-2" title={`${j.spec?.cron} (${j.spec?.timezone})`}>
                    {j.spec && describeSchedule(j.spec)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmt(j.nextRunAtMs)}</td>
                  <td className="px-3 py-2 whitespace-nowrap" data-testid="last-run">
                    {j.lastRun ? (
                      <>
                        <StatusBadge status={j.lastRun.status} /> <span className="text-xs text-muted">{fmt(j.lastRun.startedAtMs)}</span>
                      </>
                    ) : (
                      <span className="text-muted">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`${j.spec?.name} 켜기`}
                      checked={j.spec?.enabled ?? false}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        // 서버 응답을 기다리지 않고 바로 반영한다 (실패하면 목록을 다시 읽어 되돌아간다)
                        setJobs((prev) => prev.map((x) => (x.id === j.id && x.spec ? { ...x, spec: { ...x.spec, enabled } } : x)));
                        void act(() => consoleClient.setJobEnabled({ id: j.id, enabled }));
                      }}
                    />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    <button
                      type="button"
                      className="text-accent"
                      onClick={() =>
                        void act(async () => {
                          await consoleClient.runJobNow({ id: j.id });
                          setDetail(j.id);
                        })
                      }
                    >
                      지금 실행
                    </button>
                    <button type="button" aria-label={`${j.spec?.name} 편집`} className="ml-2 text-muted hover:text-fg" onClick={() => setEditing(j)}>
                      ✎
                    </button>
                    <button
                      type="button"
                      aria-label={`${j.spec?.name} 지우기`}
                      className="ml-2 text-muted hover:text-fg"
                      onClick={() => confirm(`"${j.spec?.name}" 잡을 지울까요? 실행 기록도 함께 지워집니다.`) && void act(() => consoleClient.deleteJob({ id: j.id }))}
                    >
                      🗑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detailJob && <JobRuns job={detailJob} endpoints={endpoints} onClose={() => setDetail(undefined)} onError={onError} />}
      {editing && (
        <JobEditor
          job={editing === 'new' ? undefined : editing}
          endpoints={endpoints}
          groups={groups}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function Modal({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-10 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label={label}
        className="max-h-full w-full max-w-3xl space-y-4 overflow-y-auto rounded-xl border border-line bg-panel p-5 text-sm shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center">
          <h2 className="font-semibold">{label}</h2>
          <button type="button" aria-label="닫기" onClick={onClose} className="ml-auto text-muted hover:text-fg">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function toLocalInput(ms: bigint): string {
  if (!ms) return '';
  const d = new Date(Number(ms));
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** 잡 만들기·편집 */
function JobEditor({
  job,
  endpoints,
  groups,
  onClose,
  onSaved,
}: {
  job: Job | undefined;
  endpoints: Map<string, Endpoint>;
  groups: Group[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const s = job?.spec;
  const [name, setName] = useState(s?.name ?? '');
  const [targetType, setTargetType] = useState(s?.targetType ?? 'group');
  const [targetId, setTargetId] = useState(s?.targetId ?? groups[0]?.id ?? '');
  const [once, setOnce] = useState(!!s && !s.cron);
  const [cron, setCron] = useState(s?.cron || '0 9 * * *');
  const [runAt, setRunAt] = useState(toLocalInput(s?.runAtMs ?? 0n));
  const [timezone, setTimezone] = useState(s?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [commandUnix, setCommandUnix] = useState(s?.commandUnix ?? '');
  const [commandWindows, setCommandWindows] = useState(s?.commandWindows ?? '');
  const [recordName, setRecordName] = useState(s?.recordName ?? '');
  const [recordParse, setRecordParse] = useState(s?.recordParse || 'json');
  const [timeoutS, setTimeoutS] = useState(s?.timeoutS ?? 600);
  const [enabled, setEnabled] = useState(s?.enabled ?? true);
  const [error, setError] = useState('');

  const pcs = [...endpoints.values()].sort((a, b) => pcName(a).localeCompare(pcName(b)));
  useEffect(() => {
    // 대상 종류를 바꾸면 첫 항목을 고른다
    if (targetType === 'group' && !groups.some((g) => g.id === targetId)) setTargetId(groups[0]?.id ?? '');
    if (targetType === 'endpoint' && !endpoints.has(targetId)) setTargetId(pcs[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetType]);

  async function save(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const spec = {
      name,
      kind: 'command',
      targetType,
      targetId,
      cron: once ? '' : cron,
      runAtMs: once && runAt ? BigInt(new Date(runAt).getTime()) : 0n,
      timezone,
      commandUnix,
      commandWindows,
      aiPrompt: '',
      recordName,
      recordParse,
      timeoutS,
      concurrency: s?.concurrency ?? 10,
      enabled,
    };
    try {
      if (job) await consoleClient.updateJob({ id: job.id, spec });
      else await consoleClient.createJob({ spec });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const label = job ? `${s?.name} 편집` : '잡 만들기';
  return (
    <Modal label={label} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs text-muted">이름</span>
          <input aria-label="잡 이름" value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} className="field" />
        </label>

        <fieldset className="space-y-1">
          <legend className="text-xs text-muted">대상</legend>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1">
              <input type="radio" checked={targetType === 'group'} onChange={() => setTargetType('group')} /> 그룹
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={targetType === 'endpoint'} onChange={() => setTargetType('endpoint')} /> PC
            </label>
            <select aria-label="대상" value={targetId} onChange={(e) => setTargetId(e.target.value)} className="min-w-48 rounded-md border border-line bg-bg px-2 py-1">
              {targetType === 'group'
                ? groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))
                : pcs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {pcName(p)}
                    </option>
                  ))}
            </select>
          </div>
        </fieldset>

        <fieldset className="space-y-1">
          <legend className="text-xs text-muted">주기</legend>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1">
              <input type="radio" checked={!once} onChange={() => setOnce(false)} /> 반복
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={once} onChange={() => setOnce(true)} /> 한 번만
            </label>
            {!once ? (
              <>
                <select
                  aria-label="주기 프리셋"
                  value={PRESETS.some((p) => p.cron === cron) ? cron : ''}
                  onChange={(e) => e.target.value && setCron(e.target.value)}
                  className="rounded-md border border-line bg-bg px-2 py-1"
                >
                  <option value="">직접 입력</option>
                  {PRESETS.map((p) => (
                    <option key={p.cron} value={p.cron}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <input aria-label="cron 식" value={cron} onChange={(e) => setCron(e.target.value)} className="w-40 rounded-md border border-line bg-bg px-2 py-1 font-mono" />
              </>
            ) : (
              <input aria-label="실행 일시" type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} className="rounded-md border border-line bg-bg px-2 py-1" />
            )}
            <input aria-label="시간대" value={timezone} onChange={(e) => setTimezone(e.target.value)} className="w-40 rounded-md border border-line bg-bg px-2 py-1" />
          </div>
          {!once && <p className="text-xs text-muted" data-testid="schedule-preview">{describeSchedule({ cron, runAtMs: 0n, timezone })}</p>}
        </fieldset>

        <label className="block space-y-1">
          <span className="text-xs text-muted">명령 (macOS · Linux)</span>
          <textarea aria-label="macOS·Linux 명령" value={commandUnix} onChange={(e) => setCommandUnix(e.target.value)} rows={3} className="field font-mono" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted">명령 (Windows PowerShell, 대상에 Windows PC 가 있으면)</span>
          <textarea aria-label="Windows 명령" value={commandWindows} onChange={(e) => setCommandWindows(e.target.value)} rows={2} className="field font-mono" />
        </label>

        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-xs text-muted">출력을 상태로 저장 (이름, 비우면 저장 안 함)</span>
            <input aria-label="상태 이름" value={recordName} onChange={(e) => setRecordName(e.target.value)} placeholder="disk.root" className="w-48 rounded-md border border-line bg-bg px-2 py-1 font-mono" />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted">출력 형식</span>
            <select aria-label="출력 형식" value={recordParse} onChange={(e) => setRecordParse(e.target.value)} className="rounded-md border border-line bg-bg px-2 py-1">
              <option value="json">JSON 하나</option>
              <option value="kv">줄마다 이름=값</option>
              <option value="text">텍스트 그대로</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted">타임아웃 (초)</span>
            <input aria-label="타임아웃" type="number" min={1} max={86400} value={timeoutS} onChange={(e) => setTimeoutS(Number(e.target.value))} className="w-24 rounded-md border border-line bg-bg px-2 py-1" />
          </label>
          <label className="flex items-center gap-1 pb-1">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 켜짐
          </label>
        </div>

        {error && (
          <p className="text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-line px-3 py-2">
            취소
          </button>
          <button type="submit" className="btn-primary">
            저장
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 잡의 회차 기록과 회차별 PC 결과 */
function JobRuns({ job, endpoints, onClose, onError }: { job: Job; endpoints: Map<string, Endpoint>; onClose: () => void; onError: (err: unknown) => void }) {
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [open, setOpen] = useState<GetJobRunResponse>();

  const refresh = useCallback(async () => {
    try {
      const r = (await consoleClient.listJobRuns({ jobId: job.id, limit: 50 })).runs;
      setRuns(r);
      if (open?.run && r.some((x) => x.id === open.run?.id && x.status !== open.run?.status)) {
        setOpen(await consoleClient.getJobRun({ runId: open.run.id }));
      }
    } catch (err) {
      onError(err);
    }
  }, [job.id, open, onError]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS / 2);
    return () => clearInterval(t);
  }, [refresh]);

  const pc = (id: string) => {
    const e = endpoints.get(id);
    return e ? pcName(e) : id.slice(0, 8);
  };

  return (
    <Modal label={`${job.spec?.name} 실행 기록`} onClose={onClose}>
      <p className="text-xs text-muted">
        {job.spec && describeSchedule(job.spec)} · 다음 실행 {fmt(job.nextRunAtMs)}
      </p>
      {runs.length === 0 && <p className="text-muted">아직 실행 기록이 없습니다.</p>}
      <ul className="divide-y divide-line rounded-md border border-line" aria-label="회차">
        {runs.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className={`flex w-full items-center gap-3 px-3 py-2 text-left ${open?.run?.id === r.id ? 'bg-hover' : 'hover:bg-hover'}`}
              onClick={() => void consoleClient.getJobRun({ runId: r.id }).then(setOpen, onError)}
              data-run-status={r.status}
            >
              <StatusBadge status={r.status} />
              <span className="text-xs text-muted">{TRIGGER_LABEL[r.trigger] ?? r.trigger}</span>
              <span className="whitespace-nowrap">{fmt(r.startedAtMs)}</span>
              <span className="text-xs text-muted">
                {r.status === 'skipped' && r.targetCount === 0 ? '' : `${r.ranCount}/${r.targetCount}대`}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{r.note}</span>
            </button>
          </li>
        ))}
      </ul>

      {open?.run && (
        <div className="space-y-2" aria-label="회차 결과">
          {open.results.length === 0 && <p className="text-xs text-muted">이 회차에서 실행한 PC 가 없습니다 ({open.run.note}).</p>}
          {open.results.map((res) => (
            <div key={res.endpointId} className="rounded-md border border-line" data-result-endpoint={res.endpointId}>
              <div className="flex items-center gap-2 bg-hover px-2 py-1 text-xs">
                <span className="font-medium">{pc(res.endpointId)}</span>
                <span className={res.exitCode === 0 ? 'text-ok' : 'text-danger'}>
                  {res.exitCode !== undefined ? `종료 코드 ${res.exitCode}` : '실행 못 함'}
                </span>
                {res.recordStatus === 'saved' && <span className="text-ok">상태 저장됨</span>}
                {res.recordStatus === 'failed' && <span className="text-danger">상태 저장 실패</span>}
                {res.truncated && <span className="text-muted">출력 일부 생략</span>}
              </div>
              {res.error && <p className="px-2 pt-1 text-xs text-danger">{res.error}</p>}
              {res.output && <pre className="max-h-64 overflow-auto bg-term p-2 text-xs text-slate-200">{res.output}</pre>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
