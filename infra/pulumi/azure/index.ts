import * as containerservice from "@pulumi/azure-native/containerservice";
import * as k8s from "@pulumi/kubernetes";
import * as network from "@pulumi/azure-native/network";
import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
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

const resourceGroupName = resourceName("azure", environment, "rg");
const clusterName = resourceName("azure", environment, "cluster");
const mandelbrotPublicIpName = resourceName("azure", environment, "mandelbrot");
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

const nodeResourceGroup = cluster.nodeResourceGroup.apply((name) => {
  if (!name) {
    throw new Error("AKS cluster did not report a node resource group.");
  }

  return name;
});

const mandelbrotPublicIp = new network.PublicIPAddress(
  mandelbrotPublicIpName,
  {
    publicIpAddressName: mandelbrotPublicIpName,
    resourceGroupName: nodeResourceGroup,
    location: resourceGroup.location,
    publicIPAllocationMethod: network.IPAllocationMethod.Static,
    sku: {
      name: network.PublicIPAddressSkuName.Standard,
    },
    tags: {
      ...labels,
      component: "mandelbrot",
    },
  },
  { dependsOn: [cluster] },
);

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

const mandelbrotService = deployMandelbrotService({
  cloud: "azure",
  environment,
  provider: k8sProvider,
  annotations: {
    "service.beta.kubernetes.io/azure-load-balancer-resource-group":
      nodeResourceGroup,
    "service.beta.kubernetes.io/azure-pip-name": mandelbrotPublicIpName,
  },
  dependsOn: [cluster, mandelbrotPublicIp],
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
export const mandelbrotNamespace = mandelbrotService.namespace;
export const mandelbrotServiceName = mandelbrotService.serviceName;
export const mandelbrotOriginHost = mandelbrotPublicIp.ipAddress;
export const mandelbrotStageUrl = pulumi.interpolate`http://${mandelbrotPublicIp.ipAddress}`;
