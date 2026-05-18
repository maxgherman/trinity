#!/usr/bin/env node

import {
  awsSecretNames,
  azureSecretNames,
  gcpSecretNames,
  parseCloudArg,
  run,
  tryOutput,
} from "./secret-backends-lib.mjs";

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitUntil(message, predicate, timeoutSeconds = 90) {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    if (predicate()) return;
    sleep(5000);
  }

  throw new Error(`Timed out waiting for ${message}.`);
}

function deleteAws() {
  const { region, entries } = awsSecretNames();

  for (const [, name] of entries) {
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
    if (!existing) continue;

    const secret = JSON.parse(existing);
    if (secret.DeletedDate) {
      run("aws", [
        "secretsmanager",
        "restore-secret",
        "--secret-id",
        name,
        "--region",
        region,
      ]);
    }

    run("aws", [
      "secretsmanager",
      "delete-secret",
      "--secret-id",
      name,
      "--region",
      region,
      "--force-delete-without-recovery",
    ]);

    waitUntil(`AWS secret ${name} to be deleted`, () =>
      !tryOutput("aws", [
        "secretsmanager",
        "describe-secret",
        "--secret-id",
        name,
        "--region",
        region,
      ]),
    );
  }
}

function deleteGcp() {
  const { project, entries } = gcpSecretNames();

  for (const [, name] of entries) {
    const exists = tryOutput("gcloud", [
      "secrets",
      "describe",
      name,
      "--project",
      project,
      "--format",
      "value(name)",
    ]);
    if (!exists) continue;

    run("gcloud", ["secrets", "delete", name, "--project", project, "--quiet"]);
  }
}

function deleteAzure() {
  const { location, resourceGroup, vaultName } = azureSecretNames();
  const exists = tryOutput("az", [
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

  if (exists) {
    run("az", [
      "keyvault",
      "delete",
      "--name",
      vaultName,
      "--resource-group",
      resourceGroup,
      "--only-show-errors",
    ]);

    waitUntil(`Azure Key Vault ${vaultName} to enter deleted state`, () =>
      Boolean(
        tryOutput("az", [
          "keyvault",
          "show-deleted",
          "--name",
          vaultName,
          "--location",
          location,
          "--query",
          "name",
          "--output",
          "tsv",
        ]),
      ),
    );
  }

  const deleted = tryOutput("az", [
    "keyvault",
    "show-deleted",
    "--name",
    vaultName,
    "--location",
    location,
    "--query",
    "name",
    "--output",
    "tsv",
  ]);

  if (deleted) {
    run("az", [
      "keyvault",
      "purge",
      "--name",
      vaultName,
      "--location",
      location,
      "--only-show-errors",
    ]);

    waitUntil(`Azure Key Vault ${vaultName} to be purged`, () =>
      !tryOutput("az", [
        "keyvault",
        "show-deleted",
        "--name",
        vaultName,
        "--location",
        location,
        "--query",
        "name",
        "--output",
        "tsv",
      ]),
    );
  }
}

for (const cloud of parseCloudArg()) {
  console.log(`Deleting ${cloud} secret backend.`);
  if (cloud === "aws") deleteAws();
  if (cloud === "gcp") deleteGcp();
  if (cloud === "azure") deleteAzure();
}
