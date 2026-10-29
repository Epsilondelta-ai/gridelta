import { defineConfig } from 'vitest/config';

// vite.config.ts 의 flue() 플러그인은 테스트 중에 Flue 앱을 띄우려 하므로 테스트용 설정을 따로 둔다
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
