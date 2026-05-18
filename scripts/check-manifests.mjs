import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const roots = ["apps", "platform"];
const requiredKinds = new Set([
  "Application",
  "AppProject",
  "ConfigMap",
  "ClusterSecretStore",
  "Deployment",
  "ExternalSecret",
  "Kustomization",
  "Namespace",
  "Service",
]);

function walk(directory, files = []) {
  if (!fs.existsSync(directory)) {
    return files;
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      walk(filePath, files);
    } else if (entry.isFile() && filePath.endsWith(".yaml")) {
      files.push(filePath);
    }
  }

  return files;
}

const files = roots.flatMap((root) => walk(root)).sort();

if (files.length === 0) {
  throw new Error("No Kubernetes manifest YAML files found.");
}

for (const file of files) {
  const documents = yaml
    .loadAll(fs.readFileSync(file, "utf8"))
    .filter((document) => document !== null);

  if (documents.length === 0) {
    throw new Error(`${file} does not contain any YAML documents.`);
  }

  for (const document of documents) {
    if (typeof document !== "object" || Array.isArray(document)) {
      throw new Error(`${file} contains a non-object YAML document.`);
    }

    if (!document.apiVersion || !document.kind) {
      throw new Error(`${file} is missing apiVersion or kind.`);
    }

    if (document.kind !== "Kustomization" && !document.metadata?.name) {
      throw new Error(`${file} is missing metadata.name.`);
    }

    if (!requiredKinds.has(document.kind)) {
      throw new Error(`${file} contains unexpected kind ${document.kind}.`);
    }
  }
}

console.log(`Checked ${files.length} manifest files.`);
