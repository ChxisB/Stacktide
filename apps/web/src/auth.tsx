import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect } from "react";
import { ApiError, call, useClient } from "./api";
import { Callout } from "./components";
import { SsoEntry } from "./ui";

export interface Me {
  id: string;
  gitlabId: number | null;
  username: string;
  name: string;
  /** May create organizations. */
  platformAdmin: boolean;
}

const MeContext = createContext<Me | undefined>(undefined);

/** The signed-in user. Only rendered under `AuthGate`, so it is always there. */
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe outside <AuthGate>");
  return me;
}

/** A failed load: a bad callout (announced) with the words the server gave, and the button that asks again inside it. */
export function ErrorPanel({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <Callout
      tone="bad"
      title="Something went wrong."
      action={
        retry && (
          <button type="button" onClick={retry}>
            Try again
          </button>
        )
      }
    >
      {error.message}
    </Callout>
  );
}

/** The signed-out pages: one card in the middle of an otherwise empty page. */
function SignInCard({ children }: { children: ReactNode }) {
  return (
    <main className="signin">
      <div className="card signin-card page-enter">{children}</div>
    </main>
  );
}

export function LoginPage() {
  return (
    <SignInCard>
      <div className="signin-head">
        <h1>Orchastrature</h1>
        <p className="muted">
          Set up CI/CD, manage variables and sync them to GitLab, all in one place.
        </p>
      </div>
      {/* a full page navigation: the API sends the browser to GitLab (or GitHub) and back */}
      <a className="button primary" href="/auth/login?return_to=/">
        Sign in with GitLab
      </a>
      <a className="button primary" href="/auth/github/login?return_to=/">
        Sign in with GitHub
      </a>
      <h2 className="signin-or">Or through your organization</h2>
      <SsoEntry query="return_to=/" label="Sign in with single sign-on" />
    </SignInCard>
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
      <SignInCard>
        <h1>Orchastrature</h1>
        <ErrorPanel error={me.error} retry={() => void me.refetch()} />
      </SignInCard>
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
