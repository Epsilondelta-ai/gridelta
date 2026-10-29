import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 개발 중에는 API 를 서버(기본 3000)로 넘긴다
const server = process.env.GRIDELTA_SERVER ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { '/rpc': server, '/api': server, '/agents': server },
  },
});
