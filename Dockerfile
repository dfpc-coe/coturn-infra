ARG BUILDPLATFORM
ARG COTURN_BASE_IMAGE=coturn/coturn:4.12.0-alpine3.23

FROM ${COTURN_BASE_IMAGE}

# Copy custom configuration
COPY coturn.conf /etc/coturn/turnserver.conf

# Copy start script
COPY start /
