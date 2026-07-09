import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Runs on http://localhost:5173 by default — keep this origin in the Next app's
// AIRLAB_ALLOWED_ORIGINS / AIRLAB_AUTHORIZED_PARTIES.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
})
