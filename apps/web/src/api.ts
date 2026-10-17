import { type Client, problemOf } from "@orch/api-client";
import { createContext, useContext } from "react";

/** What went wrong with a call, in words the page can show. `status` 0 means no answer at all. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const ClientContext = createContext<Client | undefined>(undefined);

export function useClient(): Client {
  const client = useContext(ClientContext);
  if (!client) throw new Error("no API client: render inside <ClientContext.Provider>");
  return client;
}

const UNREACHABLE = "Cannot reach the server. Check your connection and try again.";

/**
 * The data of a typed client call, or an `ApiError` carrying the API's own explanation. The message
 * never holds the request, only the problem the API reports.
 */
export async function call<T>(
  request: () => Promise<{ data: T | null; error: unknown; status: number }>,
): Promise<T> {
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request();
  } catch {
    throw new ApiError(UNREACHABLE, 0);
  }
  if (res.error) {
    // a call that never got an answer comes back as an error holding the exception
    if ((res.error as { value?: unknown }).value instanceof Error) {
      throw new ApiError(UNREACHABLE, 0);
    }
    const problem = problemOf(res as { error: unknown });
    throw new ApiError(
      problem?.detail ?? problem?.title ?? `The server answered ${res.status}.`,
      res.status,
      problem?.code,
    );
  }
  // a page that is not JSON (a proxy's login, another service) arrives as text; a 204 has no body
  if (res.status !== 204 && (typeof res.data !== "object" || res.data === null)) {
    throw new ApiError("The server did not answer like the Orchastrature API.", res.status);
  }
  return res.data as T;
}
