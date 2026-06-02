#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const cloudIndex = process.argv.indexOf("--cloud");
const cloud = cloudIndex >= 0 ? process.argv[cloudIndex + 1] : undefined;

const clusters = {
  aws: {
    check: [
      "aws",
      [
        "eks",
        "describe-cluster",
        "--name",
        "trinity-dev-aws-cluster",
        "--region",
        "us-east-1",
      ],
    ],
    connect: [
      "aws",
      [
        "eks",
        "update-kubeconfig",
        "--name",
        "trinity-dev-aws-cluster",
        "--region",
        "us-east-1",
        "--alias",
        "trinity-aws",
      ],
    ],
  },
  gcp: {
    check: [
      "gcloud",
      [
        "container",
        "clusters",
        "describe",
        "trinity-dev-gcp-cluster",
        "--region",
        "us-central1",
        "--project",
        "trinity-k8s",
      ],
    ],
    connect: [
      "gcloud",
      [
        "container",
        "clusters",
        "get-credentials",
        "trinity-dev-gcp-cluster",
        "--region",
        "us-central1",
        "--project",
        "trinity-k8s",
      ],
    ],
  },
  azure: {
    check: [
      "az",
      [
        "aks",
        "show",
        "--resource-group",
        "trinity-dev-azure-rg",
        "--name",
        "trinity-dev-azure-cluster",
      ],
    ],
    connect: [
      "az",
      [
        "aks",
        "get-credentials",
        "--resource-group",
        "trinity-dev-azure-rg",
        "--name",
        "trinity-dev-azure-cluster",
        "--overwrite-existing",
      ],
    ],
  },
};

function run(command, args, { allowFailure = false, quiet = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${[command, ...args].join(" ")} failed.`);
  }

  return result;
}

if (!Object.hasOwn(clusters, cloud)) {
  throw new Error("--cloud must be one of aws, gcp, or azure.");
}

const cluster = clusters[cloud];
const exists = run(...cluster.check, { allowFailure: true, quiet: true });

if (exists.status !== 0) {
  console.log(`${cloud} cluster is not reachable or no longer exists; skipping Kubernetes pre-destroy cleanup.`);
  process.exit(0);
}

run(...cluster.connect);
run("npm", ["run", "cleanup:argocd-finalizers"]);
