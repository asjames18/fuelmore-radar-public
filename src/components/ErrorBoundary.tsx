import { Component, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { crashed: boolean }

/**
 * Top-level render safety net: without it, a single component throwing
 * during render leaves visitors staring at a blank page with no
 * explanation. The fallback is honest (data is fine, the view broke),
 * read-only, and keeps diagnostics private — nothing about the error is
 * surfaced to visitors.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false }

  static getDerivedStateFromError(): State {
    return { crashed: true }
  }

  componentDidCatch(error: unknown) {
    // Keep the failure diagnosable in the console; never show it on the page.
    console.error('Radar view crashed:', error)
  }

  private reload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.crashed) {
      return (
        <div className="app-shell">
          <div className="workspace">
            <main role="alert" aria-live="assertive">
              <section className="panel">
                <div className="panel-heading compact">
                  <div>
                    <h2>This view ran into a problem</h2>
                    <p className="activity-message">
                      The page hit an error it couldn&rsquo;t recover from. Your data is
                      fine &mdash; try reloading. If it keeps happening, the raw market
                      data is still available at{' '}
                      <a href="/api/market-history">/api/market-history</a>.
                    </p>
                    <button type="button" className="reload-button" onClick={this.reload}>
                      Reload the page
                    </button>
                  </div>
                </div>
              </section>
            </main>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
