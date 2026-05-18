export type Cloud = "aws" | "gcp" | "azure";

export function resourceName(
  cloud: Cloud,
  environment: string,
  component: string,
) {
  return `trinity-${environment}-${cloud}-${component}`;
}

export function commonLabels(cloud: Cloud, environment: string) {
  return {
    app: "trinity",
    environment,
    cloud,
    "managed-by": "pulumi",
  };
}
