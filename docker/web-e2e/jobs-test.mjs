// M7: 스케줄 화면에서 잡을 만들고, 두 PC 에서 실행된 결과와 PC 상태 탭을 확인한다.
import { chromium } from 'playwright';

const { BASE_URL, USERNAME, PASSWORD } = process.env;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('dialog', (d) => d.accept());
page.on('pageerror', (err) => console.error('[pageerror]', err.message));
let failed = false;
const pass = (m) => console.log(`PASS: ${m}`);

try {
  await page.goto(BASE_URL);
  await page.getByLabel('아이디').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByRole('navigation', { name: 'PC 목록' }).waitFor();

  // 잡 만들기: 기본 그룹(두 PC), 10초마다, 출력(텍스트)을 kernel 상태로 저장
  await page.getByRole('button', { name: '스케줄' }).click();
  await page.getByRole('button', { name: '+ 잡 만들기' }).click();
  const editor = page.getByRole('dialog', { name: '잡 만들기' });
  await editor.getByLabel('잡 이름').fill('커널 버전');
  await editor.getByLabel('대상').selectOption({ label: '기본' });
  await editor.getByLabel('cron 식').fill('*/10 * * * * *');
  await editor.getByTestId('schedule-preview').filter({ hasText: '10초' }).waitFor();
  await editor.getByLabel('macOS·Linux 명령').fill('uname -r');
  await editor.getByLabel('상태 이름').fill('kernel');
  await editor.getByLabel('출력 형식').selectOption({ label: '텍스트 그대로' });
  await editor.getByRole('button', { name: '저장' }).click();
  await editor.waitFor({ state: 'detached' });
  const row = page.locator('tr', { hasText: '커널 버전' });
  await row.waitFor();
  if (!(await row.textContent()).includes('그룹 기본')) throw new Error(`row: ${await row.textContent()}`);
  pass('스케줄 화면에서 잡 만들기 (주기 미리보기, 대상 그룹)');

  // 주기로 실행된 회차가 두 PC 에서 성공
  await row.getByTestId('last-run').filter({ hasText: '성공' }).waitFor({ timeout: 40_000 });
  await row.getByRole('button', { name: '커널 버전', exact: true }).click();
  const runs = page.getByRole('dialog', { name: '커널 버전 실행 기록' });
  await runs.locator('[data-run-status="succeeded"]').first().click();
  const results = runs.locator('[data-result-endpoint]');
  await results.nth(1).waitFor();
  const texts = await results.allTextContents();
  if (texts.length !== 2 || !texts.every((t) => t.includes('종료 코드 0') && t.includes('상태 저장됨'))) throw new Error(`results: ${texts}`);
  pass('주기 회차가 두 PC 에서 성공하고 상태 저장됨');

  // 지금 실행
  await runs.getByRole('button', { name: '닫기' }).click();
  await row.getByRole('button', { name: '지금 실행' }).click();
  await runs.getByText('지금 실행').first().waitFor();
  await runs.getByRole('button', { name: '닫기' }).click();
  pass('지금 실행 회차가 기록에 보임');

  // 끄면 다음 실행이 사라진다
  await row.getByLabel('커널 버전 켜기').uncheck();
  await row.locator('td').nth(3).filter({ hasText: '-' }).waitFor();
  pass('잡을 끄면 다음 실행 예정이 없어짐');

  // PC 상태 탭
  await page.getByRole('navigation', { name: 'PC 목록' }).locator('button[data-endpoint-id]', { hasText: 'agent-debian' }).click();
  await page.getByRole('button', { name: '상태' }).click();
  const status = page.getByTestId('status-view');
  const kernel = status.locator('[data-record-name="kernel"]');
  await kernel.waitFor();
  if (!/\d+\.\d+/.test(await kernel.textContent())) throw new Error(`kernel record: ${await kernel.textContent()}`);
  await kernel.getByRole('button', { name: 'kernel' }).click();
  await status.getByRole('region', { name: 'kernel 이전 값' }).waitFor();
  pass('PC 상태 탭: 최신 값과 이전 값');

  await page.getByRole('button', { name: '스케줄' }).click();
  await page.getByRole('button', { name: '커널 버전 지우기' }).click();
  await row.waitFor({ state: 'detached' });
  pass('잡 지우기');
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  failed = true;
  await page.screenshot({ path: '/e2e/jobs-failure.png' }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
