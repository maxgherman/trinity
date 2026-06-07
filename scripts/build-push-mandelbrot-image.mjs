import { spawnSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const cloud = requireOption(args.cloud, "--cloud");
const tags = args.tag;
const environment = process.env.TRINITY_ENVIRONMENT ?? "dev";

if (!["aws", "gcp", "azure"].includes(cloud)) {
  throw new Error(`Unsupported cloud "${cloud}". Expected aws, gcp, or azure.`);
}

if (tags.length === 0) {
  throw new Error("At least one --tag value is required.");
}

const imageRepository = resolveImageRepository(cloud, environment);
const imageTags = tags.map((tag) => `${imageRepository}:${tag}`);

if (args.skipIfMissing && !registryExists(cloud, imageRepository)) {
  const localTag = `trinity-mandelbrot:${tags[0]}`;
  console.warn(
    `Registry for ${imageRepository} does not exist yet; building ${localTag} without pushing.`,
  );
  run("docker", [
    "build",
    "--pull",
    "-f",
    "apps/mandelbrot/Dockerfile",
    "-t",
    localTag,
    "apps/mandelbrot",
  ]);
  process.exit(0);
}

login(cloud, imageRepository);
run("docker", [
  "build",
  "--pull",
  "-f",
  "apps/mandelbrot/Dockerfile",
  ...imageTags.flatMap((tag) => ["-t", tag]),
  "apps/mandelbrot",
]);

for (const imageTag of imageTags) {
  run("docker", ["push", imageTag]);
}

console.log(`Pushed ${imageTags.join(", ")}`);

function parseArgs(argv) {
  const parsed = {
    cloud: "",
    tag: [],
    skipIfMissing: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--cloud") {
      parsed.cloud = requireValue(arg, value);
      index += 1;
    } else if (arg === "--tag") {
      parsed.tag.push(requireValue(arg, value));
      index += 1;
    } else if (arg === "--skip-if-missing") {
      parsed.skipIfMissing = true;
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

function requireOption(value, name) {
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function resolveImageRepository(targetCloud, targetEnvironment) {
  if (targetCloud === "aws") {
    const region = process.env.AWS_REGION ?? "us-east-1";
    const accountId =
      process.env.AWS_ACCOUNT_ID ??
      runCapture("aws", [
        "sts",
        "get-caller-identity",
        "--query",
        "Account",
        "--output",
        "text",
      ]);

    return `${accountId}.dkr.ecr.${region}.amazonaws.com/trinity-${targetEnvironment}-aws-mandelbrot`;
  }

  if (targetCloud === "gcp") {
    const project = process.env.GCP_PROJECT ?? "trinity-k8s";
    const region = process.env.GCP_REGION ?? "us-central1";

    return `${region}-docker.pkg.dev/${project}/trinity-${targetEnvironment}-gcp-mandelbrot/mandelbrot`;
  }

  const registryName =
    process.env.AZURE_CONTAINER_REGISTRY ??
    `trinity${targetEnvironment}azureacr`.replace(/[^A-Za-z0-9]/g, "").slice(0, 50);

  return `${registryName}.azurecr.io/mandelbrot`;
}

function login(targetCloud, imageRepository) {
  if (targetCloud === "aws") {
    const region = process.env.AWS_REGION ?? "us-east-1";
    const registryHost = imageRepository.split("/")[0];
    const password = runCapture("aws", [
      "ecr",
      "get-login-password",
      "--region",
      region,
    ]);

    run("docker", ["login", "--username", "AWS", "--password-stdin", registryHost], {
      input: password,
    });
    return;
  }

  if (targetCloud === "gcp") {
    const region = process.env.GCP_REGION ?? "us-central1";
    run("gcloud", ["auth", "configure-docker", `${region}-docker.pkg.dev`, "--quiet"]);
    return;
  }

  const registryName = imageRepository.split(".")[0];
  ensureAzureAdminEnabled(registryName);
  const username = runCapture("az", [
    "acr",
    "credential",
    "show",
    "--name",
    registryName,
    "--query",
    "username",
    "--output",
    "tsv",
  ]);
  const password = runCapture("az", [
    "acr",
    "credential",
    "show",
    "--name",
    registryName,
    "--query",
    "passwords[0].value",
    "--output",
    "tsv",
  ]);

  run("docker", ["login", "--username", username, "--password-stdin", imageRepository.split("/")[0]], {
    input: password,
  });
}

function ensureAzureAdminEnabled(registryName) {
  const adminEnabled = runCapture("az", [
    "acr",
    "show",
    "--name",
    registryName,
    "--query",
    "adminUserEnabled",
    "--output",
    "tsv",
  ]);

  if (adminEnabled.trim().toLowerCase() === "true") {
    return;
  }

  console.log(`Enabling admin credentials for Azure Container Registry ${registryName}.`);
  run("az", ["acr", "update", "--name", registryName, "--admin-enabled", "true"]);
}

function registryExists(targetCloud, imageRepository) {
  if (targetCloud === "aws") {
    const region = process.env.AWS_REGION ?? "us-east-1";
    const repositoryName = imageRepository.split("/").slice(1).join("/");

    return runStatus("aws", [
      "ecr",
      "describe-repositories",
      "--repository-names",
      repositoryName,
      "--region",
      region,
    ]) === 0;
  }

  if (targetCloud === "gcp") {
    const region = process.env.GCP_REGION ?? "us-central1";
    const project = process.env.GCP_PROJECT ?? "trinity-k8s";
    const repositoryName = imageRepository.split("/")[2];

    return runStatus("gcloud", [
      "artifacts",
      "repositories",
      "describe",
      repositoryName,
      "--location",
      region,
      "--project",
      project,
    ]) === 0;
  }

  const registryName = imageRepository.split(".")[0];
  return runStatus("az", ["acr", "show", "--name", registryName]) === 0;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: options.input ? ["pipe", "inherit", "inherit"] : "inherit",
    input: options.input,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed.`);
  }
}

function runStatus(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    stdio: "ignore",
  });

  return result.status ?? 1;
}

function runCapture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`${command} ${commandArgs.join(" ")} failed.`);
  }

  return result.stdout.trim();
}
