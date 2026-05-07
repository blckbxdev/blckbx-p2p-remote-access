import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { BlackoutView } from "./components/BlackoutView";
import { ScreenPresenterOverlay } from "./components/ScreenPresenterOverlay";
import "./index.css";

const el = document.getElementById("root") as HTMLElement;
const route = window.location.hash.replace(/^#/, "");

if (route.startsWith("/presenter")) {
  document.documentElement.classList.add("bx-presenter-shell");
  document.body.classList.add("bx-presenter-shell");
  ReactDOM.createRoot(el).render(
    <React.StrictMode>
      <ScreenPresenterOverlay />
    </React.StrictMode>,
  );
} else if (route.startsWith("/blackout")) {
  ReactDOM.createRoot(el).render(
    <React.StrictMode>
      <BlackoutView />
    </React.StrictMode>,
  );
} else {
  ReactDOM.createRoot(el).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
