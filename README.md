# The Trinity

Multi-cloud Kubernetes platform exercise across AWS, GCP, and Azure.

The first phase provisions one managed Kubernetes cluster per cloud with Pulumi:

- AWS: EKS
- GCP: GKE
- Azure: AKS

The second phase moves Kubernetes application delivery to Argo CD. Pulumi still owns cloud infrastructure and Argo CD bootstrap. Argo CD owns the Kubernetes application state under `apps/` and `platform/`.

## Structure

```text
apps/
  hello/
    base/
    overlays/
      aws/
      gcp/
      azure/
  mandelbrot/
    base/
    overlays/
      aws/
      gcp/
      azure/
infra/
  pulumi/
    bootstrap/
    aws/
    gcp/
    azure/
    components/
platform/
  argocd/
    applications/
    clusters/
    projects/
```

Each cloud folder is a separate Pulumi project. Shared helpers live in `infra/pulumi/components`.

The `hello` app is a temporary proof workload. It is deployed by Argo CD from
Kustomize overlays, one overlay per cloud.

The `mandelbrot` app is the first multi-cloud demo workload. Each cluster runs
the same renderer service with cloud-specific overlay configuration. A render
job splits one Mandelbrot image into horizontal tiles, asks each cloud stage to
compute one tile, then stitches the tiles back together in the browser. Until
stable per-cluster origin URLs are configured, missing remote stage URLs fall
back to local rendering so the app remains deployable during bootstrap.

## Bootstrap CI/CD Identity

The bootstrap stack creates the GitHub Actions OIDC identities used by CI and deployment:

- AWS IAM OIDC provider and GitHub Actions role
- GCP Workload Identity Federation provider and service account
- Azure user-assigned managed identity, federated credentials, and role assignment

AWS allows only one IAM OIDC provider per issuer URL in an account. If another
project already created the GitHub Actions provider, keep
`trinity:reuseAwsGithubOidcProvider: true` in the bootstrap stack config. The
bootstrap stack will look up `https://token.actions.githubusercontent.com` and
create only the Trinity-specific IAM role. If lookup by URL is not enough, set
`trinity:awsGithubOidcProviderArn` to the existing provider ARN.

Run it once locally with cloud-admin credentials:

```sh
npm run preview:bootstrap
npm run up:bootstrap
```

Then copy these stack outputs into both GitHub environments, `ci-pr-approval` and `infra-deploy-approval`, as environment variables:

- `AWS_GITHUB_ACTIONS_ROLE_ARN`
- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT`
- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

`PULUMI_ACCESS_TOKEN` is still a GitHub environment secret. Create it in Pulumi Cloud and add it manually to both environments.

The bootstrap stack is intentionally separate from the cluster stacks. Destroying it removes CI/CD access to the cloud accounts.

## Prerequisites

- Node.js 20+
- Pulumi CLI
- kubectl
- AWS credentials for EKS
- Google Cloud credentials and `gke-gcloud-auth-plugin` for GKE
- Azure credentials for AKS

## Install

```sh
npm install
```

## Check

```sh
npm run check
```

## GitHub Actions

CI runs on pull requests and is gated by the `ci-pr-approval` environment. After approval it validates TypeScript, validates Kubernetes manifests, renders Kustomize overlays, and runs `pulumi preview` for AWS, GCP, and Azure.

`Pulumi Deploy` runs after changes are merged to `main`. It is gated by the `infra-deploy-approval` environment before cloud credentials are configured or `pulumi up` runs. The workflow can also be manually triggered from GitHub Actions to run `up` or `destroy` for `aws`, `gcp`, `azure`, or `all`.

Required GitHub environments:

- `ci-pr-approval` for pull-request validation and previews
- `infra-deploy-approval` for post-merge deployment approval

Use those environments for required reviewers, deployment branch rules, and infrastructure variables. This keeps cloud credentials and `pulumi up` out of local laptops while still making infrastructure changes deliberate.

Required GitHub secret:

- `PULUMI_ACCESS_TOKEN`

Required GitHub variables from the bootstrap stack:

- `AWS_GITHUB_ACTIONS_ROLE_ARN`
- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT`
- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

The cloud credentials should use GitHub OIDC. The preview workflow intentionally does not run `pulumi up` or `pulumi destroy`.
The GCP jobs also install `gke-gcloud-auth-plugin` because the generated GKE
kubeconfig uses that helper when Pulumi creates or destroys Kubernetes
resources.

## Preview

Open a pull request and approve the `ci-pr-approval` environment deployment. The CI workflow runs previews for all three clouds.

Local previews are still available one cloud at a time:

```sh
npm run preview:aws
npm run preview:gcp
npm run preview:azure
```

## Deploy

