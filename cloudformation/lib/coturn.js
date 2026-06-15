import cf from '@openaddresses/cloudfriend';
import fs from 'node:fs';

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
}].filter((p) => {
    return p.Enabled;
});

// TURN relay port range (coturn min-port/max-port). Opened as a single
// contiguous range rather than per-port. With host networking the relay
// ports bind directly, so they are not declared as ECS PortMappings.
const RELAY_PORT_RANGE = {
    From: 49152,
    To: 65535,
    Protocol: 'udp'
};

export default {
    Parameters: {
        ECSOptimizedAMI: {
            Description: 'ARM64 ECS-optimized Amazon Linux 2023 AMI ID',
            Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
            Default: '/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id'
        },
    },
    Resources: {
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
                SecurityGroupIngress: [
                    ...PORTS.map((port) => {
                        return {
                            IpProtocol: port.Protocol,
                            FromPort: port.Port,
                            ToPort: port.Port,
                            CidrIp: '0.0.0.0/0',
                            Description: port.Description
                        };
                    }),
                    {
                        IpProtocol: RELAY_PORT_RANGE.Protocol,
                        FromPort: RELAY_PORT_RANGE.From,
                        ToPort: RELAY_PORT_RANGE.To,
                        CidrIp: '0.0.0.0/0',
                        Description: 'TURN relay port range'
                    }
                ]
            }
        },
        CoturnTaskDefinition: {
            Type: 'AWS::ECS::TaskDefinition',
            Properties: {
                Family: cf.stackName,
                Cpu: 2048,
                Memory: 4000,
                NetworkMode: 'host',
                RequiresCompatibilities: ['EC2'],
                ExecutionRoleArn: cf.getAtt('CoturnTaskRole', 'Arn'),
                TaskRoleArn: cf.getAtt('CoturnTaskRole', 'Arn'),
                ContainerDefinitions: [{
                    Name: cf.stackName,
                    Image: cf.join([cf.accountId, '.dkr.ecr.', cf.region, '.amazonaws.com/tak-vpc-', cf.ref('Environment'), '-coturn:', cf.ref('GitSha')]),
                    PortMappings: PORTS.map((port) => {
                        return {
                            ContainerPort: port.Port,
                            HostPort: port.Port,
                            Protocol: port.Protocol
                        };
                    }),
                    Environment: [
                        { Name: 'StackName', Value: cf.stackName },
                        { Name: 'LOG_LEVEL', Value: cf.ref('LogLevel') },
                        { Name: 'Environment', Value: cf.ref('Environment') },
                        { Name: 'TURN_SECRET', Value: cf.sub('{{resolve:secretsmanager:tak-cloudtak-${Environment}/coturn/secret:SecretString::AWSCURRENT}}') },
                        { Name: 'TURN_REALM', Value: cf.join(['turn.', cf.importValue(cf.join(['tak-vpc-', cf.ref('Environment'), '-hosted-zone-name']))]) },
                        { Name: 'EXTERNAL_IP', Value: cf.ref('ELBEIPSubnetA') },
                        { Name: 'AWS_DEFAULT_REGION', Value: cf.region },
                        { Name: 'AWS_REGION', Value: cf.region }
                    ],
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
                }]
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
                ResourceRecords: [cf.ref('ELBEIPSubnetA')]
            },
            DependsOn: ['ELBEIPSubnetA']
        },
        ELBEIPSubnetA: {
            Type: 'AWS::EC2::EIP',
            Properties: {
                Domain: 'vpc'
            }
        },
        ContainerInstanceRole: {
            Type: 'AWS::IAM::Role',
            Properties: {
                AssumeRolePolicyDocument: {
                    Version: '2012-10-17',
                    Statement: [{
                        Effect: 'Allow',
                        Principal: {
                            Service: 'ec2.amazonaws.com'
                        },
                        Action: 'sts:AssumeRole'
                    }]
                },
                Policies: [{
                    PolicyName: cf.join('-', [cf.stackName, 'eip-association']),
                    PolicyDocument: {
                        Statement: [{
                            Effect: 'Allow',
                            Action: [
                                'ec2:AssociateAddress',
                                'ec2:DescribeAddresses',
                                'ec2:DescribeInstances'
                            ],
                            Resource: '*'
                        }]
                    }
                }],
                ManagedPolicyArns: [
                    cf.join(['arn:', cf.partition, ':iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role']),
                    cf.join(['arn:', cf.partition, ':iam::aws:policy/AmazonSSMManagedInstanceCore'])
                ],
                Path: '/service-role/'
            }
        },
        ContainerInstanceProfile: {
            Type: 'AWS::IAM::InstanceProfile',
            Properties: {
                Path: '/service-role/',
                Roles: [cf.ref('ContainerInstanceRole')]
            },
            DependsOn: ['ContainerInstanceRole']
        },
        CoturnLaunchTemplate: {
            Type: 'AWS::EC2::LaunchTemplate',
            Properties: {
                LaunchTemplateName: cf.stackName,
                LaunchTemplateData: {
                    ImageId: cf.ref('ECSOptimizedAMI'),
                    InstanceType: 't4g.medium',
                    IamInstanceProfile: {
                        Arn: cf.getAtt('ContainerInstanceProfile', 'Arn')
                    },
                    SecurityGroupIds: [cf.ref('CoturnSecurityGroup')],
                    UserData: cf.base64(cf.sub([
                        fs.readFileSync(new URL('./coturn.sh', import.meta.url), 'utf8'),
                        {
                            AllocationId: cf.getAtt('ELBEIPSubnetA', 'AllocationId'),
                            ClusterName: cf.join(['tak-vpc-', cf.ref('Environment'), '-media'])
                        }
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
                    Version: cf.getAtt('CoturnLaunchTemplate', 'LatestVersionNumber')
                },
                Tags: [{
                    Key: 'Name',
                    Value: cf.join('-', [cf.stackName, 'asg']),
                    PropagateAtLaunch: true
                }]
            },
            DependsOn: ['CoturnLaunchTemplate']
        },
        CoturnSecret: {
            Type: 'AWS::SecretsManager::Secret',
            DeletionPolicy: 'Retain',
            Properties: {
                Description: cf.join([cf.stackName, ' COTURN Secret']),
                GenerateSecretString: {
                    ExcludePunctuation: true,
                    PasswordLength: 32
                },
                Name: cf.join(['tak-cloudtak-', cf.ref('Environment'), '/coturn/secret']),
                KmsKeyId: cf.ref('KMS')
            }
        }
    },
    Outputs: {
        CoturnEIP: {
            Description: 'COTURN EIP Address',
            Value: cf.ref('ELBEIPSubnetA')
        }
    }
}
