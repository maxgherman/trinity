#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const cloudOrigins = {
  aws: ["aws", "aws-2"],
  gcp: ["gcp"],
  azure: ["azure"],
};

function usage() {
  console.error(`Usage: npm run test:traffic-failover -- --cloud <aws|gcp|azure>

Options:
  --cloud <cloud>             Cloud to remove from the Front Door origin group.
  --samples <count>           Requests per polling round. Default: 6.
  --interval-seconds <count>  Seconds between polling rounds. Default: 30.
  --timeout-seconds <count>   Maximum wait for Front Door propagation. Default: 2400.

Environment overrides:
  TRINITY_TRAFFIC_RESOURCE_GROUP
  TRINITY_FRONTDOOR_PROFILE
  TRINITY_FRONTDOOR_ENDPOINT
  TRINITY_FRONTDOOR_ORIGIN_GROUP
`);
}

function parseArgs() {
  const args = {
    samples: 6,
    intervalSeconds: 30,
    timeoutSeconds: 2400,
  };

  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    const value = process.argv[index + 1];

    if (key === "--help" || key === "-h") {
      usage();
      process.exit(0);
    }

    if (!value) {
      throw new Error(`${key} requires a value.`);
    }

    if (key === "--cloud") {
      args.cloud = value;
      index += 1;
    } else if (key === "--samples") {
      args.samples = Number.parseInt(value, 10);
      index += 1;
    } else if (key === "--interval-seconds") {
      args.intervalSeconds = Number.parseInt(value, 10);
      index += 1;
    } else if (key === "--timeout-seconds") {
      args.timeoutSeconds = Number.parseInt(value, 10);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${key}`);
    }
  }

  if (!args.cloud || !Object.hasOwn(cloudOrigins, args.cloud)) {
    throw new Error("--cloud must be one of aws, gcp, or azure.");
  }

  for (const [key, value] of Object.entries(args)) {
    if (key !== "cloud" && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`--${key} must be a positive number.`);
    }
  }

  return args;
}

function commandExists(command) {
  const executableExtensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];

  return (process.env.PATH ?? "").split(path.delimiter).some((directory) =>
    executableExtensions.some((extension) => {
      const candidate = path.join(directory, `${command}${extension}`);

      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

function output(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function pulumiOutput(name) {
  return output("pulumi", [
    "-C",
    "infra/pulumi/traffic",
    "stack",
    "output",
    name,
  ]);
}

function pulumiConfig(name, fallback) {
  const result = spawnSync(
    "pulumi",
    ["-C", "infra/pulumi/traffic", "config", "get", name],
    { encoding: "utf8" },
  );

  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }

  return fallback;
}

function resourceName(cloud, environment, component) {
  return `trinity-${environment}-${cloud}-${component}`;
}

function updateOrigin({
  resourceGroup,
  profileName,
  originGroupName,
  originName,
  enabledState,
}) {
  execFileSync(
    "az",
    [
      "afd",
      "origin",
      "update",
      "--resource-group",
      resourceGroup,
      "--profile-name",
      profileName,
      "--origin-group-name",
      originGroupName,
      "--origin-name",
      originName,
      "--enabled-state",
      enabledState,
      "--only-show-errors",
    ],
    { stdio: "inherit" },
  );
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function sampleEndpoint(frontDoorUrl, samples) {
  const counts = {};

  for (let index = 0; index < samples; index += 1) {
    const response = await fetch(`${frontDoorUrl}/api/meta`, {
      headers: {
        "cache-control": "no-cache",
      },
    });

    if (!response.ok) {
      throw new Error(`Front Door returned HTTP ${response.status}.`);
    }

    const body = await response.json();
    const cloud = body.cloud ?? "unknown";
    counts[cloud] = (counts[cloud] ?? 0) + 1;
  }

  return counts;
}

function formatCounts(counts) {
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cloud, count]) => `${cloud}:${count}`)
    .join(" ");
}

async function waitUntilCloudDrained({
  cloud,
  frontDoorUrl,
  samples,
  intervalSeconds,
  timeoutSeconds,
}) {
  const started = Date.now();

  while (Date.now() - started < timeoutSeconds * 1000) {
    const counts = await sampleEndpoint(frontDoorUrl, samples);
    console.log(`Front Door samples: ${formatCounts(counts)}`);

    if (!counts[cloud]) {
      return counts;
    }

    await sleep(intervalSeconds * 1000);
  }

  throw new Error(
    `Front Door still routed to ${cloud} after ${timeoutSeconds} seconds.`,
  );
}

async function main() {
  const args = parseArgs();

  if (!commandExists("pulumi")) {
    throw new Error("pulumi CLI is required.");
  }

  if (!commandExists("az")) {
    throw new Error("Azure CLI is required.");
  }

  const environment = pulumiConfig("trinity:environment", "dev");
  const resourceGroup =
    process.env.TRINITY_TRAFFIC_RESOURCE_GROUP ??
    resourceName("azure", environment, "traffic-rg");
  const profileName =
    process.env.TRINITY_FRONTDOOR_PROFILE ??
    resourceName("azure", environment, "frontdoor");
  const endpointName =
    process.env.TRINITY_FRONTDOOR_ENDPOINT ??
    pulumiConfig(
      "trinity:frontDoorEndpointName",
      resourceName("azure", environment, "mandelbrot"),
    );
  const originGroupName =
    process.env.TRINITY_FRONTDOOR_ORIGIN_GROUP ?? "mandelbrot";
  const frontDoorUrl = pulumiOutput("frontDoorEndpointUrl");
  const originNames = cloudOrigins[args.cloud];

  console.log(`Front Door endpoint: ${frontDoorUrl}`);
  console.log(`Disabling ${args.cloud} origins: ${originNames.join(", ")}`);

  const baseline = await sampleEndpoint(frontDoorUrl, args.samples);
  console.log(`Baseline samples: ${formatCounts(baseline)}`);
  if (!baseline[args.cloud]) {
    console.log(
      `Warning: baseline samples did not include ${args.cloud}; failover can still be tested, but this run did not prove ${args.cloud} was receiving traffic before the drill.`,
    );
  }

  let disabled = false;

  try {
    for (const originName of originNames) {
      updateOrigin({
        resourceGroup,
        profileName,
        originGroupName,
        originName,
        enabledState: "Disabled",
      });
    }
    disabled = true;

    console.log(
      `Waiting for ${endpointName} to stop routing to ${args.cloud}. This can take several minutes while Front Door propagates the update.`,
    );
    await waitUntilCloudDrained({
      cloud: args.cloud,
      frontDoorUrl,
      samples: args.samples,
      intervalSeconds: args.intervalSeconds,
      timeoutSeconds: args.timeoutSeconds,
    });
    console.log(`Pass: Front Door avoided ${args.cloud} after origin disable.`);
  } finally {
    if (disabled) {
      console.log(`Re-enabling ${args.cloud} origins: ${originNames.join(", ")}`);
      for (const originName of originNames) {
        updateOrigin({
          resourceGroup,
          profileName,
          originGroupName,
          originName,
          enabledState: "Enabled",
        });
      }
      console.log("Origin re-enable submitted. Front Door propagation may still take several minutes.");
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
