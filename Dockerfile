FROM oven/bun:1-debian

# Java runs APKEditor; apksigner, zipalign and unzip handle the rest of the build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-21-jre-headless apksigner zipalign unzip ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

ARG APKEDITOR_VERSION=1.4.9
ARG APKEDITOR_SHA256=a9cd40df818845456be6d696de6110c89edf4b0a0580cb83438ed6b25a366e67
RUN curl -fsSL -o /opt/apkeditor.jar \
      "https://github.com/REAndroid/APKEditor/releases/download/V${APKEDITOR_VERSION}/APKEditor-${APKEDITOR_VERSION}.jar" \
 && echo "${APKEDITOR_SHA256}  /opt/apkeditor.jar" | sha256sum -c -

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY public ./public

ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://localhost:3000/healthz || exit 1
CMD ["bun", "src/server.ts"]
