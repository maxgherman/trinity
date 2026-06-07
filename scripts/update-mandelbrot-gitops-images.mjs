import { readFileSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";

const args = parseArgs(process.argv.slice(2));

if (args.metadataFiles.length === 0) {
  throw new Error("At least one --metadata-file value is required.");
}

for (const metadataFile of args.metadataFiles) {
  const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
  const cloud = requireSupportedCloud(metadata.cloud);
  const repository = requireString(metadata.repository, "metadata.repository");
  const tag = requireString(metadata.tags?.[0], "metadata.tags[0]");
  const path = `apps/mandelbrot/overlays/${cloud}/kustomization.yaml`;
  const kustomization = yaml.load(readFileSync(path, "utf8"));

  if (!kustomization || typeof kustomization !== "object") {
    throw new Error(`${path} must contain a YAML object.`);
  }

  kustomization.images = [
    {
      name: "mandelbrot",
      newName: repository,
      newTag: tag,
    },
  ];

  writeFileSync(path, yaml.dump(kustomization, { lineWidth: -1 }));
  console.log(`Updated ${path} to ${repository}:${tag}`);
}

function parseArgs(argv) {
  const parsed = {
    metadataFiles: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--metadata-file") {
      parsed.metadataFiles.push(requireValue(arg, value));
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requireValue(name, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
}

function requireSupportedCloud(cloud) {
  if (!["aws", "gcp", "azure"].includes(cloud)) {
    throw new Error(`Unsupported cloud "${cloud}".`);
  }

  return cloud;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }

  return value;
}
