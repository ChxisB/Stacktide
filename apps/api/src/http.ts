import { DomainError, type Logger } from "@orch/core";
import { Elysia, ElysiaCustomStatusResponse, StatusMap } from "elysia";
import {
  declaredTooLarge,
  edgeHeaders,
  HARDENING_DEFAULTS,
  type Hardening,
  preflightAnswer,
} from "./hardening";
import { problem } from "./problem";

interface RequestState {
  id: string;
  log: Logger;
  startedAt: number;
}

// Inbound ids are echoed into headers and logs, so only a conservative charset is trusted.
const SAFE_ID = /^[\w.-]{1,128}$/;

/**
 * Request id, per-request logger, access log and the error -> problem+json mapping, applied to
 * every route (also those of mounted plugins).
 */
export const http = (
  logger: Logger,
  /** Told about every finished request (see `requestMetrics`). */
  observe?: (m: {
    method: string;
    route: string | undefined;
    status: number;
    seconds: number;
  }) => void,
  /** Security headers, CORS and the body cap (see `Hardening`). */
  edge: Hardening = HARDENING_DEFAULTS,
) => {
  // Keyed by Request so even routing failures (unknown route) have an id and a logger.
  const states = new WeakMap<Request, RequestState>();
  const stateOf = (request: Request): RequestState => {
    let s = states.get(request);
    if (!s) {
      const id = Bun.randomUUIDv7();
      s = { id, log: logger.child({ request_id: id }), startedAt: performance.now() };
      states.set(request, s);
    }
    return s;
  };

  return (
    new Elysia({ name: "orch.http" })
      .onRequest(({ request }) => {
        const inbound = request.headers.get("x-request-id");
        const id = inbound && SAFE_ID.test(inbound) ? inbound : Bun.randomUUIDv7();
        states.set(request, {
          id,
          log: logger.child({ request_id: id }),
          startedAt: performance.now(),
        });
      })
      // The headers of every response, and the preflight of a listed origin; a body that declares itself too big stops here.
      .onRequest(({ request, set }) => {
        Object.assign(set.headers, edgeHeaders(edge, request.headers.get("origin")));
        const preflight = preflightAnswer(edge, request);
        if (preflight) return preflight;
        if (declaredTooLarge(edge, request)) {
          return problem(
            413,
            "payload_too_large",
            stateOf(request).id,
            "The request body is too large",
          );
        }
      })
      // Elysia parses urlencoded and multipart bodies on its own. The API speaks JSON only: a cross-site
      // form could otherwise send a state-changing request without a CORS preflight. Routes also say
      // `parse: "json"`, which makes the OpenAPI document list JSON only. A route that must take
      // another body type (an upload, a form-posting webhook) has to relax this first.
      .onRequest(({ request }) => {
        if (request.body === null) return;
        const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        if (type === "application/json") return;
        return problem(415, "unsupported_media_type", stateOf(request).id, "Send JSON bodies");
      })
      .derive({ as: "global" }, ({ request, set }) => {
        const { id, log } = stateOf(request);
        set.headers["x-request-id"] = id;
        return { requestId: id, log };
      })
      .onError({ as: "global" }, ({ code, error, request, set }) => {
        const { id, log } = stateOf(request);
        let response: Response;
        // Elysia wraps whatever a route's own `parse` throws in a PARSE error; a DomainError in it keeps its status.
        const failure =
          code === "PARSE" && error instanceof Error && error.cause instanceof DomainError
            ? error.cause
            : error;
        if (failure instanceof DomainError) {
          response = problem(failure.status, failure.code, id, failure.message);
        } else if (code === "NOT_FOUND") {
          response = problem(404, "not_found", id, "Route not found");
        } else if (code === "VALIDATION") {
          // path + rule message only: `value` would echo what the client submitted.
          const errors = error.all.map((e) => ({ path: e.path, message: e.message }));
          response = problem(422, "validation_failed", id, "Request validation failed", { errors });
        } else if (code === "PARSE") {
          response = problem(400, "bad_request", id, "Request body could not be parsed");
        } else if (error instanceof ElysiaCustomStatusResponse && Number(error.code) >= 400) {
          // A thrown `status(409, payload)`: keep the status, drop the payload.
          response = problem(Number(error.code), `http_${error.code}`, id, "Request failed");
        } else {
          log.error("unhandled error", { error });
          response = problem(500, "internal_error", id, "Internal server error");
        }
        set.status = response.status;
        return response;
      })
      // A returned `status(409, payload)` is a normal response to Elysia and skips onError, so it
      // would send the payload as-is. Whatever carries an error status and is not already a problem
      // is replaced.
      .mapResponse({ as: "global" }, ({ request, response, set }) => {
        const raw = response instanceof ElysiaCustomStatusResponse ? response.code : set.status;
        const code = typeof raw === "string" ? StatusMap[raw as keyof typeof StatusMap] : raw;
        if (typeof code !== "number" || code < 400) return;
        if (
          response instanceof Response &&
          response.headers.get("content-type")?.includes("problem+json")
        )
          return;
        return problem(code, `http_${code}`, stateOf(request).id, "Request failed");
      })
      .onAfterResponse({ as: "global" }, ({ request, set, response, route }) => {
        const { id, log, startedAt } = stateOf(request);
        const raw = response instanceof Response ? response.status : set.status;
        const status = typeof raw === "number" ? raw : 200;
        const elapsed = performance.now() - startedAt;
        log.info("request", {
          method: request.method,
          path: new URL(request.url).pathname,
          status,
          duration_ms: Math.round(elapsed),
          request_id: id,
        });
        observe?.({ method: request.method, route, status, seconds: elapsed / 1000 });
      })
  );
};
