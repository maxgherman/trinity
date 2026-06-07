import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { Cloud, commonLabels, resourceName } from "./naming";

export interface ArgoCdBootstrapArgs {
  cloud: Cloud;
  environment: string;
  provider: k8s.Provider;
  repositoryUrl: string;
  revision: string;
  mandelbrotImage: pulumi.Input<string>;
  dependsOn?: pulumi.Input<pulumi.Resource>[];
}

export interface ArgoCdBootstrap {
  namespace: pulumi.Output<string>;
  rootApplicationName: pulumi.Output<string>;
}

export function bootstrapArgoCd({
  cloud,
  environment,
  provider,
  repositoryUrl,
  revision,
  mandelbrotImage,
  dependsOn = [],
}: ArgoCdBootstrapArgs): ArgoCdBootstrap {
  const labels = commonLabels(cloud, environment);
  const namespaceName = "argocd";
  const rootApplicationName = resourceName(cloud, environment, "root");

  const namespace = new k8s.core.v1.Namespace(
    `${rootApplicationName}-argocd-namespace`,
    {
      metadata: {
        name: namespaceName,
        labels,
      },
    },
    { provider, dependsOn },
  );

  const release = new k8s.helm.v3.Release(
    `${rootApplicationName}-argocd`,
    {
      chart: "argo-cd",
      version: "9.5.2",
      namespace: namespace.metadata.name,
      timeout: 900,
      waitForJobs: true,
      repositoryOpts: {
        repo: "https://argoproj.github.io/argo-helm",
      },
      values: {
        server: {
          service: {
            type: "ClusterIP",
          },
        },
      },
    },
    { provider, dependsOn: [namespace] },
  );

  const rootApplication = new k8s.apiextensions.CustomResourcePatch(
    rootApplicationName,
    {
      apiVersion: "argoproj.io/v1alpha1",
      kind: "Application",
      metadata: {
        name: rootApplicationName,
        namespace: namespace.metadata.name,
        annotations: {
          "pulumi.com/patchForce": "true",
          "pulumi.com/skipAwait": "true",
        },
        labels: {
          ...labels,
          "app.kubernetes.io/part-of": "trinity",
        },
      },
      spec: {
        project: "default",
        source: {
          repoURL: repositoryUrl,
          targetRevision: revision,
          path: `platform/argocd/clusters/${cloud}`,
        },
        destination: {
          server: "https://kubernetes.default.svc",
          namespace: namespace.metadata.name,
        },
        syncPolicy: {
          automated: {
            prune: true,
            selfHeal: true,
          },
          syncOptions: ["ApplyOutOfSyncOnly=true"],
        },
      },
    },
    {
      provider,
      retainOnDelete: true,
      customTimeouts: {
        create: "5m",
        update: "5m",
      },
      dependsOn: [release],
    },
  );

  new k8s.apiextensions.CustomResourcePatch(
    resourceName(cloud, environment, "mandelbrot-application"),
    {
      apiVersion: "argoproj.io/v1alpha1",
      kind: "Application",
      metadata: {
        name: `trinity-mandelbrot-${cloud}`,
        namespace: namespace.metadata.name,
        annotations: {
          "argocd.argoproj.io/sync-wave": "0",
          "pulumi.com/patchForce": "true",
          "pulumi.com/skipAwait": "true",
        },
        labels: {
          ...labels,
          "app.kubernetes.io/part-of": "trinity",
          "trinity.io/cloud": cloud,
        },
      },
      spec: {
        project: "trinity",
        source: {
          repoURL: repositoryUrl,
          targetRevision: revision,
          path: `apps/mandelbrot/overlays/${cloud}`,
          kustomize: {
            images: [pulumi.interpolate`mandelbrot=${mandelbrotImage}`],
          },
        },
        destination: {
          server: "https://kubernetes.default.svc",
          namespace: "mandelbrot",
        },
        syncPolicy: {
          automated: {
            prune: true,
            selfHeal: true,
          },
          syncOptions: [
            "CreateNamespace=true",
            "ApplyOutOfSyncOnly=true",
            "SkipDryRunOnMissingResource=true",
          ],
        },
      },
    },
    {
      provider,
      retainOnDelete: true,
      customTimeouts: {
        create: "5m",
        update: "5m",
      },
      dependsOn: [release, rootApplication],
    },
  );

  return {
    namespace: namespace.metadata.name,
    rootApplicationName: rootApplication.metadata.name,
  };
}
