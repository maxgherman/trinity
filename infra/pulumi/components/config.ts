import * as pulumi from "@pulumi/pulumi";

export interface TrinityConfig {
  environment: string;
  region: string;
  kubernetesVersion: string;
}

export function getTrinityConfig(): TrinityConfig {
  const config = new pulumi.Config("trinity");

  return {
    environment: config.require("environment"),
    region: config.require("region"),
    kubernetesVersion: config.require("kubernetesVersion"),
  };
}

