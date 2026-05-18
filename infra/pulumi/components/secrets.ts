import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { Cloud, commonLabels } from "./naming";

export const externalSecretsNamespaceName = "external-secrets";
export const externalSecretsServiceAccountName = "external-secrets";
export const secretsDemoNamespaceName = "secrets-demo";

export function secretsDemoSecretName(cloud: Cloud, environment: string) {
  return `trinity-${environment}-${cloud}-secrets-demo`;
}

export function grafanaCloudRemoteWriteSecretName(
  cloud: Cloud,
  environment: string,
  key: "url" | "username" | "password",
) {
  return `trinity-${environment}-${cloud}-grafana-cloud-remote-write-${key}`;
}

export interface ExternalSecretsServiceAccountArgs {
  cloud: Cloud;
  environment: string;
  provider: k8s.Provider;
  annotations?: pulumi.Input<{
    [key: string]: pulumi.Input<string>;
  }>;
  dependsOn?: pulumi.Input<pulumi.Resource>[];
}

export interface ExternalSecretsServiceAccount {
  namespace: k8s.core.v1.Namespace;
  serviceAccount: k8s.core.v1.ServiceAccount;
}

export function createExternalSecretsServiceAccount({
  cloud,
  environment,
  provider,
  annotations,
  dependsOn = [],
}: ExternalSecretsServiceAccountArgs): ExternalSecretsServiceAccount {
  const labels = {
    ...commonLabels(cloud, environment),
    "app.kubernetes.io/name": "external-secrets",
    "app.kubernetes.io/part-of": "trinity",
    "app.kubernetes.io/managed-by": "pulumi",
  };

  const namespace = new k8s.core.v1.Namespace(
    `${cloud}-external-secrets-namespace`,
    {
      metadata: {
        name: externalSecretsNamespaceName,
        labels,
      },
    },
    { provider, dependsOn },
  );

  const serviceAccount = new k8s.core.v1.ServiceAccount(
    `${cloud}-external-secrets-service-account`,
    {
      metadata: {
        name: externalSecretsServiceAccountName,
        namespace: namespace.metadata.name,
        annotations,
        labels,
      },
    },
    { provider, dependsOn: [namespace] },
  );

  return { namespace, serviceAccount };
}
