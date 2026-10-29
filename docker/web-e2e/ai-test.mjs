// M5 AI 컨트롤을 실제 브라우저로 확인한다. 서버는 GRIDELTA_AI_FAUX=1 (정해진 응답 모델)로 떠 있어야 한다.
// 사용: BASE_URL=... USERNAME=... PASSWORD=... PC=<hostname> node ai-test.mjs
import { chromium } from 'playwright';

const { BASE_URL, USERNAME, PASSWORD, PC } = process.env;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));
let failed = false;
const pass = (m) => console.log(`PASS: ${m}`);

const ai = page.getByRole('region', { name: 'AI' });
const toolCards = ai.getByTestId('tool-call');

async function ask(text) {
  await ai.getByLabel('AI 에게 보낼 메시지').fill(text);
  await ai.getByRole('button', { name: '보내기' }).click();
}

try {
  await page.goto(BASE_URL);
  await page.getByLabel('아이디').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByRole('navigation', { name: 'PC 목록' }).getByRole('button', { name: new RegExp(PC) }).click();
  await ai.waitFor();

  // 1. 읽기 전용 명령은 바로 실행
  await ask('디스크 사용량이 큰 폴더 5개 알려줘');
  const du = toolCards.nth(0);
  await du.and(page.locator('[data-state="output-available"]')).waitFor({ timeout: 30_000 });
  const duText = await du.textContent();
  if (!duText.includes('du -sh') || !duText.includes('/usr/')) throw new Error(`du tool card: ${duText}`);
  await ai.getByText('도구 결과입니다').first().waitFor();
  pass('읽기 전용 명령(du)은 승인 없이 원격 PC 에서 실행되고 결과가 도구 카드와 답변에 표시');

  // 2. 위험 명령은 승인 대기 → 거부
  await ask('임시 폴더 지워줘');
  const approval = page.getByTestId('approval');
  await approval.waitFor({ timeout: 30_000 });
  const cmd = await approval.locator('pre').textContent();
  if (cmd !== 'rm -rf /tmp/gridelta-ai-test') throw new Error(`approval command: ${cmd}`);
  pass('rm -rf 시도가 승인 대기에 걸림');
  await approval.getByRole('button', { name: '거부' }).click();
  await approval.waitFor({ state: 'detached' });
  await toolCards.nth(1).and(page.locator('[data-state="output-available"]')).waitFor({ timeout: 30_000 });
  const denied = await toolCards.nth(1).textContent();
  if (!denied.includes('사용자가 실행을 거부함')) throw new Error(`denied tool card: ${denied}`);
  pass('거부하면 실행하지 않고 "사용자가 실행을 거부함"을 모델에 돌려줌');

  // 3. 다시 요청 → 승인
  await ask('임시 폴더 지워줘');
  await approval.waitFor({ timeout: 30_000 });
  await approval.getByRole('button', { name: '승인' }).click();
  await approval.waitFor({ state: 'detached' });
  await toolCards.nth(2).and(page.locator('[data-state="output-available"]')).waitFor({ timeout: 30_000 });
  pass('승인하면 실행됨');

  // 4. 파일 쓰기 도구 (fs RPC)
  await ask('파일 하나 만들어줘');
  const write = toolCards.nth(3);
  await write.and(page.locator('[data-state="output-available"]')).waitFor({ timeout: 30_000 });
  if ((await write.getAttribute('data-tool')) !== 'write') throw new Error('expected write tool');
  pass('write 도구가 원격 PC 에 파일을 씀');

  // 5. 새로고침 후 대화 기록 유지 (flue.db)
  await page.reload();
  await ai.waitFor();
  await toolCards.nth(3).waitFor({ timeout: 15_000 });
  pass(`새로고침 후 대화 기록 유지 (도구 호출 ${await toolCards.count()}건)`);

  await page.screenshot({ path: '/e2e/ai.png' });
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  failed = true;
  await page.screenshot({ path: '/e2e/ai-failure.png' }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
