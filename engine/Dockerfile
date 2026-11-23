FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bunx prisma generate
EXPOSE 4000
# Apply migrations, then start. Set RUN_WORKERS=false on extra replicas if you run a separate worker.
CMD ["sh", "-c", "bunx prisma migrate deploy && bun src/index.ts"]
