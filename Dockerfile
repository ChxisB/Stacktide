# One image, four commands: api | worker | migrate | web (deploy/entrypoint.sh). Bun runs the TypeScript
# directly, so the build stage only installs; the runtime stage is the slim image and runs as `bun`, not root.
# shortcut: the base is pinned by tag, not by digest; pin the digest when builds must be bit-for-bit repeatable.
FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=bun:bun /app /app
COPY --chmod=0755 deploy/entrypoint.sh /usr/local/bin/orch-entrypoint
USER bun
EXPOSE 3000
# Liveness of the api (the default command). Other commands: the compose file turns this off for the worker.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["orch-entrypoint"]
CMD ["api"]
