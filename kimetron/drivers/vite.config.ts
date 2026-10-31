import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/kimetron/',
  plugins: [react()],
  build: {
    rollupOptions: {
      input: [
        'index.html',
        'demo/index.html',
        'demo/vanilla.html',
        'plesfeda/index.html',
        'sethera/index.html',
        'plan/index.html',
        'game/index.html',
      ],
    },
  },
})
