import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  label?: string
  children: ReactNode
  /** Optional compact fallback for map surfaces */
  compact?: boolean
}

type State = { error: Error | null; resetKey: number; label: string | undefined }

/**
 * Contains render errors so Cesium/Leaflet failures do not blank the whole app.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: 0, label: this.props.label }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info)
  }

  // Clear a stale error when the boundary is reused for a different view
  // (derived during render — avoids a second render from setState in componentDidUpdate).
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.label === state.label) return null
    return state.error
      ? { error: null, resetKey: state.resetKey + 1, label: props.label }
      : { label: props.label }
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
