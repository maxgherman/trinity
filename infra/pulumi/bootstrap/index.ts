import * as crypto from "node:crypto";
import * as aws from "@pulumi/aws";
import * as azure from "@pulumi/azure-native";
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

const trinityConfig = new pulumi.Config("trinity");
const gcpConfig = new pulumi.Config("gcp");

const githubOwner = trinityConfig.get("githubOwner") ?? "maxgherman";
const githubRepository = trinityConfig.get("githubRepository") ?? "trinity";
const githubEnvironments = trinityConfig.getObject<string[]>(
  "githubEnvironments",
) ?? ["ci-pr-approval", "infra-deploy-approval"];
const awsRegion = trinityConfig.get("awsRegion") ?? "us-east-1";
const awsProfile = trinityConfig.get("awsProfile");
const azureRegion = trinityConfig.get("azureRegion") ?? "eastus";
const gcpProject = gcpConfig.require("project");
const reuseAwsGithubOidcProvider =
  trinityConfig.getBoolean("reuseAwsGithubOidcProvider") ?? false;
const existingAwsGithubOidcProviderArn = trinityConfig.get(
  "awsGithubOidcProviderArn",
);

const awsManagedPolicyArns = trinityConfig.getObject<string[]>(
  "awsManagedPolicyArns",
) ?? ["arn:aws:iam::aws:policy/AdministratorAccess"];
const gcpProjectRoles = trinityConfig.getObject<string[]>("gcpProjectRoles") ?? [
  "roles/artifactregistry.admin",
  "roles/container.admin",
  "roles/compute.admin",
  "roles/iam.serviceAccountAdmin",
  "roles/iam.serviceAccountUser",
  "roles/secretmanager.admin",
  "roles/serviceusage.serviceUsageAdmin",
];

const repoSlug = `${githubOwner}/${githubRepository}`;
const githubOidcIssuer = "https://token.actions.githubusercontent.com";
const githubSubjects = githubEnvironments.map(
  (environment) => `repo:${repoSlug}:environment:${environment}`,
);
const labels = {
  app: "trinity",
  component: "github-actions-oidc",
  "managed-by": "pulumi",
};

function uuidFromString(input: string): string {
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

const awsProvider = new aws.Provider("bootstrap-aws-provider", {
  region: awsRegion as aws.Region,
  profile: awsProfile,
});

const awsGithubOidcProviderArn = existingAwsGithubOidcProviderArn
  ? pulumi.output(existingAwsGithubOidcProviderArn)
  : reuseAwsGithubOidcProvider
    ? aws.iam.getOpenIdConnectProviderOutput(
        { url: githubOidcIssuer },
        { provider: awsProvider },
      ).arn
    : new aws.iam.OpenIdConnectProvider(
        "trinity-github-oidc",
        {
          url: githubOidcIssuer,
          clientIdLists: ["sts.amazonaws.com"],
          tags: labels,
        },
        { provider: awsProvider },
      ).arn;

const awsGithubActionsRole = new aws.iam.Role(
  "trinity-github-actions",
  {
    name: "trinity-github-actions",
    assumeRolePolicy: awsGithubOidcProviderArn.apply((providerArn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              Federated: providerArn,
            },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              },
              StringLike: {
                "token.actions.githubusercontent.com:sub": githubSubjects,
              },
            },
          },
        ],
      }),
    ),
    tags: labels,
  },
  { provider: awsProvider },
);

awsManagedPolicyArns.map(
  (policyArn) =>
    new aws.iam.RolePolicyAttachment(
      `trinity-github-actions-${policyArn.split("/").pop()}`,
      {
        role: awsGithubActionsRole.name,
        policyArn,
      },
      { provider: awsProvider },
    ),
);

const gcpProvider = new gcp.Provider("bootstrap-gcp-provider", {
  project: gcpProject,
});

const gcpWorkloadIdentityPoolId = "trinity-github";
const gcpWorkloadIdentityProviderId = "github";
const gcpServiceAccount = new gcp.serviceaccount.Account(
  "trinity-github-actions",
  {
    accountId: "trinity-github-actions",
    displayName: "The Trinity GitHub Actions",
    description: `GitHub Actions OIDC identity for ${repoSlug}.`,
    project: gcpProject,
  },
  { provider: gcpProvider },
);

const gcpWorkloadIdentityPool = new gcp.iam.WorkloadIdentityPool(
  "trinity-github",
  {
    workloadIdentityPoolId: gcpWorkloadIdentityPoolId,
    displayName: "Trinity GitHub",
    description: `GitHub Actions identities for ${repoSlug}.`,
    project: gcpProject,
  },
  { provider: gcpProvider },
);

const gcpEnvironmentCondition = githubEnvironments
  .map((environment) => `assertion.environment == '${environment}'`)
  .join(" || ");
