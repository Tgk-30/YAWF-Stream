// A render error boundary so an uncaught throw shows a recovery card instead of
// a blank white screen. Three levels are used (see App.tsx): an outer boundary
// (reload-only) around the whole shell, an inner one around the active screen
// that offers "Go home", and one around each of the Browse / Detail overlays
// that offers "Close" so a player crash only dismisses the overlay.

import { Component, type ErrorInfo, type ReactNode } from "react";
import {
  assertBrowserAppRefreshAllowed,
  prepareBrowserAppRefresh,
  reloadBrowserAppPage,
} from "../lib/browserAppRefresh";
import { isStaleAssetLoadError } from "../lib/staleAssetRecovery";
import "./ErrorBoundary.css";

interface Props {
  children: ReactNode;
  /** Shown in the console log + used to distinguish boundaries. */
  label?: string;
  /** When provided, the card offers "Go home" (this callback) in addition to a
   *  full reload - for a per-screen boundary. Omit for the top-level boundary. */
  onGoHome?: () => void;
  /** Label for the onGoHome button. Defaults to "Go home"; an overlay boundary
   *  passes "Close" because its recovery action dismisses the overlay. */
  homeLabel?: string;
  /** Anchor the card to the viewport instead of the scrolling content. Set by
   *  the Browse / Detail overlay boundaries: they render inside .app-content,
   *  which is a scroll container, so an absolutely positioned card would sit at
   *  scroll offset 0 and be off-screen whenever the user has scrolled. */
  overlay?: boolean;
  /** Changing this value clears a caught error (e.g. pass the route so
   *  navigating away from a crashed screen recovers automatically). */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
  recoveryPending: boolean;
  recoveryError: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    error: null,
    recoveryPending: false,
    recoveryError: null,
  };
  private recoveryRequest = 0;
  private recoveryRunning = false;

  static getDerivedStateFromError(error: Error): State {
    return { error, recoveryPending: false, recoveryError: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface for diagnosis; no telemetry is sent.
    console.error(
      `[ErrorBoundary${this.props.label ? ` ${this.props.label}` : ""}]`,
      error,
      info.componentStack,
    );
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error != null && prev.resetKey !== this.props.resetKey) {
      this.cancelRecovery();
      this.setState({ error: null, recoveryPending: false, recoveryError: null });
    }
  }

  componentWillUnmount(): void {
    this.cancelRecovery();
  }

  private cancelRecovery = (): void => {
    this.recoveryRequest += 1;
    this.recoveryRunning = false;
  };

  private goHome = (): void => {
    this.cancelRecovery();
    this.setState({ error: null, recoveryPending: false, recoveryError: null });
    this.props.onGoHome?.();
  };

  private reload = (): void => {
    window.location.reload();
  };

  private recoverStaleAssets = async (): Promise<void> => {
    const ownedError = this.state.error;
    if (
      this.recoveryRunning ||
      ownedError == null ||
      !isStaleAssetLoadError(ownedError)
    ) {
      return;
    }
    this.recoveryRunning = true;
    const request = this.recoveryRequest + 1;
    this.recoveryRequest = request;
    this.setState({ recoveryPending: true, recoveryError: null });
    const isCurrent = () =>
      this.recoveryRequest === request && this.state.error === ownedError;
    try {
      await prepareBrowserAppRefresh();
      if (!isCurrent()) return;
      assertBrowserAppRefreshAllowed();
      if (!isCurrent()) return;
      reloadBrowserAppPage();
    } catch {
      if (!isCurrent()) return;
      this.setState({
        recoveryError:
          "Could not reload the app. Check your connection or privacy mode, then try again.",
      });
    } finally {
      if (isCurrent()) {
        this.recoveryRunning = false;
        this.setState({ recoveryPending: false });
      }
    }
  };

  render(): ReactNode {
    const { error, recoveryPending, recoveryError } = this.state;
    if (error == null) return this.props.children;
    const staleAssets = isStaleAssetLoadError(error);
    return (
      <div
        className={
          this.props.overlay ? "error-boundary error-boundary-overlay" : "error-boundary"
        }
        role="alert"
      >
        <div className="error-boundary-card glass-raised glass-lit">
          <h2 className="error-boundary-title">
            {staleAssets ? "App files could not load" : "Something went wrong"}
          </h2>
          <p className="error-boundary-msg">
            {staleAssets
              ? "This can happen after an update or a connection interruption. Reload to try the current app files. Your saved data will not be erased."
              : error.message || "An unexpected error occurred."}
          </p>
          {recoveryError != null && (
            <p className="error-boundary-status" role="status">
              {recoveryError}
            </p>
          )}
          <div className="error-boundary-actions">
            {this.props.onGoHome != null && (
              <button
                type="button"
                className="btn btn-prominent"
                onClick={this.goHome}
              >
                {this.props.homeLabel ?? "Go home"}
              </button>
            )}
            <button
              type="button"
              className={
                this.props.onGoHome != null ? "btn" : "btn btn-prominent"
              }
              onClick={staleAssets ? () => void this.recoverStaleAssets() : this.reload}
              disabled={staleAssets && recoveryPending}
            >
              {staleAssets && recoveryPending ? "Preparing reload..." : "Reload app"}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
