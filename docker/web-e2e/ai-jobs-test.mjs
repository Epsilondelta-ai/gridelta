// M8: AI 가 대화로 잡을 만들고(위험하지 않으면 바로, rm 이 있으면 대화 안 승인 후 켜짐), AI 잡 회차가
// record_value 로 상태를 남기며, query_records 로 조회되는지 확인한다. 서버는 GRIDELTA_AI_FAUX=1 이어야 한다.
import { chromium } from 'playwright';

const { BASE_URL, USERNAME, PASSWORD } = process.env;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('dialog', (d) => d.accept());
page.on('pageerror', (err) => console.error('[pageerror]', err.message));
let failed = false;
const pass = (m) => console.log(`PASS: ${m}`);

const ai = page.getByRole('region', { name: 'AI' });
const toolCards = ai.getByTestId('tool-call');
const done = (card) => card.and(page.locator('[data-state="output-available"]'));

async function ask(text) {
  await ai.getByLabel('AI 에게 보낼 메시지').fill(text);
  await ai.getByRole('button', { name: '보내기' }).click();
}

async function cardText(i) {
  await done(toolCards.nth(i)).waitFor({ timeout: 30_000 });
  return toolCards.nth(i).textContent();
}

try {
  await page.goto(BASE_URL);
  await page.getByLabel('아이디').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByRole('navigation', { name: 'PC 목록' }).waitFor();

  // 1. 위험하지 않은 명령 잡은 바로 켜진다
  await ai.getByRole('button', { name: '+ 통합' }).click();
  await ask('점검 잡 만들어줘');
  let text = await cardText(0);
  if (!text.includes('create_job') || !text.includes('잡 "루트 점검" 을 저장했습니다')) throw new Error(`create_job card: ${text}`);
  pass('AI 가 대화로 명령 잡을 만들고 바로 저장');

  // 2. rm 이 든 잡은 대화 안에 승인 카드가 뜨고, 승인하면 켜진다
  await ask('정리 잡 만들어줘');
  const chatCard = ai.getByTestId('chat-approval');
  await chatCard.waitFor({ timeout: 30_000 });
  const cardBody = await chatCard.textContent();
  for (const want of ['임시 정리', '그룹 기본', 'rm -rf /tmp/gridelta-cleanup-test', '03:00', 'Asia/Seoul']) {
    if (!cardBody.includes(want)) throw new Error(`chat approval card lacks "${want}": ${cardBody}`);
  }
  await page.getByTestId('approval').and(page.locator('[data-kind="job"]')).waitFor();
  pass('위험 명령이 든 잡은 대화 안 승인 카드(잡 이름·대상·주기·명령)와 위쪽 대기열에 함께 뜸');
  await chatCard.getByRole('button', { name: '승인' }).click();
  await chatCard.waitFor({ state: 'detached' });
  await page.getByTestId('approval').waitFor({ state: 'detached' });
  text = await cardText(1);
  if (!text.includes('사용자 승인을 받았고')) throw new Error(`approved create_job card: ${text}`);
  pass('승인하면 도구 결과로 승인 사실을 받음');

  // 3. AI 잡 (10초마다, agent-debian)
  await ask('AI 잡 만들어줘');
  text = await cardText(2);
  if (!text.includes('잡 "커널 AI" 을 저장했습니다')) throw new Error(`AI job card: ${text}`);
  pass('AI 잡을 대화로 만듦');

  await page.getByRole('button', { name: '스케줄' }).click();
  const row = (name) => page.locator('tr', { hasText: name });
  for (const name of ['루트 점검', '임시 정리', '커널 AI']) {
    await row(name).waitFor();
    if (!(await row(name).getByLabel(`${name} 켜기`).isChecked())) throw new Error(`${name} is not enabled`);
    if (!(await row(name).textContent()).includes('AI 가 만듦')) throw new Error(`${name} row: ${await row(name).textContent()}`);
  }
  if (!(await row('커널 AI').textContent()).includes('AI 잡')) throw new Error('AI job badge missing');
  pass('스케줄 화면: AI 가 만든 세 잡이 모두 켜져 있음 (승인한 잡 포함)');

  // 4. AI 잡 회차: record_value 로 상태를 남기고, 회차에서 대화로 이동
  await row('커널 AI').getByTestId('last-run').filter({ hasText: '성공' }).waitFor({ timeout: 60_000 });
  await row('커널 AI').getByRole('button', { name: '커널 AI', exact: true }).click();
  const runs = page.getByRole('dialog', { name: '커널 AI 실행 기록' });
  await runs.locator('[data-run-status="succeeded"]').first().click();
  const result = runs.locator('[data-result-endpoint]').first();
  await result.waitFor();
  text = await result.textContent();
  if (!text.includes('AI 답') || !text.includes('기록했습니다')) throw new Error(`AI run result: ${text}`);
  pass('AI 잡 회차가 성공하고 AI 의 답이 회차 결과로 남음');

  await runs.getByRole('button', { name: '이 회차의 AI 대화 보기' }).click();
  await runs.waitFor({ state: 'detached' });
  await ai.getByTestId('ai-scheduled').waitFor();
  const session = await ai.getByLabel('AI 대화').locator('option:checked').textContent();
  if (!session.includes('[스케줄] 커널 AI')) throw new Error(`opened session: ${session}`);
  await ai.locator('[data-tool="record_value"][data-state="output-available"]').waitFor({ timeout: 15_000 });
  const bashCards = await ai.locator('[data-tool="bash"]').allTextContents();
  if (!bashCards.some((t) => t.includes('rm -rf /tmp/gridelta-sched-test') && t.includes('스케줄 실행에서는 위험 명령을 실행하지 않음'))) {
    throw new Error(`bash cards: ${bashCards}`);
  }
  pass('회차 기록에서 그 대화로 이동: uname → record_value, rm 은 승인 없이 거부됨, 입력창 대신 안내');

  // 5. PC 상태 탭: AI 가 남긴 kernel.ai 와 명령 잡이 남긴 disk.root
  await page.getByRole('button', { name: '상태' }).click();
  const status = page.getByTestId('status-view');
  const kernel = status.locator('[data-record-name="kernel.ai"]');
  await kernel.waitFor();
  text = await kernel.textContent();
  if (!/\d+\.\d+/.test(text) || !text.includes('AI')) throw new Error(`kernel.ai record: ${text}`);
  await status.locator('[data-record-name="disk.root"]').waitFor({ timeout: 30_000 });
  pass('PC 상태 탭에 AI 기록(kernel.ai)과 명령 잡 기록(disk.root)');

  // 6. query_records 로 조회
  await ai.getByRole('button', { name: '+ 통합' }).click();
  await ask('기록 조회해줘');
  text = await cardText(0);
  if (!text.includes('query_records') || !text.includes('kernel.ai') || !/\d+\.\d+/.test(text)) throw new Error(`query_records card: ${text}`);
  pass('query_records 로 AI 가 남긴 상태를 조회');

  // 정리: 10초마다 도는 잡들을 지운다
  await page.getByRole('button', { name: '스케줄' }).click();
  for (const name of ['루트 점검', '임시 정리', '커널 AI']) {
    await page.getByRole('button', { name: `${name} 지우기` }).click();
    await row(name).waitFor({ state: 'detached' });
  }
  pass('잡 지우기');
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  failed = true;
  await page.screenshot({ path: '/e2e/ai-jobs-failure.png' }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
