import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { startLeakGuard } from "./dev/leakGuard";
import "./index.css";

startLeakGuard(); // no-op in production builds (gated on import.meta.env.DEV)

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
