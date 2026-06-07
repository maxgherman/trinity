import * as crypto from "node:crypto";

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

export function uuidFromString(input: string): string {
  const hash = crypto.createHash("sha1").update(input).digest("hex");

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${((Number.parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80)
      .toString(16)
      .padStart(2, "0")}${hash.slice(18, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}
