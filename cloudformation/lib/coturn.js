import cf from '@openaddresses/cloudfriend';

const PORTS = [{
    Name: 'TURN-TCP',
    Port: 3478,
    Protocol: 'tcp',
    Description: 'TURN server TCP',
    Enabled: true
},{
    Name: 'TURN-UDP',
    Port: 3478,
    Protocol: 'udp',
    Description: 'TURN server UDP',
    Enabled: true
},{
    Name: 'TURNS-TCP',
    Port: 5349,
    Protocol: 'tcp',
    Description: 'TURN server TLS',
    Enabled: true
},{
    Name: 'TURNS-UDP',
    Port: 5349,
    Protocol: 'udp',
    Description: 'TURN server TLS UDP',
    Enabled: true
},{
    Name: 'RELAY-START',
    Port: 49152,
    Protocol: 'udp',
    Description: 'TURN relay port range start',
    Enabled: true
},{
    Name: 'RELAY-END',
    Port: 65535,
    Protocol: 'udp',
    Description: 'TURN relay port range end',
    Enabled: true
}].filter((p) => {
    return p.Enabled;
});

const containerEnvironment = [
    { Name: 'StackName', Value: cf.stackName },
    { Name: 'LOG_LEVEL', Value: cf.ref('LogLevel') },
    { Name: 'Environment', Value: cf.ref('Environment') },
    { Name: 'TURN_SECRET', Value: cf.sub('{{resolve:secretsmanager:tak-cloudtak-${Environment}/coturn/secret:SecretString::AWSCURRENT}}') },
    { Name: 'TURN_REALM', Value: cf.join(['turn.', cf.importValue(cf.join(['tak-vpc-', cf.ref('Environment'), '-hosted-zone-name']))]) },
    { Name: 'AWS_DEFAULT_REGION', Value: cf.region },
    { Name: 'AWS_REGION', Value: cf.region }
];

const portMappings = PORTS.map((port) => {
    return {
        ContainerPort: port.Port,
        HostPort: port.Port,
        Protocol: port.Protocol
    };
});

function containerDefinition(name) {
    return {
        Name: name,
        Image: cf.join([cf.accountId, '.dkr.ecr.', cf.region, '.amazonaws.com/tak-vpc-', cf.ref('Environment'), '-coturn:', cf.ref('GitSha')]),
        PortMappings: portMappings,
        Environment: containerEnvironment,
        LogConfiguration: {
            LogDriver: 'awslogs',
            Options: {
                'awslogs-group': cf.stackName,
                'awslogs-region': cf.region,
                'awslogs-stream-prefix': cf.stackName,
                'awslogs-create-group': true
            }
        },
        Essential: true
    };
}

