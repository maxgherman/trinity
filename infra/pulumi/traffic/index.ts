import * as cdn from "@pulumi/azure-native/cdn";
import * as k8s from "@pulumi/kubernetes";
import * as resources from "@pulumi/azure-native/resources";
import * as pulumi from "@pulumi/pulumi";
import { Cloud, commonLabels, resourceName } from "../components/naming";

const trinityConfig = new pulumi.Config("trinity");

function stripProtocol(value: string): string {
  return value.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

const environment = trinityConfig.require("environment");
const region = trinityConfig.require("region");
const awsStackName =
  trinityConfig.get("awsStackName") ?? "maxgherman/trinity-aws/dev";
const gcpStackName =
  trinityConfig.get("gcpStackName") ?? "maxgherman/trinity-gcp/dev";
const azureStackName =
  trinityConfig.get("azureStackName") ?? "maxgherman/trinity-azure/dev";

const clusterStacks = {
  aws: new pulumi.StackReference("aws-stack", { name: awsStackName }),
  gcp: new pulumi.StackReference("gcp-stack", { name: gcpStackName }),
  azure: new pulumi.StackReference("azure-stack", { name: azureStackName }),
} satisfies Record<Cloud, pulumi.StackReference>;

function requireStringOutput(
  stack: pulumi.StackReference,
  stackName: string,
  outputName: string,
  fallback: string,
) {
  return stack.getOutput(outputName).apply((value) => {
    if (typeof value !== "string" || value.length === 0) {
      if (pulumi.runtime.isDryRun()) {
        return fallback;
      }

      throw new Error(`${stackName} must export a non-empty ${outputName} output.`);
    }

    return value;
  });
}

function readOriginHost(
  stack: pulumi.StackReference,
  stackName: string,
  fallback: string,
) {
  return requireStringOutput(stack, stackName, "mandelbrotOriginHost", fallback)
    .apply((value) => {
      return stripProtocol(value);
    });
}

function readOriginHostElement(
  stack: pulumi.StackReference,
  stackName: string,
  outputName: string,
  index: number,
  fallback: string,
) {
  return stack.getOutput(outputName).apply((value) => {
    if (Array.isArray(value) && typeof value[index] === "string" && value[index].length > 0) {
      return stripProtocol(value[index]);
    }

    if (pulumi.runtime.isDryRun()) {
      return fallback;
    }

    throw new Error(
      `${stackName} must export ${outputName}[${index}] as a non-empty string.`,
    );
  });
}

const originHosts = {
  aws: readOriginHost(clusterStacks.aws, awsStackName, "127.0.0.1"),
  gcp: readOriginHost(clusterStacks.gcp, gcpStackName, "127.0.0.1"),
  azure: readOriginHost(clusterStacks.azure, azureStackName, "127.0.0.1"),
};

const awsFrontDoorOriginHosts = [
  readOriginHostElement(
    clusterStacks.aws,
    awsStackName,
    "mandelbrotOriginHosts",
    0,
    "127.0.0.1",
  ),
  readOriginHostElement(
    clusterStacks.aws,
    awsStackName,
    "mandelbrotOriginHosts",
    1,
    "127.0.0.1",
  ),
];

const frontDoorOriginHosts = [
  { name: "aws", originName: "aws", hostName: awsFrontDoorOriginHosts[0] },
  { name: "aws-2", originName: "aws-2", hostName: awsFrontDoorOriginHosts[1] },
  { name: "gcp", originName: "gcp", hostName: originHosts.gcp },
  { name: "azure", originName: "azure", hostName: originHosts.azure },
];

const stageUrls = {
  aws: pulumi.interpolate`http://${originHosts.aws}`,
  gcp: pulumi.interpolate`http://${originHosts.gcp}`,
  azure: pulumi.interpolate`http://${originHosts.azure}`,
} satisfies Record<Cloud, pulumi.Output<string>>;

const labels = {
  ...commonLabels("azure", environment),
  component: "traffic",
};

const resourceGroupName = resourceName("azure", environment, "traffic-rg");
const profileName = resourceName("azure", environment, "frontdoor");
const endpointName =
  trinityConfig.get("frontDoorEndpointName") ??
  resourceName("azure", environment, "mandelbrot");
const originGroupName = "mandelbrot";

const resourceGroup = new resources.ResourceGroup(resourceGroupName, {
  resourceGroupName,
  location: region,
  tags: labels,
});

const profile = new cdn.Profile(profileName, {
  profileName,
  resourceGroupName: resourceGroup.name,
  location: "Global",
  sku: {
    name: cdn.SkuName.Standard_AzureFrontDoor,
  },
  originResponseTimeoutSeconds: 30,
  tags: labels,
});

const endpoint = new cdn.AFDEndpoint(endpointName, {
  endpointName,
  profileName: profile.name,
  resourceGroupName: resourceGroup.name,
  location: "Global",
  enabledState: cdn.EnabledState.Enabled,
  tags: labels,
});

const originGroup = new cdn.AFDOriginGroup(originGroupName, {
  originGroupName,
  profileName: profile.name,
  resourceGroupName: resourceGroup.name,
  healthProbeSettings: {
    probePath: "/readyz",
    probeProtocol: cdn.ProbeProtocol.Http,
    probeRequestType: cdn.HealthProbeRequestType.GET,
    probeIntervalInSeconds: 60,
  },
  loadBalancingSettings: {
    sampleSize: 4,
    successfulSamplesRequired: 3,
    additionalLatencyInMilliseconds: 50,
  },
  sessionAffinityState: cdn.EnabledState.Disabled,
});

const origins = frontDoorOriginHosts.map(
  ({ name, originName, hostName }) =>
    new cdn.AFDOrigin(
      `${originGroupName}-${name}`,
      {
        originName,
        profileName: profile.name,
        resourceGroupName: resourceGroup.name,
        originGroupName: originGroup.name,
        hostName,
        originHostHeader: hostName,
        httpPort: 80,
        httpsPort: 443,
        priority: 1,
        weight: 1000,
        enabledState: cdn.EnabledState.Enabled,
        enforceCertificateNameCheck: false,
      },
      { dependsOn: [originGroup] },
    ),
);

const route = new cdn.Route(
  "mandelbrot",
  {
    routeName: "mandelbrot",
    profileName: profile.name,
    endpointName: endpoint.name,
    resourceGroupName: resourceGroup.name,
    originGroup: {
      id: originGroup.id,
    },
    patternsToMatch: ["/*"],
    supportedProtocols: [
      cdn.AFDEndpointProtocols.Http,
      cdn.AFDEndpointProtocols.Https,
    ],
    forwardingProtocol: cdn.ForwardingProtocol.HttpOnly,
    httpsRedirect: cdn.HttpsRedirect.Enabled,
    linkToDefaultDomain: cdn.LinkToDefaultDomain.Enabled,
    enabledState: cdn.EnabledState.Enabled,
  },
  { dependsOn: origins },
);

function deployStageUrlConfigMap(
  cloud: Cloud,
  stack: pulumi.StackReference,
  stackName: string,
) {
  const kubeconfig = requireStringOutput(
    stack,
    stackName,
    "kubeconfig",
    "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n",
  );
  const provider = new k8s.Provider(`${cloud}-stage-url-k8s-provider`, {
    kubeconfig,
  });

  return new k8s.core.v1.ConfigMapPatch(
    `${cloud}-mandelbrot-stage-urls`,
    {
      metadata: {
        name: "mandelbrot-stage-urls",
        namespace: "mandelbrot",
        annotations: {
          "pulumi.com/patchForce": "true",
          "trinity.io/stage-url-config-generation": "2",
        },
        labels: {
          ...commonLabels(cloud, environment),
          "app.kubernetes.io/name": "mandelbrot",
          "app.kubernetes.io/part-of": "trinity",
          "app.kubernetes.io/component": "stage-url-config",
          "app.kubernetes.io/managed-by": "pulumi",
        },
      },
      data: {
        AWS_STAGE_URL: stageUrls.aws,
        GCP_STAGE_URL: stageUrls.gcp,
        AZURE_STAGE_URL: stageUrls.azure,
      },
    },
    { provider },
  );
}

const stageUrlConfigMaps = {
  aws: deployStageUrlConfigMap("aws", clusterStacks.aws, awsStackName),
  gcp: deployStageUrlConfigMap("gcp", clusterStacks.gcp, gcpStackName),
  azure: deployStageUrlConfigMap("azure", clusterStacks.azure, azureStackName),
};

export const frontDoorEndpointHostName = endpoint.hostName;
export const frontDoorEndpointUrl = pulumi.interpolate`https://${endpoint.hostName}`;
export const routeName = route.name;
export const awsOriginHost = originHosts.aws;
export const awsOriginHosts = pulumi.all(awsFrontDoorOriginHosts);
export const gcpOriginHost = originHosts.gcp;
export const azureOriginHost = originHosts.azure;
export const awsStageUrl = stageUrls.aws;
export const gcpStageUrl = stageUrls.gcp;
export const azureStageUrl = stageUrls.azure;
export const awsStageUrlConfigMapName = stageUrlConfigMaps.aws.metadata.name;
export const gcpStageUrlConfigMapName = stageUrlConfigMaps.gcp.metadata.name;
export const azureStageUrlConfigMapName = stageUrlConfigMaps.azure.metadata.name;
