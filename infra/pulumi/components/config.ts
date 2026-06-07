import * as pulumi from "@pulumi/pulumi";

export interface TrinityConfig {
  environment: string;
  region: string;
  kubernetesVersion: string;
  gitRepositoryUrl: string;
  gitRevision: string;
  mandelbrotImageTag: string;
}

export function getTrinityConfig(): TrinityConfig {
  const config = new pulumi.Config("trinity");

  return {
    environment: config.require("environment"),
    region: config.require("region"),
    kubernetesVersion: config.require("kubernetesVersion"),
    gitRepositoryUrl:
      config.get("gitRepositoryUrl") ?? "https://github.com/maxgherman/trinity.git",
    gitRevision: config.get("gitRevision") ?? "main",
    mandelbrotImageTag:
      process.env.MANDELBROT_IMAGE_TAG ??
      config.get("mandelbrotImageTag") ??
      "dev",
  };
}
