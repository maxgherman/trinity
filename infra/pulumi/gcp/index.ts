import * as gcp from "@pulumi/gcp";
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
  mandelbrotImageTag,
} = getTrinityConfig();
const gcpConfig = new pulumi.Config("gcp");
const project = gcpConfig.require("project");

const provider = new gcp.Provider("gcp-provider", {
  project,
  region,
});

const clusterName = resourceName("gcp", environment, "cluster");
const nodePoolName = resourceName("gcp", environment, "nodepool");
const mandelbrotAddressName = resourceName("gcp", environment, "mandelbrot");
const mandelbrotRepositoryId = resourceName("gcp", environment, "mandelbrot");
const externalSecretsServiceAccountId = `trinity-${environment}-eso`;
const labels = commonLabels("gcp", environment);
const nodeLocations = region === "us-central1" ? ["us-central1-a"] : undefined;

const projectInfo = gcp.organizations.getProjectOutput(
  { projectId: project },
  { provider },
);

const mandelbrotRepository = new gcp.artifactregistry.Repository(
  mandelbrotRepositoryId,
  {
    repositoryId: mandelbrotRepositoryId,
    location: region,
    project,
    format: "DOCKER",
    description: "Docker images for the Trinity Mandelbrot workload.",
    labels: {
      ...labels,
      component: "mandelbrot",
    },
  },
  { provider },
);

new gcp.artifactregistry.RepositoryIamMember(
  `${mandelbrotRepositoryId}-node-reader`,
  {
    project,
    location: region,
    repository: mandelbrotRepository.repositoryId,
    role: "roles/artifactregistry.reader",
    member: projectInfo.number.apply(
      (projectNumber) =>
        `serviceAccount:${projectNumber}-compute@developer.gserviceaccount.com`,
    ),
  },
  { provider },
);

const mandelbrotImage = pulumi.interpolate`${region}-docker.pkg.dev/${project}/${mandelbrotRepository.repositoryId}/mandelbrot:${mandelbrotImageTag}`;

const mandelbrotAddress = new gcp.compute.Address(
  mandelbrotAddressName,
  {
    name: mandelbrotAddressName,
    region,
    networkTier: "PREMIUM",
    labels: {
      ...labels,
      component: "mandelbrot",
    },
  },
  { provider },
);

const cluster = new gcp.container.Cluster(
  clusterName,
  {
    name: clusterName,
    location: region,
    nodeLocations,
    minMasterVersion: kubernetesVersion,
    initialNodeCount: 1,
    removeDefaultNodePool: true,
    deletionProtection: false,
    workloadIdentityConfig: {
      workloadPool: `${project}.svc.id.goog`,
    },
    resourceLabels: labels,
  },
  { provider },
);

const nodePool = new gcp.container.NodePool(
  nodePoolName,
  {
    name: nodePoolName,
    cluster: cluster.name,
    location: cluster.location,
    nodeCount: 2,
    nodeConfig: {
      machineType: "e2-standard-2",
      diskSizeGb: 20,
      diskType: "pd-standard",
      labels,
      oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
      workloadMetadataConfig: {
        mode: "GKE_METADATA",
      },
    },
  },
  { provider },
);

export const name = cluster.name;
export const nodePoolNameOutput = nodePool.name;
const clusterInfo = gcp.container.getClusterOutput(
  {
    name: cluster.name,
    location: cluster.location,
    project,
  },
  {
    dependsOn: [cluster],
    provider,
  },
);

const kubeconfig = pulumi
  .all([clusterInfo.name, clusterInfo.endpoint, clusterInfo.masterAuths])
  .apply(([name, endpoint, masterAuths]) => `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${masterAuths[0].clusterCaCertificate}
    server: https://${endpoint}
  name: ${name}
contexts:
- context:
    cluster: ${name}
    user: ${name}
  name: ${name}
current-context: ${name}
kind: Config
users:
- name: ${name}
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
      installHint: Install gke-gcloud-auth-plugin for kubectl authentication.
      provideClusterInfo: true
`);

const k8sProvider = new k8s.Provider(`${clusterName}-k8s-provider`, {
  kubeconfig,
  clusterIdentifier: cluster.id,
});