const gcpWorkloadIdentityProvider = new gcp.iam.WorkloadIdentityPoolProvider(
  "trinity-github",
  {
    workloadIdentityPoolId: gcpWorkloadIdentityPoolId,
    workloadIdentityPoolProviderId: gcpWorkloadIdentityProviderId,
    displayName: "GitHub",
    description: `GitHub Actions OIDC provider for ${repoSlug}.`,
    project: gcpProject,
    attributeMapping: {
      "google.subject": "assertion.sub",
      "attribute.repository": "assertion.repository",
      "attribute.environment": "assertion.environment",
    },
    attributeCondition: `assertion.repository == '${repoSlug}' && (${gcpEnvironmentCondition})`,
    oidc: {
      issuerUri: githubOidcIssuer,
    },
  },
  { provider: gcpProvider, dependsOn: [gcpWorkloadIdentityPool] },
);

new gcp.serviceaccount.IAMMember(
  "trinity-github-actions-workload-identity-user",
  {
    serviceAccountId: gcpServiceAccount.name,
    role: "roles/iam.workloadIdentityUser",
    member: pulumi.interpolate`principalSet://iam.googleapis.com/${gcpWorkloadIdentityPool.name}/attribute.repository/${repoSlug}`,
  },
  { provider: gcpProvider, dependsOn: [gcpWorkloadIdentityProvider] },
);

gcpProjectRoles.map(
  (role) =>
    new gcp.projects.IAMMember(
      `trinity-github-actions-${role.split("/").pop()}`,
      {
        project: gcpProject,
        role,
        member: pulumi.interpolate`serviceAccount:${gcpServiceAccount.email}`,
      },
      { provider: gcpProvider },
    ),
);

const azureClient = azure.authorization.getClientConfigOutput();
const azureSubscriptionScope = azureClient.subscriptionId.apply(
  (subscriptionId) => `/subscriptions/${subscriptionId}`,
);
const azureResourceGroup = new azure.resources.ResourceGroup(
  "trinity-bootstrap",
  {
    resourceGroupName: "trinity-bootstrap",
    location: azureRegion,
    tags: labels,
  },
);

const azureGithubActionsIdentity = new azure.managedidentity.UserAssignedIdentity(
  "trinity-github-actions",
  {
    resourceGroupName: azureResourceGroup.name,
    resourceName: "trinity-github-actions",
    location: azureResourceGroup.location,
    tags: labels,
  },
);

githubEnvironments.map((environment) => {
  const safeEnvironment = environment.replace(/[^A-Za-z0-9]/g, "-");

  return new azure.managedidentity.FederatedIdentityCredential(
    `trinity-github-actions-${safeEnvironment}`,
    {
      resourceGroupName: azureResourceGroup.name,
      resourceName: azureGithubActionsIdentity.name,
      federatedIdentityCredentialResourceName: `github-${safeEnvironment}`,
      issuer: githubOidcIssuer,
      subject: `repo:${repoSlug}:environment:${environment}`,
      audiences: ["api://AzureADTokenExchange"],
    },
  );
});

new azure.authorization.RoleAssignment("trinity-github-actions-contributor", {
  scope: azureSubscriptionScope,
  roleAssignmentName: uuidFromString(
    `trinity-github-actions-contributor:${repoSlug}`,
  ),
  roleDefinitionId: azureSubscriptionScope.apply(
    (scope) =>
      `${scope}/providers/Microsoft.Authorization/roleDefinitions/b24988ac-6180-42a0-ab88-20f7382dd24c`,
  ),
  principalId: azureGithubActionsIdentity.principalId,
  principalType: azure.authorization.PrincipalType.ServicePrincipal,
});

new azure.authorization.RoleAssignment(
  "trinity-github-actions-key-vault-purge-operator",
  {
    scope: azureSubscriptionScope,
    roleAssignmentName: uuidFromString(
      `trinity-github-actions-key-vault-purge-operator:${repoSlug}`,
    ),
    roleDefinitionId: azureSubscriptionScope.apply(
      (scope) =>
        `${scope}/providers/Microsoft.Authorization/roleDefinitions/a68e7c17-0ab2-4c09-9a58-125dae29748c`,
    ),
    principalId: azureGithubActionsIdentity.principalId,
    principalType: azure.authorization.PrincipalType.ServicePrincipal,
  },
);

export const AWS_GITHUB_ACTIONS_ROLE_ARN = awsGithubActionsRole.arn;
export const GCP_WORKLOAD_IDENTITY_PROVIDER = gcpWorkloadIdentityProvider.name;
export const GCP_SERVICE_ACCOUNT = gcpServiceAccount.email;
export const AZURE_CLIENT_ID = azureGithubActionsIdentity.clientId;
export const AZURE_TENANT_ID = azureClient.tenantId;
export const AZURE_SUBSCRIPTION_ID = azureClient.subscriptionId;
export const GITHUB_ENVIRONMENTS = githubEnvironments;
