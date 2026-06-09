import cf from '@openaddresses/cloudfriend';
import Coturn from './lib/coturn.js';
import KMS from './lib/kms.js';

export default cf.merge(
    Coturn, KMS,
    {
        Description: 'Template for @tak-ps/coturn - TURN/STUN server for WebRTC NAT traversal',
        Parameters: {
            GitSha: {
                Description: 'GitSha that is currently being deployed',
                Type: 'String'
            },
            Environment: {
                Description: 'VPC/ECS Stack to deploy into',
                Type: 'String',
                Default: 'prod'
            },
            LogLevel: {
                Description: 'Log level for the COTURN server',
                Type: 'String',
                Default: 'info',
                AllowedValues: ['debug', 'info', 'warning', 'error']
            }
        }
    }
);
