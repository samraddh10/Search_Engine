import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App.tsx";
import { queryClient } from "./services/queryClient.ts";
import "./index.css";

//`QueryClientProvider` inside `BrowserRouter`, because the hooks that read the URL are the
//same ones that key the cache on it — the router has to be the outer context or a hook
//would read a query the provider has not seen.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);
