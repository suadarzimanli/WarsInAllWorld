import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Missing #root element — check index.html')
}

/** Vite BASE_URL is `/` or `/repo/` — React Router wants no trailing slash (except root). */
const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || undefined

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary label="App">
      <BrowserRouter basename={basename}>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