const secretsDemoGcpSecretName = secretsDemoSecretName("gcp", environment);
const grafanaCloudGcpRemoteWriteSecretNames = [
  grafanaCloudRemoteWriteSecretName("gcp", environment, "url"),
  grafanaCloudRemoteWriteSecretName("gcp", environment, "username"),
  grafanaCloudRemoteWriteSecretName("gcp", environment, "password"),
];
const grafanaCloudGcpLogsSecretNames = [
  grafanaCloudLogsSecretName("gcp", environment, "url"),
  grafanaCloudLogsSecretName("gcp", environment, "username"),
  grafanaCloudLogsSecretName("gcp", environment, "password"),
];
const grafanaCloudGcpTracesSecretNames = [
  grafanaCloudTracesSecretName("gcp", environment, "endpoint"),
  grafanaCloudTracesSecretName("gcp", environment, "username"),
  grafanaCloudTracesSecretName("gcp", environment, "password"),
];
const externalSecretsGcpSecretNames = [
  secretsDemoGcpSecretName,
  ...grafanaCloudGcpRemoteWriteSecretNames,
  ...grafanaCloudGcpLogsSecretNames,
  ...grafanaCloudGcpTracesSecretNames,
];

const externalSecretsGoogleServiceAccount = new gcp.serviceaccount.Account(
  `${clusterName}-external-secrets`,
  {
    accountId: externalSecretsServiceAccountId,
    displayName: "The Trinity External Secrets Operator",
    description: "GKE Workload Identity account for External Secrets Operator.",
    project,
  },
  { provider },
);

new gcp.serviceaccount.IAMMember(
  `${clusterName}-external-secrets-workload-identity-user`,
  {
    serviceAccountId: externalSecretsGoogleServiceAccount.name,
    role: "roles/iam.workloadIdentityUser",
    member: `serviceAccount:${project}.svc.id.goog[${externalSecretsNamespaceName}/${externalSecretsServiceAccountName}]`,
  },
  { provider },
);

externalSecretsGcpSecretNames.forEach((secretName, index) => {
  new gcp.secretmanager.SecretIamMember(
    `${clusterName}-external-secrets-read-secret-${index}`,
    {
      project,
      secretId: secretName,
      role: "roles/secretmanager.secretAccessor",
      member: pulumi.interpolate`serviceAccount:${externalSecretsGoogleServiceAccount.email}`,
    },
    { provider },
  );
});

const externalSecretsServiceAccount = createExternalSecretsServiceAccount({
  cloud: "gcp",
  environment,
  provider: k8sProvider,
  annotations: {
    "iam.gke.io/gcp-service-account": externalSecretsGoogleServiceAccount.email,
  },
  dependsOn: [nodePool],
});

const mandelbrotService = deployMandelbrotService({
  cloud: "gcp",
  environment,
  provider: k8sProvider,
  loadBalancerIp: mandelbrotAddress.address,
  dependsOn: [nodePool, mandelbrotAddress],
});

const argocd = bootstrapArgoCd({
  cloud: "gcp",
  environment,
  provider: k8sProvider,
  repositoryUrl: gitRepositoryUrl,
  revision: gitRevision,
  mandelbrotImage,
  dependsOn: [nodePool, externalSecretsServiceAccount.serviceAccount],
});

export { kubeconfig };
export const argocdNamespace = argocd.namespace;
export const argocdRootApplicationName = argocd.rootApplicationName;
export const mandelbrotNamespace = mandelbrotService.namespace;
export const mandelbrotServiceName = mandelbrotService.serviceName;
export const mandelbrotOriginHost = mandelbrotAddress.address;
export const mandelbrotStageUrl = pulumi.interpolate`http://${mandelbrotAddress.address}`;
export const mandelbrotRepositoryUrl = pulumi.interpolate`${region}-docker.pkg.dev/${project}/${mandelbrotRepository.repositoryId}`;
export const mandelbrotImageName = mandelbrotImage;
export const externalSecretsGcpServiceAccountEmail =
  externalSecretsGoogleServiceAccount.email;
export {
  secretsDemoGcpSecretName,
  grafanaCloudGcpRemoteWriteSecretNames,
  grafanaCloudGcpLogsSecretNames,
  grafanaCloudGcpTracesSecretNames,
};
