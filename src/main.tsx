import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { OwnerCockpit } from './components/OwnerCockpit'
import { FuelPlanner } from './components/FuelPlanner'
import { SourceHealth } from './components/SourceHealth'
import { RiskPanel } from './components/RiskPanel'
import { AnalyticsPanel } from './components/AnalyticsPanel'
import { OWNER_WALLET } from './lib/owner'

createRoot(document.getElementById('root')!).render(
  <StrictMode><App personal={{ Cockpit: OwnerCockpit, Planner: FuelPlanner, Diagnostics: SourceHealth, Risk: RiskPanel, Analytics: AnalyticsPanel, defaultWallet: OWNER_WALLET }}/></StrictMode>,
)
