import cf from '@openaddresses/cloudfriend';
import fs from 'node:fs';
import { URL } from 'node:url';

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
        InstanceType: {
            Description: 'EC2 instance type for the coturn ECS capacity provider',
            Type: 'String',
            Default: 't4g.medium'
        },
        ECSOptimizedAMI: {
            Description: 'ARM64 ECS-optimized Amazon Linux 2023 AMI ID',
            Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
            Default: '/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id'
        },
        EnableExecute: {
            Description: 'Allow SSH into docker container - should only be enabled for limited debugging',
            Type: 'String',
            AllowedValues: ['true', 'false'],
            Default: 'false'
        }
    },
    Resources: {
        CoturnCluster: {
            Type: 'AWS::ECS::Cluster',
            Properties: {
                ClusterName: cf.join(['tak-vpc-', cf.ref('Environment'), '-coturn']),
                ClusterSettings: [{
                    Name: 'containerInsights',
                    Value: 'enhanced'
                }]
            }
        },
        Logs: {
            Type: 'AWS::Logs::LogGroup',
            Properties: {
                LogGroupName: cf.stackName,
                RetentionInDays: 7
            }
        },
        CoturnExecRole: {
            Type: 'AWS::IAM::Role',
            Properties: {
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
                Policies: [{
                    PolicyName: cf.join([cf.stackName, '-exec-logging']),
                    PolicyDocument: {
                        Statement: [{
                            Effect: 'Allow',
                            Action: [
                                'logs:CreateLogGroup',
                                'logs:CreateLogStream',
                                'logs:PutLogEvents',
                                'logs:DescribeLogStreams'
                            ],
                            Resource: [cf.join(['arn:', cf.partition, ':logs:*:*:*'])]
                        }]
                    }
                }],
                ManagedPolicyArns: [
                    cf.join(['arn:', cf.partition, ':iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'])
                ],
                Path: '/service-role/'
            }
        },
        CoturnTaskRole: {
            Type: 'AWS::IAM::Role',
            Properties: {
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
                Policies: [{
                    PolicyName: cf.join('-', [cf.stackName, 'task-policy']),
                    PolicyDocument: {
                        Statement: [{
                            Effect: 'Allow',
                            Action: [
                                'ssmmessages:CreateControlChannel',
                                'ssmmessages:CreateDataChannel',
                                'ssmmessages:OpenControlChannel',
                                'ssmmessages:OpenDataChannel'
                            ],
                            Resource: '*'
                        },{
                            Effect: 'Allow',
                            Action: [
                                'logs:CreateLogGroup',
                                'logs:CreateLogStream',
                                'logs:PutLogEvents',
                                'logs:DescribeLogStreams'
                            ],
                            Resource: [cf.join(['arn:', cf.partition, ':logs:*:*:*'])]
                        }]
                    }
                }]
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
                Cpu: 1024,
                Memory: 3584,
                NetworkMode: 'host',
                RequiresCompatibilities: ['EC2'],
                RuntimePlatform: {
                    CpuArchitecture: 'ARM64',
                    OperatingSystemFamily: 'LINUX'
                },
                ExecutionRoleArn: cf.getAtt('CoturnExecRole', 'Arn'),
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
                Domain: 'vpc',
                Tags: [{
                    Key: 'Name',
                    Value: cf.join([cf.stackName, '-subnet-a'])
                }]
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
                    InstanceType: cf.ref('InstanceType'),
                    IamInstanceProfile: {
                        Arn: cf.getAtt('ContainerInstanceProfile', 'Arn')
                    },
                    MetadataOptions: {
                        HttpEndpoint: 'enabled',
                        HttpTokens: 'required'
                    },
                    NetworkInterfaces: [{
                        DeviceIndex: 0,
                        AssociatePublicIpAddress: true,
                        Groups: [cf.ref('CoturnSecurityGroup')]
                    }],
                    UserData: cf.base64(cf.sub(
                        fs.readFileSync(new URL('./coturn.sh', import.meta.url), 'utf8'),
                        {
                            AllocationId: cf.getAtt('ELBEIPSubnetA', 'AllocationId'),
                            ClusterName: cf.join(['tak-vpc-', cf.ref('Environment'), '-coturn'])
                        }
                    )),
                    TagSpecifications: [{
                        ResourceType: 'instance',
                        Tags: [{
                            Key: 'Name',
                            Value: cf.stackName
                        }]
                    },{
                        ResourceType: 'volume',
                        Tags: [{
                            Key: 'Name',
                            Value: cf.stackName
                        }]
                    }]
                }
            }
        },
        CoturnAutoScalingGroup: {
            Type: 'AWS::AutoScaling::AutoScalingGroup',
            UpdatePolicy: {
                AutoScalingRollingUpdate: {
                    MinInstancesInService: 0,
                    MaxBatchSize: 1,
                    WaitOnResourceSignals: false,
                    PauseTime: 'PT5M'
                }
            },
            Properties: {
                AutoScalingGroupName: cf.stackName,
                VPCZoneIdentifier: [
                    cf.importValue(cf.join(['tak-vpc-', cf.ref('Environment'), '-subnet-public-a'])),
                    cf.importValue(cf.join(['tak-vpc-', cf.ref('Environment'), '-subnet-public-b']))
                ],
                HealthCheckType: 'EC2',
                HealthCheckGracePeriod: 300,
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
                },{
                    Key: 'AmazonECSManaged',
                    Value: 'true',
                    PropagateAtLaunch: true
                }]
            },
            DependsOn: ['CoturnLaunchTemplate']
        },
        CoturnCapacityProvider: {
            Type: 'AWS::ECS::CapacityProvider',
            Properties: {
                Name: cf.stackName,
                AutoScalingGroupProvider: {
                    AutoScalingGroupArn: cf.ref('CoturnAutoScalingGroup'),
                    ManagedScaling: {
                        Status: 'ENABLED',
                        TargetCapacity: 100,
                        MinimumScalingStepSize: 1,
                        MaximumScalingStepSize: 1,
                        InstanceWarmupPeriod: 300
                    },
                    ManagedTerminationProtection: 'DISABLED'
                },
                Tags: [{
                    Key: 'Name',
                    Value: cf.stackName
                }]
            }
        },
        CoturnClusterCapacityProviderAssociation: {
            Type: 'AWS::ECS::ClusterCapacityProviderAssociations',
            Properties: {
                Cluster: cf.ref('CoturnCluster'),
                CapacityProviders: [
                    cf.ref('CoturnCapacityProvider')
                ],
                DefaultCapacityProviderStrategy: [{
                    CapacityProvider: cf.ref('CoturnCapacityProvider'),
                    Weight: 1
                }]
            }
        },
        CoturnService: {
            Type: 'AWS::ECS::Service',
            DependsOn: ['CoturnClusterCapacityProviderAssociation'],
            Properties: {
                ServiceName: cf.stackName,
                Cluster: cf.ref('CoturnCluster'),
                TaskDefinition: cf.ref('CoturnTaskDefinition'),
                CapacityProviderStrategy: [{
                    CapacityProvider: cf.ref('CoturnCapacityProvider'),
                    Weight: 1
                }],
                PropagateTags: 'SERVICE',
                EnableExecuteCommand: cf.ref('EnableExecute'),
                DesiredCount: 1,
                DeploymentConfiguration: {
                    MinimumHealthyPercent: 100,
                    MaximumPercent: 200
                }
            }
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
        },
        CoturnCluster: {
            Description: 'ECS cluster running the COTURN service',
            Value: cf.ref('CoturnCluster')
        },
        CoturnCapacityProvider: {
            Description: 'ECS capacity provider used by the COTURN service',
            Value: cf.ref('CoturnCapacityProvider')
        }
    }
}
