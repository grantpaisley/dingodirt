import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// The shared visual library (one canonical copy — core/ui). Tokens and fonts
// load first so App.css can remap Plan's legacy vars onto them.
import '../../../core/ui/tokens.css'
import '../../../core/ui/fonts.css'
import '../../../core/ui/chrome.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
