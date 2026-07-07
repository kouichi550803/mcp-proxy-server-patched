# Default base image for standalone builds. For addons, this is overridden by build.yaml.
ARG BUILD_FROM=nikolaik/python-nodejs:python3.12-nodejs23


FROM $BUILD_FROM AS base
ARG NODE_VERSION=22
ARG BUILD_FROM
WORKDIR /mcp-proxy-server

ARG PRE_INSTALLED_PIP_PACKAGES_ARG=""
ARG PRE_INSTALLED_NPM_PACKAGES_ARG=""
ARG PRE_INSTALLED_INIT_COMMAND_ARG=""

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    build-essential \
    python3-dev \
    libffi-dev \
    libssl-dev \
    curl \
    unzip \
    ca-certificates \
    bash \
    ffmpeg \
    git \
    vim \
    dnsutils \
    iputils-ping \
    tini \
    gnupg \
    golang \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN if echo "$BUILD_FROM" | grep -q "home-assistant"; then \
    echo "Addon build detected (BUILD_FROM: $BUILD_FROM). Performing addon-specific OS setup." && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 python3-pip && \
    pip3 install uv --no-cache-dir --break-system-packages && \
    echo "Installing Node.js v${NODE_VERSION} for addon..." && \
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" -o nodesource_setup.sh && \
    bash nodesource_setup.sh && \
    apt-get update && apt-get install -y nodejs && \
    echo "Cleaning up apt cache for addon OS setup..." && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*; \
    else \
    echo "Standalone build detected (BUILD_FROM: $BUILD_FROM). Skipping addon-specific OS setup."; \
    fi

RUN npm install -g pnpm bun

RUN if [ -n "$PRE_INSTALLED_PIP_PACKAGES_ARG" ]; then \
      echo "Installing pre-defined PIP packages: $PRE_INSTALLED_PIP_PACKAGES_ARG" && \
      pip install --break-system-packages --no-cache-dir $PRE_INSTALLED_PIP_PACKAGES_ARG; \
    else \
      echo "Skipping pre-defined PIP packages installation."; \
    fi

RUN if [ -n "$PRE_INSTALLED_NPM_PACKAGES_ARG" ]; then \
      echo "Installing pre-defined NPM packages: $PRE_INSTALLED_NPM_PACKAGES_ARG" && \
      npm install -g $PRE_INSTALLED_NPM_PACKAGES_ARG; \
    else \
      echo "Skipping pre-defined NPM packages installation."; \
    fi

RUN if [ -n "$PRE_INSTALLED_INIT_COMMAND_ARG" ]; then \
      echo "Running pre-defined init command: $PRE_INSTALLED_INIT_COMMAND_ARG" && \
      eval $PRE_INSTALLED_INIT_COMMAND_ARG; \
    else \
      echo "Skipping pre-defined init command."; \
    fi

COPY . .

RUN if echo "$BUILD_FROM" | grep -q "home-assistant"; then \
    echo "Addon build: Copying rootfs contents..." && \
    if [ -d "rootfs" ]; then \
      cp -r rootfs/. / ; \
    else \
      echo "Warning: rootfs directory not found, skipping copy."; \
    fi; \
  else \
    echo "Standalone build: Skipping rootfs copy."; \
  fi

RUN npm install
RUN npm run build

ENV PORT=3663
ENV ENABLE_ADMIN_UI=false
ENV ADMIN_USERNAME=admin
ENV ADMIN_PASSWORD=password
ENV TOOLS_FOLDER=/tools

VOLUME /mcp-proxy-server/config
VOLUME /tools

EXPOSE 3663
