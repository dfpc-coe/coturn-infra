# TAK COTURN Server Infra

<p align=center>Infrastructure to support a TURN/STUN server for WebRTC NAT traversal</p>

## Overview

This repository contains the infrastructure for deploying a COTURN (TURN/STUN) server that enables WebRTC NAT traversal for CloudTAK. The COTURN server allows WebRTC clients behind NATs and firewalls to establish peer-to-peer connections.

## Architecture

The COTURN server is deployed on EC2 instances with host networking for optimal WebRTC performance. This approach provides:

- **Direct network access** - No NAT overhead for UDP traffic
- **Better performance** - Lower latency for TURN relay connections
- **Full port range** - Access to all relay ports (49152-65535/udp)

## Ports

| Port | Protocol | Notes |
| ---- | -------- | ----- |
| 3478 | TCP/UDP  | TURN/STUN server |
| 5349 | TCP/UDP  | TURNS (TURN over TLS) |
| 49152-65535 | UDP | TURN relay port range |

## AWS Deployment

### Deployment

From the root directory, install the deploy dependencies:

```sh
npm install
```

Deployment to AWS is handled via AWS CloudFormation. The template can be found in the `./cloudformation` directory. The deployment itself is performed by [Deploy](https://github.com/openaddresses/deploy) which was installed in the previous step.

The deploy tool can be run via the following:

```sh
npx deploy
```

To install it globally - view the deploy [README](https://github.com/openaddresses/deploy)

Deploy uses your existing AWS credentials. Ensure that your `~/.aws/credentials` has an entry like:

```
[coe]
aws_access_key_id = <redacted>
aws_secret_access_key = <redacted>
```

Deployment can then be performed via the following:

```
npx deploy create <stack>
npx deploy update <stack>
npx deploy info <stack> --outputs
npx deploy info <stack> --parameters
```

Stacks can be created, deleted, cancelled, etc all via the deploy tool. For further information information about `deploy` functionality run the following for help.

```sh
npx deploy
```

Further help about a specific command can be obtained via something like:

```sh
npx deploy info --help
```

## Configuration

The COTURN server is configured via environment variables and AWS Secrets Manager. The secret `tak-cloudtak-${Environment}/coturn/secret` should contain the TURN secret used for authentication.

## TURN/STUN Server Configuration

For WebRTC clients to use the COTURN server, configure the ICE servers:

```javascript
const configuration = {
    iceServers: [
        {
            urls: `turn:${STUN_HOST}:3478`,
            username: `${USERNAME}`,
            credential: `${COTURN_SECRET}`
        },
        {
            urls: `turns:${STUN_HOST}:5349?transport=tcp`,
            username: `${USERNAME}`,
            credential: `${COTURN_SECRET}`
        }
    ]
};
```

## License

ISC
