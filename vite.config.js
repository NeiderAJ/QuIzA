import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function githubPagesQrPathPlugin() {
  return {
    name: 'quiza-github-pages-qr-path',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/src/App.jsx')) {
        return null
      }

      const localQrPath = '${window.location.origin}/?join=${encodeURIComponent('
      const pagesQrPath = '${window.location.origin}/QuIzA/?join=${encodeURIComponent('
      const transformed = code.split(localQrPath).join(pagesQrPath)

      if (transformed === code) {
        return null
      }

      return {
        code: transformed,
        map: null,
      }
    },
  }
}

export default defineConfig(({ command }) => ({
  // La V1.0 local continúa funcionando desde `/`.
  // Solo el build de publicación vive bajo `/QuIzA/` en GitHub Pages.
  base: command === 'build' ? '/QuIzA/' : '/',
  plugins: [
    command === 'build' ? githubPagesQrPathPlugin() : null,
    react(),
  ].filter(Boolean),
}))
