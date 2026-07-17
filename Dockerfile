FROM docker.io/cloudflare/sandbox:0.9.0

# an earlier revision — baseline developer tools.
#
# The cloud agent does NOT have a local repo checkout. Tier 0
# read/write/list/edit reads the agent's scratch workspace (drafts,
# artifacts, intermediate files); it is NOT the AgentThursday source tree.
# Source access goes through Content Sources or, when full repo
# state is genuinely needed, `git clone` inside this sandbox.
# Preinstalling the obvious tools means the model can reach for
# `rg` / `jq` / `git` / `curl` / `python3` directly without burning
# a turn on `apt-get install`.
#
# Notes:
# - cloudflare/sandbox:0.9.0 is Debian-based; we use apt-get.
# - DEBIAN_FRONTEND=noninteractive prevents tzdata-style prompts
#   that would hang the build.
# - `--no-install-recommends` keeps the layer lean. an earlier revision:
#   `python3-pip` was dropped from the install list (largest
#   contributor to image bloat by far; spec marked it optional)
#   so the container cold-start stays under the sandbox_exec
#   timeout. If the model needs pip later, it can still install
#   it on demand via sandbox_exec — the agent loop now releases
#   on `timed_out:true` so a slow apt install no longer pins it.
# - apt-get clean + removing /var/lib/apt/lists/* trims the layer.
# - Inherits the base image ENTRYPOINT/CMD (sandbox runtime); we
#   explicitly do not override them.
# - No secrets, no build args.
ENV DEBIAN_FRONTEND=noninteractive
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        jq \
        python3 \
        ripgrep; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# sandbox dependency / toolchain prewarm.
#
# an earlier revision–190f bounded the runtime bootstrap install but production
# `gate_typecheck` still couldn't fit a cold `npm install` of AgentThursday's
# full devDependencies inside the sandbox's 300s request budget, so it
# never reached 190d phase evidence (`phase_started` / `phases[]`).
#
# Bake the dependency `node_modules` into the image at build time
# (where there is no per-request timebox), then have gateRunner
# symlink the prewarmed dir into the materialized checkout. Marker
# probe (`./node_modules/.bin/tsc` etc.) follows the symlink, sees
# the binary, and bootstrap short-circuits to `skipped` — phases run
# directly.
#
# Inputs are exactly two static files: `package.json` and
# `web/package.json`. No model input. No lockfile commit (M8.0 deny
# is preserved). `--no-package-lock` keeps the prewarm dirs free of
# generated lockfiles. `--include=dev` ensures `tsc / vite / wrangler`
# land regardless of NODE_ENV in the sandbox profile.
#
# Drift behavior: if the image's baked `package.json` differs from a
# materialized checkout's, tsc may report module-not-found inside a
# phase — that's acceptable evidence (190g spec: phases must be
# reachable; pass/fail of a phase is allowed). When this gets noisy,
# rebuild the image. Runtime install fallback (190f) still fires when
# no prewarm dir is present, so dev-mode behavior is unchanged.
COPY package.json /opt/agentthursday/prewarm-root/package.json
COPY web/package.json /opt/agentthursday/prewarm-web/package.json
RUN set -eux; \
    cd /opt/agentthursday/prewarm-root && \
        npm install \
            --include=dev \
            --no-package-lock \
            --no-audit \
            --no-fund \
            --no-progress \
            --loglevel=error; \
    cd /opt/agentthursday/prewarm-web && \
        npm install \
            --include=dev \
            --no-package-lock \
            --no-audit \
            --no-fund \
            --no-progress \
            --loglevel=error; \
    npm cache clean --force

EXPOSE 8080
