import type { Client } from "@orch/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, StrictMode } from "react";
import { ClientContext } from "./api";
import { AuthGate } from "./auth";
import { type Page, Shell } from "./shell";

function Home() {
  return (
    <>
      <h1>Welcome</h1>
      <p className="muted">Connect GitLab to get started.</p>
    </>
  );
}

/** The pages, in navigation order; the first is home. Each screen adds itself here. */
const pages: readonly Page[] = [{ path: "", label: "Home", element: <Home /> }];

export const newQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 15_000, refetchOnWindowFocus: false } },
  });

export function Providers({
  client,
  queries,
  children,
}: {
  client: Client;
  queries: QueryClient;
  children: ReactNode;
}) {
  return (
    <StrictMode>
      <ClientContext.Provider value={client}>
        <QueryClientProvider client={queries}>{children}</QueryClientProvider>
      </ClientContext.Provider>
    </StrictMode>
  );
}

/** The whole app for a given API client; `main.tsx` and the tests both mount this. */
export function App({ client, queries }: { client: Client; queries: QueryClient }) {
  return (
    <Providers client={client} queries={queries}>
      <AuthGate>
        <Shell pages={pages} />
      </AuthGate>
    </Providers>
  );
}
