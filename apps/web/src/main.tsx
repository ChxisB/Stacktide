import { createClient } from "@orch/api-client";
import { createRoot } from "react-dom/client";
import { App, newQueryClient } from "./app";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");
createRoot(root).render(
  <App client={createClient(window.location.origin)} queries={newQueryClient()} />,
);
