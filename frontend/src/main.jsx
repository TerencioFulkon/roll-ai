import React from "react";
import ReactDOM from "react-dom/client";
import { ensureRollaiSessionId } from "@/lib/session-id";
import { AuthProvider } from "@/contexts/auth-context";
import "./prevent-zoom.js";
import "./index.css";
import "./styles.css";
import App from "./App.jsx";

ensureRollaiSessionId();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
