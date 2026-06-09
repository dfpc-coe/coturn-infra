ARG BUILDPLATFORM
ARG COTURN_BASE_IMAGE=ubuntu:22.04

FROM --platform=$BUILDPLATFORM ${COTURN_BASE_IMAGE} AS coturn-builder

RUN apt-get update && apt-get install -y \
    coturn \
    && rm -rf /var/lib/apt/lists/*

# Copy coturn binary from builder
COPY --from=coturn-builder /usr/sbin/turnserver /usr/sbin/turnserver
COPY --from=coturn-builder /usr/bin/turnutils_* /usr/bin/

# Final Stage
FROM ${COTURN_BASE_IMAGE}

RUN apt-get update && apt-get install -y \
    aws-cli \
    jq \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Copy coturn binary
COPY --from=coturn-builder /usr/sbin/turnserver /usr/sbin/turnserver
COPY --from=coturn-builder /usr/bin/turnutils_* /usr/bin/

# Expose COTURN ports
EXPOSE 3478
EXPOSE 5349
EXPOSE 49152-65535/udp

COPY coturn.conf /etc/coturn/
COPY start /

ENTRYPOINT [ "/start" ]

ENTRYPOINT [ "/start" ]
