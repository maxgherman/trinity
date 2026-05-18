import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { Cloud, commonLabels } from "./naming";

export const externalSecretsNamespaceName = "external-secrets";
export const externalSecretsServiceAccountName = "external-secrets";
export const secretsDemoNamespaceName = "secrets-demo";

function withOptionalSuffix(name: string, suffix?: string) {
  return suffix ? `${name}-${suffix}` : name;
}

export function secretsDemoSecretName(
  cloud: Cloud,
  environment: string,
  suffix?: string,
) {
  return withOptionalSuffix(`trinity-${environment}-${cloud}-secrets-demo`, suffix);
}

export function grafanaCloudRemoteWriteSecretName(
  cloud: Cloud,
  environment: string,
  key: "url" | "username" | "password",
  suffix?: string,
) {
  return withOptionalSuffix(
    `trinity-${environment}-${cloud}-grafana-cloud-remote-write-${key}`,
    suffix,
  );
}

export function grafanaCloudLogsSecretName(
  cloud: Cloud,
  environment: string,
  key: "url" | "username" | "password",
  suffix?: string,
) {
  return withOptionalSuffix(
    `trinity-${environment}-${cloud}-grafana-cloud-logs-${key}`,
    suffix,
  );
}

export function grafanaCloudTracesSecretName(
  cloud: Cloud,
  environment: string,
  key: "endpoint" | "username" | "password",
  suffix?: string,
) {
  return withOptionalSuffix(
    `trinity-${environment}-${cloud}-grafana-cloud-traces-${key}`,
    suffix,
  );
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
