const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  418: "I'm a teapot",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/** RFC 9457 problem+json. `detail` and `extra` reach the client: no values, no internals. */
export function problem(
  status: number,
  code: string,
  requestId: string,
  detail?: string,
  extra: object = {},
): Response {
  const body = {
    type: `urn:orch:problem:${code}`,
    title: TITLES[status] ?? (status >= 500 ? "Server Error" : "Client Error"),
    status,
    code,
    detail,
    request_id: requestId,
    ...extra,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json", "x-request-id": requestId },
  });
}
