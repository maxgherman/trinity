import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import { bootstrapArgoCd } from "../components/argocd";
import { getTrinityConfig } from "../components/config";
import { commonLabels, resourceName } from "../components/naming";

const {
  environment,
  region,
  kubernetesVersion,
  gitRepositoryUrl,
  gitRevision,
} = getTrinityConfig();

const provider = new aws.Provider("aws-provider", {
  region: region as aws.Region,
});

const clusterName = resourceName("aws", environment, "cluster");
const labels = commonLabels("aws", environment);

const eksSupportedAvailabilityZones =
  region === "us-east-1"
    ? ["us-east-1a", "us-east-1b", "us-east-1c", "us-east-1d", "us-east-1f"]
    : undefined;

const defaultVpc = aws.ec2.getVpc(
  { default: true },
  { provider },
);

const subnetIds = eksSupportedAvailabilityZones
  ? defaultVpc.then((vpc) =>
      aws.ec2
        .getSubnets(
          {
            filters: [
              { name: "vpc-id", values: [vpc.id] },
              {
                name: "availability-zone",
                values: eksSupportedAvailabilityZones,
              },
            ],
          },
          { provider },
        )
        .then((subnets) => subnets.ids),
    )
  : undefined;

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
export const kubeconfig = cluster.kubeconfig;
export const nodeGroupName = nodeGroup.nodeGroup.nodeGroupName;

const argocd = bootstrapArgoCd({
  cloud: "aws",
  environment,
  provider: cluster.provider,
  repositoryUrl: gitRepositoryUrl,
  revision: gitRevision,
  dependsOn: [cluster, nodeGroup],
});

export const argocdNamespace = argocd.namespace;
export const argocdRootApplicationName = argocd.rootApplicationName;
