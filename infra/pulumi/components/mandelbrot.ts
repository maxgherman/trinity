import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { Cloud, commonLabels, resourceName } from "./naming";

export interface MandelbrotServiceArgs {
  cloud: Cloud;
  environment: string;
  provider: k8s.Provider;
  annotations?: pulumi.Input<Record<string, pulumi.Input<string>>>;
  loadBalancerIp?: pulumi.Input<string>;
  dependsOn?: pulumi.Input<pulumi.Resource>[];
}

export interface MandelbrotService {
  namespace: pulumi.Output<string>;
  serviceName: pulumi.Output<string>;
}

export function deployMandelbrotService({
  cloud,
  environment,
  provider,
  annotations,
  loadBalancerIp,
  dependsOn = [],
}: MandelbrotServiceArgs): MandelbrotService {
  const labels = commonLabels(cloud, environment);
  const namespaceName = "mandelbrot";
  const serviceName = "mandelbrot";
  const name = resourceName(cloud, environment, "mandelbrot");

  const namespace = new k8s.core.v1.Namespace(
    `${name}-namespace`,
    {
      metadata: {
        name: namespaceName,
        labels,
      },
    },
    { provider, dependsOn },
  );

  const service = new k8s.core.v1.Service(
    `${name}-service`,
    {
      metadata: {
        name: serviceName,
        namespace: namespace.metadata.name,
        labels: {
          ...labels,
          "app.kubernetes.io/name": "mandelbrot",
          "app.kubernetes.io/part-of": "trinity",
        },
        annotations,
      },
      spec: {
        type: "LoadBalancer",
        loadBalancerIP: loadBalancerIp,
        selector: {
          "app.kubernetes.io/name": "mandelbrot",
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
    { provider, dependsOn: [namespace] },
  );

  return {
    namespace: namespace.metadata.name,
    serviceName: service.metadata.name,
  };
}
