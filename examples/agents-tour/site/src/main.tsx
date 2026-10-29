import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(<App />);

// Monaco rejects with "Canceled" when a pending request is dropped, for
// example while an editor is disposed on a page change. It is not an error.
window.addEventListener("unhandledrejection", (event) => {
  if ((event.reason as { name?: string } | undefined)?.name === "Canceled") {
    event.preventDefault();
  }
});
