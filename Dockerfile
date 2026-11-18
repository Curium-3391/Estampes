# syntax=docker/dockerfile:1
# Estampes MCP server. Builds natively on linux/amd64 and linux/arm64
# (Raspberry Pi 4/5 with a 64-bit OS, ARM NAS, Apple Silicon, mini PCs).
# sharp ships prebuilt libvips for both, so no compiler is needed; the
# lockfile lists every platform's sharp package so `npm ci` finds the right one.
# BASE_IMAGE can point at a mirror (e.g. public.ecr.aws/docker/library/node:22-bookworm-slim)
# when Docker Hub rate-limits pulls.
ARG BASE_IMAGE=node:22-bookworm-slim

FROM ${BASE_IMAGE} AS deps
WORKDIR /app
# Optional PDF page rendering (adds roughly 60 MB): docker build --build-arg ESTAMPES_WITH_PDF=1
ARG ESTAMPES_WITH_PDF=0
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --no-audit --no-fund \
 && if [ "$ESTAMPES_WITH_PDF" = "1" ]; then npm install --no-save --omit=dev --no-audit --no-fund pdfjs-dist@4.10.38 @napi-rs/canvas; fi \
 && node -e "const sharp = require('sharp'); console.log('sharp', sharp.versions.sharp, process.arch)"

FROM ${BASE_IMAGE}
# Self-hosted servers are never open by accident: without
# ESTAMPES_ACCESS_KEY a key is generated into /data on first start.
ENV NODE_ENV=production \
    PORT=8787 \
    ESTAMPES_STORAGE_DIR=/data \
    ESTAMPES_UVA_BETA_DIR=/uva-beta \
    ESTAMPES_REQUIRE_KEY=1
# The UVA store (the default canvas store, in /uva-beta: mount a volume there).
# The default goes in the older variable name, the lowest-priority one, so a
# deployment that sets ESTAMPES_UVA_BETA_DIR or ESTAMPES_UVA_DIR keeps its store.
# needs the OS flock backend for its writer lease.
# Fonts for server-side renders (render_canvas, PNG exports): sharp draws
# label text with system fonts, and without any every letter becomes a
# missing-glyph box. English and Traditional Chinese are built in:
# fonts-dejavu-core (Latin, Greek, Cyrillic, basic Arabic/Hebrew, about 3 MB)
# and Noto Sans CJK Regular only (one collection file, about 20 MB; the bold
# and serif files of fonts-noto-cjk are removed). 99-estampes-han.conf puts its
# Traditional Chinese face right after each DejaVu family, so Han characters
# in labels default to TC glyphs rather than the SC/JP/KR faces. Other scripts: mount
# a fonts folder (docs/DEPLOYMENT.md "Fonts for other languages").
RUN apt-get update && apt-get install -y --no-install-recommends util-linux fonts-dejavu-core fontconfig-config fonts-noto-cjk \
 && find /usr/share/fonts -name 'Noto*CJK*' ! -name 'NotoSansCJK-Regular.ttc' -delete \
 && test -f /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc \
 && printf '%s\n' '<?xml version="1.0"?>' '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">' \
    '<fontconfig>' \
    '<match target="pattern"><test qual="any" name="family"><string>DejaVu Sans</string></test><edit name="family" mode="append"><string>Noto Sans CJK TC</string></edit></match>' \
    '<match target="pattern"><test qual="any" name="family"><string>DejaVu Serif</string></test><edit name="family" mode="append"><string>Noto Sans CJK TC</string></edit></match>' \
    '<match target="pattern"><test qual="any" name="family"><string>DejaVu Sans Mono</string></test><edit name="family" mode="append"><string>Noto Sans CJK TC</string></edit></match>' \
    '</fontconfig>' \
    > /etc/fonts/conf.d/99-estampes-han.conf \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json server.js ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
# Fail the build if text cannot be rendered (see scripts/check-fonts.mjs).
RUN node scripts/check-fonts.mjs --require cjk,cjk-tc
# Run as the image's unprivileged "node" user (uid 1000). /data is created
# here so a new named volume starts owned by that user.
RUN chmod -R u=rwX,go=rX /app \
 && mkdir -p /data /run/estampes-cas /uva-beta && chown node:node /data /run/estampes-cas /uva-beta && chmod 700 /uva-beta
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
