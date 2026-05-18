import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import yaml from "js-yaml";

export function output(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

export function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

export function tryOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) {
    return result.stdout.trim();
  }
  return undefined;
}

export function readStackConfig(cloud) {
  const document = yaml.load(
    fs.readFileSync(`infra/pulumi/${cloud}/Pulumi.dev.yaml`, "utf8"),
  );
  return document?.config ?? {};
}

function stackName(cloud) {
  return `maxgherman/trinity-${cloud}/dev`;
}

const pulumiConfigCache = new Map();

function pulumiConfigValues(cloud) {
  if (!pulumiConfigCache.has(cloud)) {
    const values = JSON.parse(
      output("pulumi", [
        "-C",
        `infra/pulumi/${cloud}`,
        "config",
        "--show-secrets",
        "--json",
        "--stack",
        stackName(cloud),
      ]),
    );
    pulumiConfigCache.set(cloud, values);
  }

  return pulumiConfigCache.get(cloud);
}

function configEntryValue(entry) {
  if (entry === undefined || entry === null) return undefined;
  if (typeof entry === "object" && "value" in entry) {
    return entry.value === undefined || entry.value === null
      ? undefined
      : String(entry.value);
  }
  return String(entry);
}

function pulumiConfigValue(cloud, fullKey) {
  return configEntryValue(pulumiConfigValues(cloud)[fullKey]);
}

export function pulumiConfig(cloud, key) {
  return pulumiConfigValue(cloud, `trinity:${key}`);
}

export function requiredPulumiConfig(cloud, key) {
  const value = pulumiConfig(cloud, key);
  if (!value) {
    throw new Error(`Missing Pulumi config trinity:${key} in ${cloud} stack.`);
  }
  return value;
}

export function optionalPassword(cloud, key, fallbackKey) {
  return pulumiConfig(cloud, key) ?? pulumiConfig(cloud, fallbackKey);
}

export function parseCloudArg() {
  const cloudIndex = process.argv.indexOf("--cloud");
  const cloud = cloudIndex >= 0 ? process.argv[cloudIndex + 1] : "all";
  if (!["all", "aws", "gcp", "azure"].includes(cloud)) {
    throw new Error("--cloud must be one of all, aws, gcp, or azure.");
  }
  return cloud === "all" ? ["aws", "gcp", "azure"] : [cloud];
}

export function awsSecretNames() {
  const config = readStackConfig("aws");
  const environment = config["trinity:environment"] ?? "dev";
  const suffix = config["trinity:secretNameSuffix"];
  const base = `trinity-${environment}-aws`;
  const withSuffix = (name) => (suffix ? `${name}-${suffix}` : name);

  return {
    region: config["trinity:region"] ?? "us-east-1",
    entries: [
      ["secretsDemoValue", withSuffix(`${base}-secrets-demo`)],
      ["grafanaCloudRemoteWriteUrl", withSuffix(`${base}-grafana-cloud-remote-write-url`)],
      ["grafanaCloudPrometheusUsername", withSuffix(`${base}-grafana-cloud-remote-write-username`)],
      ["grafanaCloudPrometheusPassword", withSuffix(`${base}-grafana-cloud-remote-write-password`)],
      ["grafanaCloudLogsUrl", withSuffix(`${base}-grafana-cloud-logs-url`)],
      ["grafanaCloudLogsUsername", withSuffix(`${base}-grafana-cloud-logs-username`)],
      ["grafanaCloudLogsPassword", withSuffix(`${base}-grafana-cloud-logs-password`), "grafanaCloudPrometheusPassword"],
      ["grafanaCloudTempoOtlpHttpEndpoint", withSuffix(`${base}-grafana-cloud-traces-endpoint`)],
      ["grafanaCloudTempoUsername", withSuffix(`${base}-grafana-cloud-traces-username`)],
      ["grafanaCloudTempoPassword", withSuffix(`${base}-grafana-cloud-traces-password`), "grafanaCloudPrometheusPassword"],
    ],
  };
}

export function gcpSecretNames() {
  const config = readStackConfig("gcp");
  const environment = config["trinity:environment"] ?? "dev";
  const base = `trinity-${environment}-gcp`;

  return {
    project: pulumiConfigValue("gcp", "gcp:project"),
    entries: [
      ["secretsDemoValue", `${base}-secrets-demo`],
      ["grafanaCloudRemoteWriteUrl", `${base}-grafana-cloud-remote-write-url`],
      ["grafanaCloudPrometheusUsername", `${base}-grafana-cloud-remote-write-username`],
      ["grafanaCloudPrometheusPassword", `${base}-grafana-cloud-remote-write-password`],
      ["grafanaCloudLogsUrl", `${base}-grafana-cloud-logs-url`],
      ["grafanaCloudLogsUsername", `${base}-grafana-cloud-logs-username`],
      ["grafanaCloudLogsPassword", `${base}-grafana-cloud-logs-password`, "grafanaCloudPrometheusPassword"],
      ["grafanaCloudTempoOtlpHttpEndpoint", `${base}-grafana-cloud-traces-endpoint`],
      ["grafanaCloudTempoUsername", `${base}-grafana-cloud-traces-username`],
      ["grafanaCloudTempoPassword", `${base}-grafana-cloud-traces-password`, "grafanaCloudPrometheusPassword"],
    ],
  };
}

export function azureSecretNames() {
  const config = readStackConfig("azure");
  const environment = config["trinity:environment"] ?? "dev";
  const base = `trinity-${environment}-azure`;

  return {
    location: config["trinity:region"] ?? "eastus",
    resourceGroup:
      config["trinity:keyVaultResourceGroupName"] ??
      `trinity-${environment}-azure-secrets-rg`,
    vaultName: config["trinity:keyVaultName"] ?? `trinity-${environment}-az-kv`,
    entries: [
      ["secretsDemoValue", `${base}-secrets-demo`],
      ["grafanaCloudRemoteWriteUrl", `${base}-grafana-cloud-remote-write-url`],
      ["grafanaCloudPrometheusUsername", `${base}-grafana-cloud-remote-write-username`],
      ["grafanaCloudPrometheusPassword", `${base}-grafana-cloud-remote-write-password`],
      ["grafanaCloudLogsUrl", `${base}-grafana-cloud-logs-url`],
      ["grafanaCloudLogsUsername", `${base}-grafana-cloud-logs-username`],
      ["grafanaCloudLogsPassword", `${base}-grafana-cloud-logs-password`, "grafanaCloudPrometheusPassword"],
      ["grafanaCloudTempoOtlpHttpEndpoint", `${base}-grafana-cloud-traces-endpoint`],
      ["grafanaCloudTempoUsername", `${base}-grafana-cloud-traces-username`],
      ["grafanaCloudTempoPassword", `${base}-grafana-cloud-traces-password`, "grafanaCloudPrometheusPassword"],
    ],
  };
}
