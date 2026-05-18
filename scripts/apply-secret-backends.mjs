#!/usr/bin/env node

import {
  awsSecretNames,
  azureSecretNames,
  gcpSecretNames,
  optionalPassword,
  parseCloudArg,
  pulumiConfig,
  run,
  tryOutput,
} from "./secret-backends-lib.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function valueFor(cloud, key, fallbackKey) {
  return fallbackKey ? optionalPassword(cloud, key, fallbackKey) : pulumiConfig(cloud, key);
}

function withSecretFile(value, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "trinity-secret-"));
  const file = path.join(directory, "value");
  fs.writeFileSync(file, value, { mode: 0o600 });

  try {
    return callback(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function applyAws() {
  const { region, entries } = awsSecretNames();

  for (const [configKey, name, fallbackKey] of entries) {
    const value = valueFor("aws", configKey, fallbackKey);
    if (!value) {
      console.log(`Skipping AWS secret ${name}; trinity:${configKey} is not set.`);
      continue;
    }

    const existing = tryOutput("aws", [
      "secretsmanager",
      "describe-secret",
      "--secret-id",
      name,
      "--region",
      region,
      "--output",
      "json",
    ]);

    if (!existing) {
      withSecretFile(value, (file) => {
        run("aws", [
          "secretsmanager",
          "create-secret",
          "--name",
          name,
          "--region",
          region,
          "--secret-string",
          `file://${file}`,
          "--tags",
          "Key=app,Value=trinity",
          "Key=managed-by,Value=github-actions",
        ]);
      });
      continue;
    }

    const secret = JSON.parse(existing);
    if (secret.DeletedDate) {
      throw new Error(
        `AWS secret ${name} is scheduled for deletion. Run the manual Secret Backends delete workflow before applying.`,
      );
    }

    withSecretFile(value, (file) => {
      run("aws", [
        "secretsmanager",
        "put-secret-value",
        "--secret-id",
        name,
        "--region",
        region,
        "--secret-string",
        `file://${file}`,
      ]);
    });
  }
}

function applyGcp() {
  const { project, entries } = gcpSecretNames();

  for (const [configKey, name, fallbackKey] of entries) {
    const exists = tryOutput("gcloud", [
      "secrets",
      "describe",
      name,
      "--project",
      project,
      "--format",
      "value(name)",
    ]);

    if (!exists) {
      run("gcloud", [
        "secrets",
        "create",
        name,
        "--project",
        project,
        "--replication-policy",
        "automatic",
        "--labels",
        "app=trinity,managed-by=github-actions",
      ]);
    }

    const value = valueFor("gcp", configKey, fallbackKey);
    if (!value) {
      console.log(
        `Created or verified GCP secret ${name}; trinity:${configKey} is not set, so no version was added.`,
      );
      continue;
    }

    run(
      "gcloud",
      [
        "secrets",
        "versions",
        "add",
        name,
        "--project",
        project,
        "--data-file",
        "-",
      ],
      { input: value, stdio: ["pipe", "inherit", "inherit"] },
    );
  }
}

function applyAzure() {
  const { location, resourceGroup, vaultName, entries } = azureSecretNames();

  run("az", ["group", "create", "--name", resourceGroup, "--location", location]);

  const vault = tryOutput("az", [
    "keyvault",
    "show",
    "--name",
    vaultName,
    "--resource-group",
    resourceGroup,
    "--query",
    "name",
    "--output",
    "tsv",
  ]);

  if (!vault) {
    run("az", [
      "keyvault",
      "create",
      "--name",
      vaultName,
      "--resource-group",
      resourceGroup,
      "--location",
      location,
      "--retention-days",
      "7",
      "--enable-rbac-authorization",
      "false",
    ]);
  }

  for (const [configKey, name, fallbackKey] of entries) {
    const value = valueFor("azure", configKey, fallbackKey);
    if (!value) {
      console.log(`Skipping Azure secret ${name}; trinity:${configKey} is not set.`);
      continue;
    }

    withSecretFile(value, (file) => {
      run("az", [
        "keyvault",
        "secret",
        "set",
        "--vault-name",
        vaultName,
        "--name",
        name,
        "--file",
        file,
        "--only-show-errors",
      ]);
    });
  }
}

for (const cloud of parseCloudArg()) {
  console.log(`Applying ${cloud} secret backend.`);
  if (cloud === "aws") applyAws();
  if (cloud === "gcp") applyGcp();
  if (cloud === "azure") applyAzure();
}
