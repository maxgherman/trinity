import * as gcp from "@pulumi/gcp";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { bootstrapArgoCd } from "../components/argocd";
import { getTrinityConfig } from "../components/config";
import { deployMandelbrotService } from "../components/mandelbrot";
import { commonLabels, resourceName } from "../components/naming";

const {
  environment,
  region,
  kubernetesVersion,
  gitRepositoryUrl,
  gitRevision,
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
const labels = commonLabels("gcp", environment);
const nodeLocations = region === "us-central1" ? ["us-central1-a"] : undefined;

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
    nodeCount: 1,
    nodeConfig: {
      machineType: "e2-standard-2",
      diskSizeGb: 20,
      diskType: "pd-standard",
      labels,
      oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
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
  dependsOn: [nodePool],
});

export { kubeconfig };
export const argocdNamespace = argocd.namespace;
export const argocdRootApplicationName = argocd.rootApplicationName;
export const mandelbrotNamespace = mandelbrotService.namespace;
export const mandelbrotServiceName = mandelbrotService.serviceName;
export const mandelbrotOriginHost = mandelbrotAddress.address;
export const mandelbrotStageUrl = pulumi.interpolate`http://${mandelbrotAddress.address}`;