const Resources = {
    Logs: {
        Type: 'AWS::Logs::LogGroup',
        Properties: {
            LogGroupName: cf.stackName,
            RetentionInDays: 7
        }
    },
    CoturnTaskRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
            RoleName: cf.stackName,
            AssumeRolePolicyDocument: {
                Version: '2012-10-17',
                Statement: [{
                    Effect: 'Allow',
                    Principal: {
                        Service: 'ecs-tasks.amazonaws.com'
                    },
                    Action: 'sts:AssumeRole'
                }]
            },
            ManagedPolicyArns: [
                cf.join(['arn:', cf.partition, ':iam::aws:policy/CloudWatchLogsFullAccess']),
                cf.join(['arn:', cf.partition, ':iam::aws:policy/SecretsManagerReadWrite'])
            ]
        }
    },
    CoturnSecurityGroup: {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
            GroupName: cf.join('-', [cf.stackName, 'sg']),
            GroupDescription: 'Allow COTURN traffic',
            VpcId: cf.importValue(cf.join(['tak-vpc-', cf.ref('Environment'), '-vpc'])),
            SecurityGroupIngress: PORTS.map((port) => {
                return {
                    IpProtocol: port.Protocol,
                    FromPort: port.Port,
                    ToPort: port.Port,
                    CidrIp: '0.0.0.0/0',
                    Description: port.Description
                };
            })
        }
    },
    CoturnTaskDefinition: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: {
            Family: cf.stackName,
            Cpu: 256,
            Memory: 512,
            NetworkMode: 'host',
            RequiresCompatibilities: ['EC2'],
            ExecutionRoleArn: cf.getAtt('CoturnTaskRole', 'Arn'),
            TaskRoleArn: cf.getAtt('CoturnTaskRole', 'Arn'),
            ContainerDefinitions: [
                containerDefinition('coturn')
            ]
        }
    },
    CoturnDNSRecord: {
        Type: 'AWS::Route53::RecordSet',
        Properties: {
            HostedZoneId: cf.importValue(cf.join(['tak-vpc-', cf.ref('Environment'), '-hosted-zone-id'])),
            Type : 'A',
            Name: cf.join(['turn', '.', cf.importValue(cf.join(['tak-vpc-', cf.ref('Environment'), '-hosted-zone-name']))]),
            Comment: cf.join(' ', [cf.stackName, 'DNS Entry']),
            TTL: '60',
            ResourceRecords: [cf.ref('CoturnEIPSubnetA')]
        }
    },
    CoturnEIPSubnetA: {
        Type: 'AWS::EC2::EIP',
        Properties: {
            Domain: 'vpc'
        }
    },
    CoturnENI: {
        Type: 'AWS::EC2::NetworkInterface',
        Properties: {
            Description: 'COTURN ENI for EIP association',
            SubnetId: cf.importValue(cf.join(['tak-vpc-', cf.ref('Environment'), '-subnet-public-a'])),
            GroupSet: [cf.ref('CoturnSecurityGroup')],
            SourceDestCheck: false
        }
    },
    CoturnEIPAssociation: {
        Type: 'AWS::EC2::EIPAssociation',
        Properties: {
            AllocationId: cf.ref('CoturnEIPSubnetA'),
            NetworkInterfaceId: cf.getAtt('CoturnENI', 'NetworkInterfaceId')
        },
        DependsOn: ['CoturnENI']
    },
    CoturnLaunchTemplate: {
        Type: 'AWS::EC2::LaunchTemplate',
        Properties: {
            LaunchTemplateName: cf.stackName,
            LaunchTemplateData: {
                ImageId: cf.ref('AWS::NoValue'),
                InstanceType: 't3.medium',
                IamInstanceProfile: {
                    Name: cf.importValue(cf.join(['tak-vpc-', cf.ref('Environment'), '-ecs-instance-profile']))
                },
                SecurityGroupIds: [cf.ref('CoturnSecurityGroup')],
                UserData: cf.base64(cf.join([
                    '#!/bin/bash\n',
                    'set -euxo pipefail\n',
                    '\n',
                    '# Configure sysctl for WebRTC\n',
                    'cat <<EOF > /etc/sysctl.d/99-coturn.conf\n',
                    'net.core.rmem_max = 8388608\n',
                    'net.core.rmem_default = 4194304\n',
                    'net.core.wmem_max = 8388608\n',
                    'net.core.wmem_default = 4194304\n',
                    'EOF\n',
                    '\n',
                    'sysctl --system || true\n',
                    '\n',
                    '# Install AWS CLI if not present\n',
                    'if ! command -v aws >/dev/null 2>&1; then\n',
                    '    if command -v dnf >/dev/null 2>&1; then\n',
                    '        dnf install -y awscli || true\n',
                    '    elif command -v yum >/dev/null 2>&1; then\n',
                    '        yum install -y awscli || true\n',
                    '    fi\n',
                    'fi\n',
                    '\n',
                    '# Configure EIP association script\n',
                    'if command -v aws >/dev/null 2>&1; then\n',
                    '    cat <<EOF > /usr/local/bin/coturn-eip-association.sh\n',
                    '#!/bin/bash\n',
                    'set -euo pipefail\n',
                    '\n',
                    'wait_for_tcp_port() {\n',
                    '    timeout 1 bash -c \'exec 3<>"/dev/tcp/$1/$2"\' _ "$1" "$2" >/dev/null 2>&1\n',
                    '}\n',
                    '\n',
                    'token=$(curl --fail --silent --show-error --request PUT "http://169.254.169.254/latest/api/token" --header "X-aws-ec2-metadata-token-ttl-seconds: 21600")\n',
                    'instance_id=$(curl --fail --silent --show-error --header "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/instance-id")\n',
                    '\n',
                    'for attempt in {1..60}; do\n',
                    '    if ! wait_for_tcp_port 127.0.0.1 3478; then\n',
                    '        echo "Attempt $attempt: waiting for coturn listener on 127.0.0.1:3478"\n',
                    '        sleep 10\n',
                    '        continue\n',
                    '    fi\n',
                    '\n',
                    '    if aws ec2 associate-address --region "$1" --instance-id "$instance_id" --allocation-id "$2" --allow-reassociation; then\n',
                    '        exit 0\n',
                    '    fi\n',
                    '\n',
                    '    sleep 10\n',
                    'done\n',
                    '\n',
                    'echo "warning: failed to associate EIP after retries"\n',
                    'exit 1\n',
                    'EOF\n',
                    '\n',
                    'chmod 755 /usr/local/bin/coturn-eip-association.sh\n',
                    '\n',
                    'cat <<EOF > /etc/systemd/system/coturn-eip-association.service\n',
                    '[Unit]\n',
                    'Description=Associate coturn EIP after local task readiness\n',
                    'Wants=network-online.target docker.service ecs.service\n',
                    'After=network-online.target docker.service ecs.service\n',
                    '\n',
                    '[Service]\n',
                    'Type=simple\n',
                    'ExecStart=/usr/local/bin/coturn-eip-association.sh ${AWS::Region} ${AllocationId}\n',
                    'Restart=on-failure\n',
                    'RestartSec=10s\n',
                    '\n',
                    '[Install]\n',
                    'WantedBy=multi-user.target\n',
                    'EOF\n',
                    '\n',
                    'systemctl daemon-reload\n',
                    'systemctl enable coturn-eip-association.service\n',
                    'systemctl start --no-block coturn-eip-association.service\n',
                    'echo "Coturn EIP association service queued; user-data can exit while it waits for port 3478."\n',
                    'fi\n'
                ]))
            }
        }
    },
    CoturnAutoScalingGroup: {
        Type: 'AWS::AutoScaling::AutoScalingGroup',
        Properties: {
            AutoScalingGroupName: cf.stackName,
            VPCZoneIdentifier: [
                cf.importValue(cf.join(['tak-vpc-', cf.ref('Environment'), '-subnet-public-a'])),
                cf.importValue(cf.join(['tak-vpc-', cf.ref('Environment'), '-subnet-public-b']))
            ],
            HealthCheckType: 'EC2',
            MinSize: 1,
            MaxSize: 3,
            DesiredCapacity: 1,
            LaunchTemplate: {
                LaunchTemplateId: cf.ref('CoturnLaunchTemplate'),
                Version: '$Latest'
            },
            Tags: [{
                Key: 'Name',
                Value: cf.join('-', [cf.stackName, 'asg']),
                PropagateAtLaunch: true
            }]
        },
        DependsOn: ['CoturnLaunchTemplate']
    }
};

const Outputs = {
    CoturnEIP: {
        Description: 'COTURN EIP Address',
        Value: cf.ref('CoturnEIPSubnetA')
    }
};

export default {
    Resources,
    Outputs
}
