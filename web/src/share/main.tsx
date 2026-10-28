import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "../styles.css";
import "./share.css";
import { ShareApp } from "./ShareApp.tsx";
import { applySavedTheme } from "../components/ThemeSwitch.tsx";

// The guest page for one shared piece of work (server/src/shareServer.ts). It talks only to the
// guest server's /api: nothing of the owner's portal is loaded or reachable from here.
// The page's CSP allows no inline script, so the saved theme is applied here, before the first render.
applySavedTheme();
createRoot(document.getElementById("root")!).render(<StrictMode><ShareApp /></StrictMode>);
