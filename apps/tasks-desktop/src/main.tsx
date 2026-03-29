import React from "react";
import "./index.css";
import ReactDOM from "react-dom/client";
import { App } from "./app.js";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "monospace", color: "red" }}>
          <strong>Render error:</strong>
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {this.state.error.message}
            {"\n"}
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// SDK initialization happens via IPC — the Rust backend holds the real SDK.
// The webview communicates through Tauri invoke() and event listeners.
// We pass a null sdk here; actual data operations go through the IPC transport.
//
// TODO: When storage adapters are wired, initialize the SDK here with SQLite+FS adapters.

console.log("[main] script loaded");

const rootEl = document.getElementById("root");
console.log("[main] root element:", rootEl);
if (!rootEl) throw new Error("No #root element found");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
console.log("[main] render called");
