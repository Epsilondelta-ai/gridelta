// 그룹 UI: 만들기, PC 옮기기, 이름 바꾸기, PC 추가(등록 토큰), 지우기
import { chromium } from 'playwright';

const { BASE_URL, USERNAME, PASSWORD } = process.env;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('dialog', (d) => d.accept()); // 그룹 지우기 확인
let failed = false;
const pass = (m) => console.log(`PASS: ${m}`);
const nav = page.getByRole('navigation', { name: 'PC 목록' });
const groupSection = (name) => nav.getByRole('region', { name: `${name} 그룹` });
const pcIn = (group, host) => groupSection(group).locator('button[data-endpoint-id]', { hasText: host });

try {
  await page.goto(BASE_URL);
  await page.getByLabel('아이디').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await pcIn('기본', 'agent-alpine').waitFor();

  await nav.getByRole('button', { name: '+ 그룹' }).click();
  await page.getByRole('textbox', { name: '새 그룹 이름' }).fill('운영');
  await page.getByRole('textbox', { name: '새 그룹 이름' }).press('Enter');
  await groupSection('운영').waitFor();
  pass('그룹 만들기');

  await pcIn('기본', 'agent-alpine').hover();
  await nav.getByRole('button', { name: 'agent-alpine 그룹 옮기기' }).click();
  await nav.getByLabel('agent-alpine 의 그룹').selectOption({ label: '운영' });
  await pcIn('운영', 'agent-alpine').waitFor();
  pass('PC 를 다른 그룹으로 옮기기');

  await groupSection('운영').hover();
  await nav.getByRole('button', { name: '운영 그룹 이름 바꾸기' }).click();
  await nav.getByRole('textbox', { name: '그룹 이름' }).fill('운영 서버');
  await nav.getByRole('textbox', { name: '그룹 이름' }).press('Enter');
  await pcIn('운영 서버', 'agent-alpine').waitFor();
  pass('그룹 이름 바꾸기');

  await nav.getByRole('button', { name: '운영 서버 그룹에 PC 추가' }).click();
  const dialog = page.getByRole('dialog', { name: '운영 서버 그룹에 PC 추가' });
  await dialog.getByLabel('사용 횟수').selectOption({ label: '여러 대 (만료 전까지)' });
  await dialog.getByRole('button', { name: '등록 명령 만들기' }).click();
  const cmds = await dialog.getByTestId('enroll-commands').textContent();
  if (!cmds.includes('sudo sh -c') || !cmds.includes('--token') || !cmds.includes('gridelta-agent.exe')) throw new Error(`commands: ${cmds}`);
  await dialog.getByRole('list', { name: '등록 토큰' }).getByText('0대 등록 (무제한)').waitFor();
  await dialog.getByRole('button', { name: '폐기' }).click();
  await dialog.getByText('없음').waitFor();
  await dialog.getByRole('button', { name: '닫기' }).click();
  pass('PC 추가 창: 여러 대용 등록 명령(macOS·Linux·Windows) 만들기, 토큰 목록·폐기');

  await page.reload();
  await pcIn('운영 서버', 'agent-alpine').waitFor();
  pass('새로고침 후 그룹·소속 유지');

  await groupSection('운영 서버').hover();
  await nav.getByRole('button', { name: '운영 서버 그룹 지우기' }).click();
  await groupSection('운영 서버').waitFor({ state: 'detached' });
  await pcIn('기본', 'agent-alpine').waitFor();
  pass('그룹을 지우면 PC 는 기본 그룹으로');
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  failed = true;
  await page.screenshot({ path: '/e2e/group-failure.png' }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
