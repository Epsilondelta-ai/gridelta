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
  await page.getByRole('navigation', { name: 'PC 목록' }).locator('button[data-endpoint-id]', { hasText: PC }).click();
  await ai.waitFor();
  const modelSelect = ai.getByLabel('AI 모델');
  await modelSelect.waitFor();
  if ((await modelSelect.inputValue()) !== 'faux/scripted') throw new Error(`model select: ${await modelSelect.inputValue()}`);
  pass('AI 패널에 현재 모델 표시 (faux/scripted)');

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

  // 6. 통합 대화: 여러 PC 를 함께 다룬다
  const sessionSelect = ai.getByLabel('AI 대화');
  await ai.getByRole('button', { name: '+ 통합' }).click();
  await ai.getByTestId('ai-scope').filter({ hasText: '모든 PC' }).waitFor();
  await ask('모든 PC에서 hostname 알려줘');
  await ai.getByText('도구 결과입니다').first().waitFor({ timeout: 60_000 });
  const tools = await toolCards.evaluateAll((els) => els.map((e) => `${e.dataset.tool}:${e.dataset.state}`));
  const runs = await ai.locator('[data-tool="run_command"]').allTextContents();
  if (!tools.includes('list_pcs:output-available') || runs.length !== 2) throw new Error(`unified tools: ${tools}`);
  if (!runs.some((t) => t.includes('agent-debian')) || !runs.some((t) => t.includes('agent-alpine'))) throw new Error(`hostname outputs: ${runs}`);
  pass('통합 대화: list_pcs 후 두 PC 에서 각각 명령 실행');

  await ask('통합 삭제');
  await approval.waitFor({ timeout: 30_000 });
  const who = await approval.textContent();
  if (!who.includes('agent-debian') || !who.includes('rm -rf /tmp/gridelta-ai-test2')) throw new Error(`unified approval: ${who}`);
  await approval.getByRole('button', { name: '승인' }).click();
  await approval.waitFor({ state: 'detached' });
  await ai.locator('[data-tool="run_command"][data-state="output-available"]').nth(2).waitFor({ timeout: 30_000 });
  pass('통합 대화의 위험 명령도 대상 PC 의 승인 정책을 거침');

  // 7. 세션 목록에서 이전 대화를 고른다
  const labels = await sessionSelect.locator('option').allTextContents();
  if (labels.length !== 2 || !labels.some((l) => l.startsWith('[통합]')) || !labels.some((l) => l.startsWith(`[${PC}]`))) {
    throw new Error(`session list: ${labels}`);
  }
  await sessionSelect.selectOption({ label: labels.find((l) => l.startsWith(`[${PC}]`)) });
  await toolCards.nth(3).waitFor({ timeout: 15_000 });
  if ((await toolCards.count()) !== 4) throw new Error(`PC session tool count: ${await toolCards.count()}`);
  pass(`세션 목록에서 이전 대화 선택 (${labels.join(' / ')})`);

  await ai.getByRole('button', { name: '대화 이름 바꾸기' }).click();
  await ai.getByRole('textbox', { name: '대화 이름' }).fill('정리 작업');
  await ai.getByRole('textbox', { name: '대화 이름' }).press('Enter');
  await page.reload();
  await sessionSelect.waitFor();
  const selected = await sessionSelect.evaluate((el) => el.options[el.selectedIndex]?.text ?? '');
  if (selected.normalize('NFC').trim() !== `[${PC}] 정리 작업`.normalize('NFC')) {
    throw new Error(`selected after reload: ${JSON.stringify(selected)}`);
  }
  pass('세션 이름 바꾸기, 새로고침 후 마지막 세션 유지');

  // 다른 PC 에서는 통합 대화와 그 PC 의 대화만 보인다
  await page.getByRole('navigation', { name: 'PC 목록' }).locator('button[data-endpoint-id]', { hasText: 'agent-alpine' }).click();
  await page.waitForTimeout(500);
  const alpineLabels = await sessionSelect.locator('option').allTextContents();
  if (!alpineLabels.some((l) => l.startsWith('[통합]')) || alpineLabels.some((l) => l.startsWith(`[${PC}]`))) {
    throw new Error(`alpine session list: ${alpineLabels}`);
  }
  pass('다른 PC 에서는 통합 대화만 함께 보임');

  await page.screenshot({ path: '/e2e/ai.png' });
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  failed = true;
  await page.screenshot({ path: '/e2e/ai-failure.png' }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
