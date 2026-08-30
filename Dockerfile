FROM node:lts-slim AS base

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    wget \
    curl \
    unzip \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir --break-system-packages gallery-dl==1.32.10
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN node --run build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Allow selecting a yt-dlp version at build or runtime
ARG YTDLP_VERSION=latest
ENV YTDLP_VERSION=${YTDLP_VERSION}

# Default path for yt-dlp binary
ENV YTDLP_PATH=./yt-dlp

RUN groupadd -g 1001 nodejs
RUN useradd -r -u 1001 -g nodejs nextjs

COPY --chown=nextjs:nodejs --from=builder /app/public ./public
COPY --chown=nextjs:nodejs --from=builder /app/.next ./.next
COPY --chown=nextjs:nodejs --from=builder /app/node_modules ./node_modules
COPY --chown=nextjs:nodejs --from=builder /app/package.json ./package.json
COPY --chown=nextjs:nodejs ./entrypoint.sh /app/entrypoint.sh

# If a build-time YTDLP_VERSION is provided, try downloading yt-dlp into the path.
RUN if [ -n "$YTDLP_VERSION" ]; then \
    if [ "$YTDLP_VERSION" = "latest" ]; then \
    YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"; \
    else \
    YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp"; \
    fi && \
    wget -q -O $YTDLP_PATH "$YTDLP_URL" && chmod +x $YTDLP_PATH || true; \
    fi

# Ensure the downloaded binary (if any) is owned by the app user
RUN if [ -f "$YTDLP_PATH" ]; then \
    chown nextjs:nodejs "$YTDLP_PATH" || true; \
    chmod +x "$YTDLP_PATH" || true; \
    fi

USER nextjs

EXPOSE 3000

# Ensure cache dir exists
RUN mkdir -p /app/node_modules/@xenova/.cache/
RUN chmod 777 -R /app/node_modules/@xenova/

# /bin/sh is available in Debian, but you can also use /bin/bash if your entrypoint needs it
ENTRYPOINT ["/bin/sh","/app/entrypoint.sh"]
CMD ["node", "--run", "start"]
