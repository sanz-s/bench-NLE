import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { registerAllExtensions } from './media/extensions'
import { installHarness } from './bench/harness'
import { installMainThreadObservers } from './bench/mainThread'
import { restoreProject } from './editor/store'

installMainThreadObservers()
// Extensions are registered per JS context: here for preview decoding, and again inside each worker.
registerAllExtensions()
installHarness()

const params = new URLSearchParams(location.search)
void restoreProject(params.has('fresh') || params.has('bench')).then(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
