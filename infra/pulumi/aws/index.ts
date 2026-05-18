import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { bootstrapArgoCd } from "../components/argocd";
import { getTrinityConfig } from "../components/config";
import { deployMandelbrotService } from "../components/mandelbrot";
import { commonLabels, resourceName } from "../components/naming";
import {
  createExternalSecretsServiceAccount,
  externalSecretsNamespaceName,
  externalSecretsServiceAccountName,
  grafanaCloudLogsSecretName,
  grafanaCloudRemoteWriteSecretName,
  grafanaCloudTracesSecretName,
  secretsDemoSecretName,
} from "../components/secrets";

const {
  environment,
  region,
  kubernetesVersion,
  gitRepositoryUrl,
  gitRevision,
} = getTrinityConfig();
const trinityConfig = new pulumi.Config("trinity");
const awsProfile = trinityConfig.get("awsProfile");
const awsKubeconfigRoleArn = trinityConfig.get("awsKubeconfigRoleArn");
const secretNameSuffix = trinityConfig.get("secretNameSuffix");
const awsClusterAdminPrincipalArn =
  trinityConfig.get("awsClusterAdminPrincipalArn") ??
  process.env.AWS_CLUSTER_ADMIN_PRINCIPAL_ARN;
const clusterName = resourceName("aws", environment, "cluster");
const labels = commonLabels("aws", environment);
const awsClusterAdminPrincipalArns = [
  ...new Set(
    [
      awsClusterAdminPrincipalArn,
      awsKubeconfigRoleArn,
    ].filter((arn): arn is string => Boolean(arn)),
  ),
];
const awsClusterAdminAccessEntries =
  awsClusterAdminPrincipalArns.length > 0
    ? Object.fromEntries(
        awsClusterAdminPrincipalArns.map((principalArn, index) => [
          `admin-${index}`,
          {
            principalArn,
            accessPolicies: {
              clusterAdmin: {
                policyArn:
                  "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy",
                accessScope: {
                  type: "cluster",
                },
              },
            },
            tags: labels,
          },
        ]),
      )
    : undefined;

const provider = new aws.Provider("aws-provider", {
  region: region as aws.Region,
  profile: awsProfile,
});

const eksSupportedAvailabilityZones =
  region === "us-east-1"
    ? ["us-east-1a", "us-east-1b", "us-east-1c", "us-east-1d", "us-east-1f"]
    : undefined;

const defaultVpc = aws.ec2.getVpc(
  { default: true },
  { provider },
);

const subnetIds = defaultVpc.then((vpc) =>
  aws.ec2
    .getSubnets(
      {
        filters: [
          { name: "vpc-id", values: [vpc.id] },
          ...(eksSupportedAvailabilityZones
            ? [
                {
                  name: "availability-zone",
                  values: eksSupportedAvailabilityZones,
                },
              ]
            : []),
        ],
      },
      { provider },
    )
    .then((subnets) => subnets.ids.slice(0, 2)),
);

const nodeRole = new aws.iam.Role(
  `${clusterName}-node-role`,
  {
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: {
            Service: "ec2.amazonaws.com",
          },
        },
      ],
    }),
    tags: labels,
  },
  { provider },
);

const cluster = new eks.Cluster(
  clusterName,
  {
    name: clusterName,
    version: kubernetesVersion,
    authenticationMode: eks.AuthenticationMode.ApiAndConfigMap,
    accessEntries: awsClusterAdminAccessEntries,
    createOidcProvider: true,
    subnetIds,
    skipDefaultNodeGroup: true,
    instanceRoles: [nodeRole],
    tags: labels,
  },
  { providers: { aws: provider } },
);

const nodeRolePolicyAttachments = [
  "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
  "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
  "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
].map(
  (policyArn) =>
    new aws.iam.RolePolicyAttachment(
      `${clusterName}-${policyArn.split("/").pop()}`,
      {
        role: nodeRole.name,
        policyArn,
      },
      { provider },
    ),
);

const nodeGroup = new eks.ManagedNodeGroup(
  `${clusterName}-nodes`,
  {
    cluster,
    nodeRole,
    subnetIds,
    instanceTypes: ["t3.medium"],
    scalingConfig: {
      desiredSize: 2,
      minSize: 1,
      maxSize: 3,
    },
    tags: labels,
  },
  {
    dependsOn: nodeRolePolicyAttachments,
    providers: { aws: provider },
  },
);

export const name = cluster.eksCluster.name;
export const nodeGroupName = nodeGroup.nodeGroup.nodeGroupName;

const kubeconfig = cluster
  .getKubeconfig({
    profileName: awsProfile,
    roleArn: awsKubeconfigRoleArn,
  })
  .apply((result) => result.result);

const k8sProvider = new k8s.Provider(`${clusterName}-k8s-provider`, {
  kubeconfig,
  clusterIdentifier: cluster.eksCluster.id,
});

