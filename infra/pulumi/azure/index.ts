import * as authorization from "@pulumi/azure-native/authorization";
import * as containerservice from "@pulumi/azure-native/containerservice";
import * as keyvault from "@pulumi/azure-native/keyvault";
import * as k8s from "@pulumi/kubernetes";
import * as managedidentity from "@pulumi/azure-native/managedidentity";
import * as network from "@pulumi/azure-native/network";
import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
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
const keyVaultName =
  trinityConfig.get("keyVaultName") ?? `trinity-${environment}-az-kv`;
const secretsDemoValue = trinityConfig.getSecret("secretsDemoValue");
const grafanaCloudRemoteWriteValues = {
  url: trinityConfig.getSecret("grafanaCloudRemoteWriteUrl"),
  username: trinityConfig.getSecret("grafanaCloudPrometheusUsername"),
  password: trinityConfig.getSecret("grafanaCloudPrometheusPassword"),
};
const grafanaCloudLogsValues = {
  url: trinityConfig.getSecret("grafanaCloudLogsUrl"),
  username: trinityConfig.getSecret("grafanaCloudLogsUsername"),
  password:
    trinityConfig.getSecret("grafanaCloudLogsPassword") ??
    trinityConfig.getSecret("grafanaCloudPrometheusPassword"),
};
const grafanaCloudTracesValues = {
  endpoint: trinityConfig.getSecret("grafanaCloudTempoOtlpHttpEndpoint"),
  username: trinityConfig.getSecret("grafanaCloudTempoUsername"),
  password:
    trinityConfig.getSecret("grafanaCloudTempoPassword") ??
    trinityConfig.getSecret("grafanaCloudPrometheusPassword"),
};
const labels = commonLabels("azure", environment);
const azureClient = authorization.getClientConfigOutput();

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

const keyVault = new keyvault.Vault(
  keyVaultName,
  {
    vaultName: keyVaultName,
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    tags: {
      ...labels,
      component: "secrets-demo",
    },
    properties: {
      tenantId: azureClient.tenantId,
      sku: {
        family: "A",
        name: "standard",
      },
      enableRbacAuthorization: false,
      enableSoftDelete: true,
      softDeleteRetentionInDays: 7,
      accessPolicies: [
        {
          tenantId: azureClient.tenantId,
          objectId: azureClient.objectId,
          permissions: {
            secrets: ["get", "list", "set", "delete"],
          },
        },
        {
          tenantId: azureClient.tenantId,
          objectId: externalSecretsIdentity.principalId,
          permissions: {
            secrets: ["get", "list"],
          },
        },
      ],
    },
  },
);

if (secretsDemoValue) {
  new keyvault.Secret(
    secretsDemoSecretName("azure", environment),
    {
      resourceGroupName: resourceGroup.name,
      vaultName: keyVault.name,
      secretName: secretsDemoSecretName("azure", environment),
      tags: {
        ...labels,
        component: "secrets-demo",
      },
      properties: {
        value: secretsDemoValue,
      },
    },
    { dependsOn: [keyVault] },
  );
}

function createGrafanaCloudRemoteWriteSecret(
  key: "url" | "username" | "password",
  value: pulumi.Output<string> | undefined,
) {
  if (!value) {
    return undefined;
  }

  const secretName = grafanaCloudRemoteWriteSecretName("azure", environment, key);

  return new keyvault.Secret(
    secretName,
    {
      resourceGroupName: resourceGroup.name,
      vaultName: keyVault.name,
      secretName,
      tags: {
        ...labels,
        component: "observability",
      },
      properties: {
        value,
      },
    },
    { dependsOn: [keyVault] },
  );
}

function createGrafanaCloudLogsSecret(
  key: "url" | "username" | "password",
  value: pulumi.Output<string> | undefined,
) {
  if (!value) {
    return undefined;
  }

  const secretName = grafanaCloudLogsSecretName("azure", environment, key);

  return new keyvault.Secret(
    secretName,
    {
      resourceGroupName: resourceGroup.name,
      vaultName: keyVault.name,
      secretName,
      tags: {
        ...labels,
        component: "observability",
      },
      properties: {
        value,
      },
    },
    { dependsOn: [keyVault] },
  );
}

function createGrafanaCloudTracesSecret(
  key: "endpoint" | "username" | "password",
  value: pulumi.Output<string> | undefined,
) {
  if (!value) {
    return undefined;
  }

  const secretName = grafanaCloudTracesSecretName("azure", environment, key);

  return new keyvault.Secret(
    secretName,
    {
      resourceGroupName: resourceGroup.name,
      vaultName: keyVault.name,
      secretName,
      tags: {
        ...labels,
        component: "observability",
      },
      properties: {
        value,
      },
    },
    { dependsOn: [keyVault] },
  );
}

const grafanaCloudRemoteWriteSecrets = [
  createGrafanaCloudRemoteWriteSecret("url", grafanaCloudRemoteWriteValues.url),
  createGrafanaCloudRemoteWriteSecret(
    "username",
    grafanaCloudRemoteWriteValues.username,
  ),
  createGrafanaCloudRemoteWriteSecret(
    "password",
    grafanaCloudRemoteWriteValues.password,
  ),
].filter((secret): secret is keyvault.Secret => Boolean(secret));
const grafanaCloudLogsSecrets = [
  createGrafanaCloudLogsSecret("url", grafanaCloudLogsValues.url),
  createGrafanaCloudLogsSecret("username", grafanaCloudLogsValues.username),
  createGrafanaCloudLogsSecret("password", grafanaCloudLogsValues.password),
].filter((secret): secret is keyvault.Secret => Boolean(secret));
const grafanaCloudTracesSecrets = [
  createGrafanaCloudTracesSecret("endpoint", grafanaCloudTracesValues.endpoint),
  createGrafanaCloudTracesSecret("username", grafanaCloudTracesValues.username),
  createGrafanaCloudTracesSecret("password", grafanaCloudTracesValues.password),
].filter((secret): secret is keyvault.Secret => Boolean(secret));

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
  dependsOn: [cluster, externalSecretsServiceAccount.serviceAccount],
});

export { kubeconfig };
export const argocdNamespace = argocd.namespace;
export const argocdRootApplicationName = argocd.rootApplicationName;
export const mandelbrotNamespace = mandelbrotService.namespace;
export const mandelbrotServiceName = mandelbrotService.serviceName;
export const mandelbrotOriginHost = mandelbrotPublicIp.ipAddress;
export const mandelbrotStageUrl = pulumi.interpolate`http://${mandelbrotPublicIp.ipAddress}`;
export const externalSecretsAzureClientId = externalSecretsIdentity.clientId;
export const secretsDemoAzureKeyVaultName = keyVault.name;
export const secretsDemoAzureKeyVaultUrl = pulumi.interpolate`https://${keyVault.name}.vault.azure.net`;
export const grafanaCloudAzureRemoteWriteSecretNames = pulumi.all(
  grafanaCloudRemoteWriteSecrets.map((secret) => secret.name),
);
export const grafanaCloudAzureLogsSecretNames = pulumi.all(
  grafanaCloudLogsSecrets.map((secret) => secret.name),
);
export const grafanaCloudAzureTracesSecretNames = pulumi.all(
  grafanaCloudTracesSecrets.map((secret) => secret.name),
);
