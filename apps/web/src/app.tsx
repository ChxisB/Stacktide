import type { Client } from "@orch/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, StrictMode } from "react";
import { ClientContext } from "./api";
import { AuthGate } from "./auth";
import { Checklist } from "./onboarding";
import { OrgProvider, RequireOrg } from "./org";
import { PipelinePage } from "./pipeline";
import { ProjectsPage } from "./projects";
import { RunsPage } from "./runs";
import { type Page, Shell } from "./shell";
import { SyncPage } from "./sync";
import { VariablesPage } from "./variables";

const Home = () => (
  <>
    <h1>Welcome</h1>
    <RequireOrg>{(org) => <Checklist orgId={org.id} />}</RequireOrg>
  </>
);

const Projects = () => (
  <>
    <h1>Projects</h1>
    <RequireOrg>{(org) => <ProjectsPage key={org.id} orgId={org.id} />}</RequireOrg>
  </>
);

const Variables = () => (
  <>
    <h1>Variables</h1>
    <RequireOrg>{(org) => <VariablesPage key={org.id} orgId={org.id} />}</RequireOrg>
  </>
);

const Sync = () => (
  <>
    <h1>Sync</h1>
    <RequireOrg>{(org) => <SyncPage key={org.id} orgId={org.id} />}</RequireOrg>
  </>
);

const Pipeline = () => (
  <>
    <h1>Pipeline</h1>
    <RequireOrg>{(org) => <PipelinePage key={org.id} orgId={org.id} />}</RequireOrg>
  </>
);

const Status = () => (
  <>
    <h1>Pipeline status</h1>
    <RequireOrg>{(org) => <RunsPage key={org.id} orgId={org.id} />}</RequireOrg>
  </>
);

/** The pages, in navigation order; the first is home. Each screen adds itself here. */
const pages: readonly Page[] = [
  { path: "", label: "Home", element: <Home /> },
  { path: "projects", label: "Projects", element: <Projects /> },
  { path: "variables", label: "Variables", element: <Variables /> },
  { path: "sync", label: "Sync", element: <Sync /> },
  { path: "pipeline", label: "Pipeline", element: <Pipeline /> },
  { path: "status", label: "Status", element: <Status /> },
];

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
        <OrgProvider>
          <Shell pages={pages} />
        </OrgProvider>
      </AuthGate>
    </Providers>
  );
}
