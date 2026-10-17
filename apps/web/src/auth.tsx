import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect } from "react";
import { ApiError, call, useClient } from "./api";

export interface Me {
  id: string;
  gitlabId: number;
  username: string;
  name: string;
}

const MeContext = createContext<Me | undefined>(undefined);

/** The signed-in user. Only rendered under `AuthGate`, so it is always there. */
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe outside <AuthGate>");
  return me;
}

export function ErrorPanel({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div role="alert" className="card">
      <h2>Something went wrong</h2>
      <p className="error">{error.message}</p>
      {retry && (
        <button type="button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function LoginPage() {
  return (
    <div className="center">
      <div className="card">
        <h1>Orchastrature</h1>
        <p>Set up CI/CD, manage variables and sync them to GitLab, all in one place.</p>
        {/* a full page navigation: the API sends the browser to GitLab and back */}
        <a className="button primary" href="/auth/login?return_to=/">
          Sign in with GitLab
        </a>
      </div>
    </div>
  );
}

/** Signed-out visitors get the login page, signed-in ones their `children`. */
export function AuthGate({ children }: { children: ReactNode }) {
  const client = useClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => call(() => client.auth.me.get()),
    retry: false,
  });
  const queries = useQueryClient();
  const signedOut = me.error instanceof ApiError && me.error.status === 401;
  // a session that ends on its own (not through Sign out) must not leave its data for the next user
  useEffect(() => {
    if (signedOut) queries.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
  }, [signedOut, queries]);
  if (me.isPending) {
    return (
      <p className="center muted" aria-busy="true">
        Loading…
      </p>
    );
  }
  if (signedOut) return <LoginPage />;
  if (me.error) {
    return (
      <div className="center">
        <ErrorPanel error={me.error} retry={() => void me.refetch()} />
      </div>
    );
  }
  return <MeContext.Provider value={me.data}>{children}</MeContext.Provider>;
}

/** Ends the session, forgets everything fetched as that user, and shows the login page. */
export function useSignOut() {
  const client = useClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: () =>
      // a session that is already gone answers 401: signed out either way
      call(() => client.auth.logout.post()).catch((error: unknown) => {
        if (!(error instanceof ApiError && error.status === 401)) throw error;
      }),
    onSuccess: async () => {
      // `me` now answers 401, so the gate drops the signed-in pages; only then forget their data
      await queries.invalidateQueries({ queryKey: ["me"] });
      queries.clear();
      // the next person to sign in starts at home, not on this person's page
      window.location.hash = "";
    },
  });
}