Merge to `main` and approve the `infra-deploy-approval` environment deployment. The deploy workflow applies all three Pulumi stacks.

The deploy workflow can also be run manually from GitHub Actions for `aws`, `gcp`, `azure`, or `all`.

Local deployment is still available for development or recovery:

```sh
npm run up:aws
npm run up:gcp
npm run up:azure
```

Each stack creates:

- one managed Kubernetes cluster
- a kubeconfig stack output
- Argo CD in the `argocd` namespace
- a root Argo CD application for that cloud

The root Argo CD application reconciles:

- the `trinity` Argo CD project
- the cloud-specific `hello` application
- the `hello` namespace, deployment, and public `LoadBalancer` service
- the cloud-specific `mandelbrot` application
- the `mandelbrot` namespace, deployment, and public `LoadBalancer` service

## Validate

When GitHub Actions creates the AWS cluster, the deployment workflow passes
`AWS_GITHUB_ACTIONS_ROLE_ARN` to `aws-actions/configure-aws-credentials`.
Because the workflow role creates the EKS cluster, EKS bootstraps that role with
cluster-admin access. The stack does not create a separate access entry for the
workflow role.

To check a GitHub-created AWS cluster from a local shell, also set the optional
GitHub environment variable `AWS_CLUSTER_ADMIN_PRINCIPAL_ARN` to your IAM user
or role ARN before deploying. The stack will grant that principal cluster-admin
access too.

For local AWS deployment, make the kubeconfig authentication explicit before
creating the cluster if you use a named AWS profile:

```sh
pulumi -C infra/pulumi/aws config set trinity:awsProfile <profile-name>
```

If kubectl should assume a specific IAM role, grant that role cluster-admin
access and embed it in the exported kubeconfig:

```sh
pulumi -C infra/pulumi/aws config set trinity:awsKubeconfigRoleArn arn:aws:iam::<account-id>:role/<role-name>
```

If you only need to grant cluster-admin access to a principal without embedding
it in the kubeconfig, set `trinity:awsClusterAdminPrincipalArn` instead.

After a stack is deployed, export its kubeconfig and check the cluster:

```sh
pulumi -C infra/pulumi/aws stack output kubeconfig --show-secrets > kubeconfig.aws.yaml
KUBECONFIG=./kubeconfig.aws.yaml kubectl get nodes
```

Then check Argo CD:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n argocd get pods
pulumi -C infra/pulumi/aws stack output argocdRootApplicationName
```

Then check the GitOps-managed hello service:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n hello get deployment,service,pods
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n hello get service hello
```

Use whichever `EXTERNAL-IP` value is populated by the cloud provider. AWS commonly returns a hostname; GCP and Azure commonly return an IP:

```sh
curl "http://<external-hostname-or-ip>"
```

Then check the Mandelbrot renderer:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n mandelbrot get deployment,service,pods
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n mandelbrot get service mandelbrot
curl "http://<mandelbrot-external-hostname-or-ip>/readyz"
```

For a true cross-cluster render, configure the `AWS_STAGE_URL`,
`GCP_STAGE_URL`, and `AZURE_STAGE_URL` values in the `mandelbrot` overlays after
the public per-cluster origins exist. The first version can use the service
`EXTERNAL-IP` values directly. Later phases should move those origins behind
stable DNS names and Azure Front Door health checks.

After all three services exist, collect the origins:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n mandelbrot get service mandelbrot
KUBECONFIG=./kubeconfig.gcp.yaml kubectl -n mandelbrot get service mandelbrot
KUBECONFIG=./kubeconfig.azure.yaml kubectl -n mandelbrot get service mandelbrot
```

Then set those HTTP origins in each overlay's `mandelbrot-stage-urls`
`configMapGenerator`:

```yaml
configMapGenerator:
  - name: mandelbrot-stage-urls
    behavior: merge
    literals:
      - AWS_STAGE_URL=http://<aws-origin>
      - GCP_STAGE_URL=http://<gcp-origin>
      - AZURE_STAGE_URL=http://<azure-origin>
```

The stage cards in the UI show both the requested cloud and the cloud that
actually rendered the tile. If a stage URL is empty, the service renders that
tile locally and marks it as a fallback.

Repeat with `gcp` and `azure` kubeconfig files and stack outputs.

## Destroy

The preferred CI/CD path is a manual `Pulumi Deploy` workflow run:

- set `operation` to `destroy`
- set `cloud` to `all`, or choose one cloud
- approve the `infra-deploy-approval` environment

That destroys the selected Pulumi cluster stacks using GitHub OIDC credentials.
It does not destroy the separate bootstrap stack.

Local destroy is still available for development or recovery:

```sh
npm run destroy:aws
npm run destroy:gcp
npm run destroy:azure
```
