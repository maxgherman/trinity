import * as crypto from "node:crypto";
import * as authorization from "@pulumi/azure-native/authorization";
import * as containerservice from "@pulumi/azure-native/containerservice";
import * as keyvault from "@pulumi/azure-native/keyvault";
import * as k8s from "@pulumi/kubernetes";
import * as managedidentity from "@pulumi/azure-native/managedidentity";
import * as network from "@pulumi/azure-native/network";
import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as containerregistry from "@pulumi/azure-native/containerregistry";
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

const resourceGroupName = resourceName("azure", environment, "rg");
const clusterName = resourceName("azure", environment, "cluster");
const mandelbrotPublicIpName = resourceName("azure", environment, "mandelbrot");
const trinityConfig = new pulumi.Config("trinity");
const containerRegistryName =
  trinityConfig.get("containerRegistryName") ??
  trinityConfigSafeRegistryName(`trinity${environment}azureacr`);
const keyVaultName =
  trinityConfig.get("keyVaultName") ?? `trinity-${environment}-az-kv`;
const keyVaultResourceGroupName =
  trinityConfig.get("keyVaultResourceGroupName") ??
  resourceName("azure", environment, "secrets-rg");
const labels = commonLabels("azure", environment);
const azureClient = authorization.getClientConfigOutput();
const azureSubscriptionScope = azureClient.subscriptionId.apply(
  (subscriptionId) => `/subscriptions/${subscriptionId}`,
);
const acrPullRoleDefinitionId = azureSubscriptionScope.apply(
  (scope) =>
    `${scope}/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d`,
);

const resourceGroup = new resources.ResourceGroup(resourceGroupName, {
  resourceGroupName,
  location: region,
  tags: labels,
});

const containerRegistry = new containerregistry.Registry(
  `${clusterName}-registry`,
  {
    registryName: containerRegistryName,
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    sku: {
      name: containerregistry.SkuName.Basic,
    },
    adminUserEnabled: false,
    tags: {
      ...labels,
      component: "mandelbrot",
    },
  },
);

const cluster = new containerservice.ManagedCluster(clusterName, {
  resourceGroupName: resourceGroup.name,
  resourceName: clusterName,
  location: resourceGroup.location,
  dnsPrefix: clusterName,
  kubernetesVersion,
  identity: {
    type: containerservice.ResourceIdentityType.SystemAssigned,
  },
  oidcIssuerProfile: {
    enabled: true,
  },
  securityProfile: {
    workloadIdentity: {
      enabled: true,
    },
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

const kubeletIdentityObjectId = cluster.identityProfile.apply((profile) => {
  const objectId = profile?.kubeletidentity?.objectId;
  if (!objectId) {
    throw new Error("AKS cluster did not report a kubelet identity object ID.");
  }

  return objectId;
});

const mandelbrotAcrPullRoleAssignment = new authorization.RoleAssignment(
  `${clusterName}-mandelbrot-acr-pull`,
  {
    scope: containerRegistry.id,
    roleAssignmentName: pulumi
      .all([containerRegistry.id, kubeletIdentityObjectId])
      .apply(([registryId, objectId]) =>
        uuidFromString(`${registryId}:AcrPull:${objectId}`),
      ),
    roleDefinitionId: acrPullRoleDefinitionId,
    principalId: kubeletIdentityObjectId,
    principalType: authorization.PrincipalType.ServicePrincipal,
  },
  { dependsOn: [cluster, containerRegistry] },
);

const externalSecretsIdentity = new managedidentity.UserAssignedIdentity(
  `${clusterName}-external-secrets`,
  {
    resourceGroupName: resourceGroup.name,
    resourceName: `${clusterName}-external-secrets`,
    location: resourceGroup.location,
    tags: {
      ...labels,
      component: "external-secrets",
    },
  },
);

const oidcIssuerUrl = cluster.oidcIssuerProfile.apply((profile) => {
  if (!profile?.issuerURL) {
    throw new Error("AKS OIDC issuer profile did not report an issuer URL.");
  }

  return profile.issuerURL;
});

new managedidentity.FederatedIdentityCredential(
  `${clusterName}-external-secrets`,
  {
    resourceGroupName: resourceGroup.name,
    resourceName: externalSecretsIdentity.name,
    federatedIdentityCredentialResourceName: "external-secrets",
    issuer: oidcIssuerUrl,
    subject:
      `system:serviceaccount:${externalSecretsNamespaceName}:${externalSecretsServiceAccountName}`,
    audiences: ["api://AzureADTokenExchange"],
  },
);

const secretsDemoAzureSecretName = secretsDemoSecretName("azure", environment);
const grafanaCloudAzureRemoteWriteSecretNames = [
  grafanaCloudRemoteWriteSecretName("azure", environment, "url"),
  grafanaCloudRemoteWriteSecretName("azure", environment, "username"),
  grafanaCloudRemoteWriteSecretName("azure", environment, "password"),
];
const grafanaCloudAzureLogsSecretNames = [
  grafanaCloudLogsSecretName("azure", environment, "url"),
  grafanaCloudLogsSecretName("azure", environment, "username"),
  grafanaCloudLogsSecretName("azure", environment, "password"),
];
const grafanaCloudAzureTracesSecretNames = [
  grafanaCloudTracesSecretName("azure", environment, "endpoint"),
  grafanaCloudTracesSecretName("azure", environment, "username"),
  grafanaCloudTracesSecretName("azure", environment, "password"),
];

new keyvault.AccessPolicy(`${clusterName}-external-secrets-key-vault-access`, {
  vaultName: keyVaultName,
  resourceGroupName: keyVaultResourceGroupName,
  policy: {
    tenantId: azureClient.tenantId,
    objectId: externalSecretsIdentity.principalId,
    permissions: {
      secrets: ["get", "list"],
    },
  },
});

const externalSecretsServiceAccount = createExternalSecretsServiceAccount({
  cloud: "azure",
  environment,
  provider: k8sProvider,
  annotations: {
    "azure.workload.identity/client-id": externalSecretsIdentity.clientId,
    "azure.workload.identity/tenant-id": azureClient.tenantId,
  },
  dependsOn: [cluster],
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
  dependsOn: [
    cluster,
    mandelbrotAcrPullRoleAssignment,
    externalSecretsServiceAccount.serviceAccount,
  ],
});

export { kubeconfig };
export const argocdNamespace = argocd.namespace;
export const argocdRootApplicationName = argocd.rootApplicationName;
export const mandelbrotNamespace = mandelbrotService.namespace;
export const mandelbrotServiceName = mandelbrotService.serviceName;
export const mandelbrotOriginHost = mandelbrotPublicIp.ipAddress;
export const mandelbrotStageUrl = pulumi.interpolate`http://${mandelbrotPublicIp.ipAddress}`;
export const mandelbrotRepositoryUrl = pulumi.interpolate`${containerRegistry.loginServer}/mandelbrot`;
export const externalSecretsAzureClientId = externalSecretsIdentity.clientId;
export const secretsDemoAzureKeyVaultName = keyVaultName;
export const secretsDemoAzureKeyVaultUrl = `https://${keyVaultName}.vault.azure.net`;
export {
  secretsDemoAzureSecretName,
  grafanaCloudAzureRemoteWriteSecretNames,
  grafanaCloudAzureLogsSecretNames,
  grafanaCloudAzureTracesSecretNames,
};

function trinityConfigSafeRegistryName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").slice(0, 50);
}

function uuidFromString(input: string): string {
  const hash = crypto.createHash("sha1").update(input).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${((Number.parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80)
      .toString(16)
      .padStart(2, "0")}${hash.slice(18, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}
