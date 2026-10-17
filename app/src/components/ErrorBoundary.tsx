import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  label?: string
  children: ReactNode
  /** Optional compact fallback for map surfaces */
  compact?: boolean
}

type State = { error: Error | null; resetKey: number }

/**
 * Contains render errors so Cesium/Leaflet failures do not blank the whole app.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info)
  }

  componentDidUpdate(prevProps: Props) {
    if (prevProps.label !== this.props.label && this.state.error) {
      this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }))
    }
  }

  private retry = () => {
    this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }))
  }

  render() {
    if (this.state.error) {
      if (this.props.compact) {
        return (
          <div className="error-boundary compact" role="alert">
            <p>
              <strong>{this.props.label ?? 'View'} failed to load.</strong>
            </p>
            <p className="muted">{this.state.error.message}</p>
            <button type="button" className="btn" onClick={this.retry}>
              Try again
            </button>
          </div>
        )
      }
      return (
        <div className="loading-screen" role="alert">
          <div className="loading-card">
            <p style={{ color: 'var(--danger)' }}>Something went wrong</p>
            <p className="muted">{this.state.error.message}</p>
            <button type="button" className="btn primary" onClick={this.retry}>
              Try again
            </button>
          </div>
        </div>
      )
    }
    // Remount on retry via key — fill parent so absolute Map/Globe still layout.
    return (
      <div key={this.state.resetKey} className="error-boundary-host">
        {this.props.children}
      </div>
    )
  }
}
