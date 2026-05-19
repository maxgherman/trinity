import { spawnSync } from "node:child_process";

const namespace = process.env.ARGOCD_NAMESPACE ?? "argocd";
const kinds = [
  "applications.argoproj.io",
  "applicationsets.argoproj.io",
  "appprojects.argoproj.io",
];

function run(args, { allowFailure = false, capture = false } = {}) {
  const result = spawnSync("kubectl", args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.status !== 0 && !allowFailure) {
    const command = ["kubectl", ...args].join(" ");
    throw new Error(`${command} failed with exit code ${result.status}.`);
  }

  return result;
}

function listResources(kind) {
  const result = run(
    ["-n", namespace, "get", kind, "-o", "name", "--ignore-not-found"],
    { allowFailure: true, capture: true },
  );

  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const namespaceCheck = run(
  ["get", "namespace", namespace],
  { allowFailure: true, capture: true },
);

if (namespaceCheck.status !== 0) {
  console.log(`Namespace ${namespace} does not exist; nothing to clean up.`);
  process.exit(0);
}

for (const kind of kinds) {
  const resources = listResources(kind);

  if (resources.length === 0) {
    console.log(`No ${kind} resources found in ${namespace}.`);
    continue;
  }

  for (const resource of resources) {
    console.log(`Removing finalizers from ${resource}.`);
    run(
      [
        "-n",
        namespace,
        "patch",
        resource,
        "--type",
        "merge",
        "-p",
        "{\"metadata\":{\"finalizers\":[]}}",
      ],
      { allowFailure: true },
    );

    console.log(`Deleting ${resource}.`);
    run(
      [
        "-n",
        namespace,
        "delete",
        resource,
        "--ignore-not-found",
        "--wait=false",
      ],
      { allowFailure: true },
    );
  }
}

console.log("Argo CD finalizer cleanup completed.");
