ARG BUILDPLATFORM
ARG COTURN_BASE_IMAGE=coturn/coturn:4.12.0-alpine3.23

FROM ${COTURN_BASE_IMAGE}

USER root

# envsubst (gettext) renders the config template; curl resolves the public IP
RUN apk add --no-cache gettext curl

# Copy custom configuration template (rendered at startup by /start)
COPY coturn.conf /etc/coturn/turnserver.conf.template

# Copy start script
COPY start /start
RUN chmod +x /start

ENTRYPOINT ["/start"]
