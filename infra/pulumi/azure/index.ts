import * as containerservice from "@pulumi/azure-native/containerservice";
import * as k8s from "@pulumi/kubernetes";
import * as resources from "@pulumi/azure-native/resources";
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

const resourceGroupName = resourceName("azure", environment, "rg");
const clusterName = resourceName("azure", environment, "cluster");
const labels = commonLabels("azure", environment);

const resourceGroup = new resources.ResourceGroup(resourceGroupName, {
  resourceGroupName,
  location: region,
  tags: labels,
});

const cluster = new containerservice.ManagedCluster(clusterName, {
  resourceGroupName: resourceGroup.name,
  resourceName: clusterName,
  location: resourceGroup.location,
  dnsPrefix: clusterName,
  kubernetesVersion,
  identity: {
    type: containerservice.ResourceIdentityType.SystemAssigned,
  },
  agentPoolProfiles: [
    {
      name: "systempool",
      count: 2,
      vmSize: "Standard_B2s",
      mode: "System",
    },
  ],
  tags: labels,
});

const credentials =
  containerservice.listManagedClusterUserCredentialsOutput({
    resourceGroupName: resourceGroup.name,
    resourceName: cluster.name,
  });

export const name = cluster.name;
export const resourceGroupNameOutput = resourceGroup.name;
const kubeconfig = credentials.kubeconfigs.apply((kubeconfigs) =>
  Buffer.from(kubeconfigs[0].value, "base64").toString(),
);

const k8sProvider = new k8s.Provider(`${clusterName}-k8s-provider`, {
  kubeconfig,
});

const argocd = bootstrapArgoCd({
  cloud: "azure",
  environment,
  provider: k8sProvider,
  repositoryUrl: gitRepositoryUrl,
  revision: gitRevision,
  dependsOn: [cluster],
});

export { kubeconfig };
export const argocdNamespace = argocd.namespace;
export const argocdRootApplicationName = argocd.rootApplicationName;
