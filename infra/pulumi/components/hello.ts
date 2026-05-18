import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { Cloud, commonLabels, resourceName } from "./naming";

export interface HelloApp {
  namespace: pulumi.Output<string>;
  serviceName: pulumi.Output<string>;
  serviceIp: pulumi.Output<string | undefined>;
  serviceHostname: pulumi.Output<string | undefined>;
}

export function deployHelloApp(
  cloud: Cloud,
  environment: string,
  provider: k8s.Provider,
  dependsOn: pulumi.Input<pulumi.Resource>[] = [],
): HelloApp {
  const name = resourceName(cloud, environment, "hello");
  const labels = {
    ...commonLabels(cloud, environment),
    component: "hello",
  };

  const namespace = new k8s.core.v1.Namespace(
    name,
    {
      metadata: {
        name: "hello",
        labels,
      },
    },
    { provider, dependsOn },
  );

  const deployment = new k8s.apps.v1.Deployment(
    name,
    {
      metadata: {
        namespace: namespace.metadata.name,
        labels,
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: "hello",
          },
        },
        template: {
          metadata: {
            labels: {
              ...labels,
              app: "hello",
            },
          },
          spec: {
            containers: [
              {
                name: "hello",
                image: "nginx:1.27-alpine",
                ports: [
                  {
                    name: "http",
                    containerPort: 80,
                  },
                ],
                resources: {
                  requests: {
                    cpu: "50m",
                    memory: "64Mi",
                  },
                  limits: {
                    cpu: "250m",
                    memory: "128Mi",
                  },
                },
              },
            ],
          },
        },
      },
    },
    { provider, dependsOn: [namespace] },
  );

  const service = new k8s.core.v1.Service(
    name,
    {
      metadata: {
        namespace: namespace.metadata.name,
        labels,
      },
      spec: {
        type: "LoadBalancer",
        selector: {
          app: "hello",
        },
        ports: [
          {
            name: "http",
            port: 80,
            targetPort: "http",
          },
        ],
      },
    },
    { provider, dependsOn: [deployment] },
  );

  return {
    namespace: namespace.metadata.name,
    serviceName: service.metadata.name,
    serviceIp: service.status.loadBalancer.ingress[0].ip,
    serviceHostname: service.status.loadBalancer.ingress[0].hostname,
  };
}
