// 웹 터미널 M3 완료 기준을 실제 브라우저(Chromium)로 확인한다.
// 사용: BASE_URL=http://server:3000 USERNAME=... PASSWORD=... PC=<hostname> node test.mjs
import { chromium } from 'playwright';

const { BASE_URL, USERNAME, PASSWORD, PC } = process.env;
const LATENCY_LIMIT_MS = 50;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

let failed = false;
function pass(msg) {
  console.log(`PASS: ${msg}`);
}
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failed = true;
}

/** 현재 보이는 터미널의 버퍼 전체를 문자열로 읽는다 */
async function screen() {
  return page.evaluate(() => {
    const el = document.querySelector('[data-session-id]:not(.hidden)');
    const term = el && window.__gridelta?.terminals.get(el.getAttribute('data-session-id'));
    if (!term) return '';
    const buf = term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n');
  });
}

async function waitScreen(predicate, desc, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    last = await screen();
    if (predicate(last)) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for ${desc}\n--- screen ---\n${last.trimEnd().split('\n').slice(-15).join('\n')}`);
}

/** 마지막 줄이 셸 프롬프트(# 또는 $)로 끝나는지. 버퍼는 줄 끝 공백이 잘려서 읽힌다 */
function promptReady(s) {
  const last = s.trimEnd().split('\n').at(-1) ?? '';
  return /[#$]$/.test(last);
}

async function type(text) {
  await page.locator('[data-session-id]:not(.hidden) .xterm').click();
  await page.keyboard.type(text, { delay: 15 });
}

try {
  // 로그인
  await page.goto(BASE_URL);
  await page.getByLabel('아이디').fill(USERNAME);
  await page.getByLabel('비밀번호').fill('wrong-password');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByRole('alert').waitFor();
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByRole('navigation', { name: 'PC 목록' }).waitFor();
  pass('로그인 (틀린 비밀번호 거부 후 성공)');

  // PC 선택 → 새 터미널
  const pcButton = page.getByRole('navigation', { name: 'PC 목록' }).getByRole('button', { name: new RegExp(PC) });
  await pcButton.waitFor();
  await pcButton.click();
  await page.getByRole('button', { name: '+ 새 터미널' }).click();
  await waitScreen(promptReady, 'shell prompt');
  const sessionId = await page.locator('[data-session-id]:not(.hidden)').getAttribute('data-session-id');
  pass(`PC 선택 후 새 터미널 열림 (${sessionId})`);

  await type('echo hello-$((6*7)) 안녕\n');
  await waitScreen((s) => s.includes('hello-42 안녕'), 'echo output');
  pass('명령 입력과 출력 (한글 포함)');

  // vim: 전체 화면 프로그램
  await type('vim /tmp/m3.txt\n');
  await waitScreen((s) => s.includes('m3.txt') && s.includes('~'), 'vim screen');
  await type('igridelta vim test');
  await page.keyboard.press('Escape');
  await type(':wq\n');
  await waitScreen((s) => promptReady(s) && !s.includes('~\n~'), 'prompt after vim');
  await type('cat /tmp/m3.txt\n');
  await waitScreen((s) => s.split('\n').some((l) => l.trim() === 'gridelta vim test'), 'file written by vim');
  pass('vim 으로 파일 편집 후 저장');

  // top: 주기적으로 화면을 다시 그리는 프로그램
  await type('top\n');
  await waitScreen((s) => /load average/.test(s) && /PID/.test(s), 'top screen');
  await page.keyboard.press('q');
  await waitScreen(promptReady, 'prompt after top');
  await type('echo after-top\n');
  await waitScreen((s) => s.includes('after-top'), 'prompt after top');
  pass('top 실행 후 q 로 종료');
  await page.screenshot({ path: '/e2e/console.png' });

  // 창 크기 변경이 PTY 에 반영되는지
  await page.setViewportSize({ width: 900, height: 600 });
  await page.waitForTimeout(400);
  await type('stty size\n');
  const cols = await page.evaluate((id) => window.__gridelta.terminals.get(id).cols, sessionId);
  await waitScreen((s) => new RegExp(`\\d+ ${cols}\\s*$`, 'm').test(s), `stty size with ${cols} cols`);
  pass(`창 크기 변경이 PTY 에 반영 (cols=${cols})`);

  // 입력 지연: 한 글자씩 보내고 에코까지의 시간
  for (const ch of 'latency-check') {
    await page.keyboard.type(ch);
    await page.waitForTimeout(120);
  }
  await page.keyboard.press('Control+U');
  await waitScreen((s) => promptReady(s) && !s.trimEnd().endsWith('latency-check'), 'line cleared');
  const latencies = await page.evaluate((id) => [...window.__gridelta.sessions.get(id).latencies], sessionId);
  const sorted = latencies.slice(0, 13).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const msg = `입력 지연 중앙값 ${median.toFixed(1)} ms, p90 ${p90.toFixed(1)} ms (기준 ${LATENCY_LIMIT_MS} ms, 16 ms 묶음 포함)`;
  median < LATENCY_LIMIT_MS ? pass(msg) : fail(msg);

  // 새로고침 후 같은 세션에 재접속
  await page.reload();
  await page.getByRole('navigation', { name: 'PC 목록' }).waitFor();
  await page.locator(`[data-session-id="${sessionId}"]`).waitFor({ state: 'attached' });
  await waitScreen((s) => s.includes('after-top'), 'replayed output after reload');
  await type('echo after-reload\n');
  await waitScreen((s) => s.includes('after-reload'), 'output after reload');
  pass('새로고침 후 같은 세션에 재접속 (이전 출력 복원, 입력 계속)');

  // 셸 종료 → 탭에 종료 표시
  await type('exit 5\n');
  await page.getByRole('tab', { name: /종료 5/ }).waitFor();
  pass('셸 종료 코드가 탭에 표시');
} catch (err) {
  fail(err.message);
  await page.screenshot({ path: '/e2e/failure.png' }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