const secretsDemoAwsSecretName = secretsDemoSecretName(
  "aws",
  environment,
  secretNameSuffix,
);
const grafanaCloudAwsRemoteWriteSecretNames = [
  grafanaCloudRemoteWriteSecretName("aws", environment, "url", secretNameSuffix),
  grafanaCloudRemoteWriteSecretName(
    "aws",
    environment,
    "username",
    secretNameSuffix,
  ),
  grafanaCloudRemoteWriteSecretName(
    "aws",
    environment,
    "password",
    secretNameSuffix,
  ),
];
const grafanaCloudAwsLogsSecretNames = [
  grafanaCloudLogsSecretName("aws", environment, "url", secretNameSuffix),
  grafanaCloudLogsSecretName("aws", environment, "username", secretNameSuffix),
  grafanaCloudLogsSecretName("aws", environment, "password", secretNameSuffix),
];
const grafanaCloudAwsTracesSecretNames = [
  grafanaCloudTracesSecretName("aws", environment, "endpoint", secretNameSuffix),
  grafanaCloudTracesSecretName("aws", environment, "username", secretNameSuffix),
  grafanaCloudTracesSecretName("aws", environment, "password", secretNameSuffix),
];
const externalSecretsAwsSecretNames = [
  secretsDemoAwsSecretName,
  ...grafanaCloudAwsRemoteWriteSecretNames,
  ...grafanaCloudAwsLogsSecretNames,
  ...grafanaCloudAwsTracesSecretNames,
];
const awsCallerIdentity = aws.getCallerIdentityOutput({}, { provider });

const externalSecretsRole = new aws.iam.Role(
  `${clusterName}-external-secrets`,
  {
    name: `${clusterName}-external-secrets`,
    assumeRolePolicy: pulumi
      .all([cluster.oidcProviderArn, cluster.oidcIssuer])
      .apply(([providerArn, issuer]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: {
                Federated: providerArn,
              },
              Action: "sts:AssumeRoleWithWebIdentity",
              Condition: {
                StringEquals: {
                  [`${issuer}:aud`]: "sts.amazonaws.com",
                  [`${issuer}:sub`]:
                    `system:serviceaccount:${externalSecretsNamespaceName}:${externalSecretsServiceAccountName}`,
                },
              },
            },
          ],
        }),
      ),
    tags: {
      ...labels,
      component: "external-secrets",
    },
  },
  { provider },
);

new aws.iam.RolePolicy(
  `${clusterName}-external-secrets-read-demo-secret`,
  {
    role: externalSecretsRole.id,
    policy: awsCallerIdentity.accountId.apply((accountId) => {
      const secretArns = externalSecretsAwsSecretNames.map(
        (name) => `arn:aws:secretsmanager:${region}:${accountId}:secret:${name}-*`,
      );

      return JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "secretsmanager:GetResourcePolicy",
              "secretsmanager:GetSecretValue",
              "secretsmanager:DescribeSecret",
              "secretsmanager:ListSecretVersionIds",
            ],
            Resource: secretArns,
          },
        ],
      });
    }),
  },
  { provider },
);

const externalSecretsServiceAccount = createExternalSecretsServiceAccount({
  cloud: "aws",
  environment,
  provider: k8sProvider,
  annotations: {
    "eks.amazonaws.com/role-arn": externalSecretsRole.arn,
  },
  dependsOn: [nodeGroup],
});

const mandelbrotElasticIps = [0, 1].map(
  (index) =>
    new aws.ec2.Eip(
      `${clusterName}-mandelbrot-${index + 1}`,
      {
        domain: "vpc",
        tags: {
          ...labels,
          component: "mandelbrot",
        },
      },
      { provider },
    ),
);

const mandelbrotLoadBalancerSubnetIds = pulumi.output(subnetIds);
const mandelbrotEipAllocationIds = pulumi
  .all(mandelbrotElasticIps.map((elasticIp) => elasticIp.allocationId))
  .apply((allocationIds) => allocationIds.join(","));

const mandelbrotService = deployMandelbrotService({
  cloud: "aws",
  environment,
  provider: k8sProvider,
  annotations: {
    "service.beta.kubernetes.io/aws-load-balancer-type": "nlb",
    "service.beta.kubernetes.io/aws-load-balancer-scheme": "internet-facing",
    "service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled":
      "true",
    "service.beta.kubernetes.io/aws-load-balancer-healthcheck-protocol": "HTTP",
    "service.beta.kubernetes.io/aws-load-balancer-healthcheck-path": "/readyz",
    "service.beta.kubernetes.io/aws-load-balancer-subnets":
      mandelbrotLoadBalancerSubnetIds.apply((ids) => ids.join(",")),
    "service.beta.kubernetes.io/aws-load-balancer-eip-allocations":
      mandelbrotEipAllocationIds,
  },
  dependsOn: [nodeGroup, ...mandelbrotElasticIps],
});

const argocd = bootstrapArgoCd({
  cloud: "aws",
  environment,
  provider: k8sProvider,
  repositoryUrl: gitRepositoryUrl,
  revision: gitRevision,
  dependsOn: [cluster, nodeGroup, externalSecretsServiceAccount.serviceAccount],
});

export { kubeconfig };
export const argocdNamespace = argocd.namespace;
export const argocdRootApplicationName = argocd.rootApplicationName;
export const mandelbrotNamespace = mandelbrotService.namespace;
export const mandelbrotServiceName = mandelbrotService.serviceName;
export const mandelbrotOriginHosts = pulumi.all(
  mandelbrotElasticIps.map((elasticIp) => elasticIp.publicIp),
);
export const mandelbrotOriginHost = mandelbrotOriginHosts.apply(
  ([primaryHost]) => primaryHost,
);
export const mandelbrotStageUrl = pulumi.interpolate`http://${mandelbrotOriginHost}`;
export const externalSecretsAwsRoleArn = externalSecretsRole.arn;
export {
  secretsDemoAwsSecretName,
  grafanaCloudAwsRemoteWriteSecretNames,
  grafanaCloudAwsLogsSecretNames,
  grafanaCloudAwsTracesSecretNames,
};
