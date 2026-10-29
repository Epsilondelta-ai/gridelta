// GRIDELTA_WEB_AUTH=off 일 때 로그인 없이 터미널과 AI 를 쓸 수 있는지 확인한다.
import { chromium } from 'playwright';

const { BASE_URL, PC } = process.env;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
let failed = false;
try {
  await page.goto(BASE_URL);
  await page.getByRole('navigation', { name: 'PC 목록' }).waitFor();
  if (await page.getByLabel('비밀번호').count()) throw new Error('login form shown');
  if (await page.getByRole('button', { name: '로그아웃' }).count()) throw new Error('logout button shown');
  console.log('PASS: 로그인 화면 없이 바로 PC 목록 (로그아웃 버튼 숨김)');

  await page.getByRole('navigation', { name: 'PC 목록' }).getByRole('button', { name: new RegExp(PC) }).click();
  await page.getByRole('button', { name: '+ 새 터미널' }).click();
  await page.locator('[data-session-id]:not(.hidden) .xterm').click();
  await page.waitForTimeout(500);
  await page.keyboard.type('echo noauth-$((1+1))\n', { delay: 15 });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-session-id]:not(.hidden)');
    const t = el && window.__gridelta?.terminals.get(el.getAttribute('data-session-id'));
    if (!t) return false;
    const b = t.buffer.active;
    for (let i = 0; i < b.length; i++) if (b.getLine(i)?.translateToString(true).trim() === 'noauth-2') return true;
    return false;
  }, null, { timeout: 15_000 });
  console.log('PASS: 로그인 없이 웹 터미널 사용');

  const ai = page.getByRole('region', { name: 'AI' });
  await ai.getByLabel('AI 에게 보낼 메시지').fill('디스크 사용량이 큰 폴더 5개 알려줘');
  await ai.getByRole('button', { name: '보내기' }).click();
  await ai.locator('[data-testid="tool-call"][data-state="output-available"]').first().waitFor({ timeout: 30_000 });
  console.log('PASS: 로그인 없이 AI 사용');
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
