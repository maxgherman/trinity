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
    traffic/
    components/
platform/
  argocd/
    applications/
    clusters/
    projects/
  observability/
    base/
    overlays/
```

Each cloud folder is a separate Pulumi project. Shared helpers live in `infra/pulumi/components`.
The `traffic` project owns the Azure Front Door global entry point.

The `hello` app is a temporary proof workload. It is deployed by Argo CD from
Kustomize overlays, one overlay per cloud.

The `mandelbrot` app is the first multi-cloud demo workload. Each cluster runs
the same renderer service with cloud-specific overlay configuration. A render
job splits one Mandelbrot image into horizontal tiles, asks each cloud stage to
compute one tile, then stitches the tiles back together in the browser. Until
the traffic stack writes the per-cluster stage URLs, missing remote stage URLs
fall back to local rendering so the app remains deployable during bootstrap.

The first observability slice runs Prometheus and Grafana in each cluster.
Prometheus scrapes the Mandelbrot `/metrics` endpoint, and Grafana provisions a
small Mandelbrot dashboard from Git.

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

CI runs on pull requests and is gated by the `ci-pr-approval` environment. After approval it validates TypeScript, validates Kubernetes manifests, renders Kustomize overlays, and runs `pulumi preview` for AWS, GCP, Azure, and the traffic stack.

`Pulumi Deploy` runs after changes are merged to `main`. It is gated by the `infra-deploy-approval` environment before cloud credentials are configured or `pulumi up` runs. The workflow can also be manually triggered from GitHub Actions to run `up` or `destroy` for `aws`, `gcp`, `azure`, `traffic`, or `all`. For `all`, the workflow deploys the cluster stacks before the traffic stack and destroys the traffic stack before the cluster stacks.

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
resources. The traffic jobs authenticate to all three clouds because the traffic
stack writes stage URL ConfigMaps into all three clusters.

## Preview

Open a pull request and approve the `ci-pr-approval` environment deployment. The CI workflow runs previews for all three clouds.

Local previews are still available one cloud at a time:

```sh
npm run preview:aws
npm run preview:gcp
npm run preview:azure
npm run preview:traffic
```

## Deploy

Merge to `main` and approve the `infra-deploy-approval` environment deployment. The deploy workflow applies all three Pulumi stacks.

The deploy workflow can also be run manually from GitHub Actions for `aws`, `gcp`, `azure`, `traffic`, or `all`.
When `all` is selected for `up`, the workflow applies AWS, GCP, and Azure first,
then applies the traffic stack so Azure Front Door can read the cluster stack
outputs. When `all` is selected for `destroy`, it destroys the traffic stack
first, then destroys the cloud stacks and their static origin addresses.

Local deployment is still available for development or recovery:

```sh
npm run up:aws
npm run up:gcp
npm run up:azure
npm run up:traffic
```

Each stack creates:

- one managed Kubernetes cluster
- a kubeconfig stack output
- Argo CD in the `argocd` namespace
- a root Argo CD application for that cloud
- a static public origin address for Mandelbrot
- the Mandelbrot public `LoadBalancer` service bound to that static origin

The root Argo CD application reconciles:

- the `trinity` Argo CD project
- the cloud-specific `hello` application
- the `hello` namespace, deployment, and public `LoadBalancer` service
- the cloud-specific `mandelbrot` application
- the `mandelbrot` deployment and runtime ConfigMaps

Pulumi owns the Mandelbrot namespace and public service because the service
needs cloud-specific static address bindings. Destroying the cloud stack also
deletes the static address resources.

The traffic stack creates:

- an Azure Front Door Standard profile
- one Front Door endpoint
- one origin group with `/readyz` health probes
- three HTTP origins read from the AWS, GCP, and Azure stack outputs
- an HTTPS route that forwards to those origins over HTTP
- a `mandelbrot-stage-urls` ConfigMap in each cluster, populated from the same
  stack outputs

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

For a true cross-cluster render, apply the traffic stack after the three cluster
stacks. It reads the per-cluster origins from stack outputs:

```sh
pulumi -C infra/pulumi/aws stack output mandelbrotStageUrl
pulumi -C infra/pulumi/gcp stack output mandelbrotStageUrl
pulumi -C infra/pulumi/azure stack output mandelbrotStageUrl
```

Then it writes those values into each cluster:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n mandelbrot get configmap mandelbrot-stage-urls -o yaml
KUBECONFIG=./kubeconfig.gcp.yaml kubectl -n mandelbrot get configmap mandelbrot-stage-urls -o yaml
KUBECONFIG=./kubeconfig.azure.yaml kubectl -n mandelbrot get configmap mandelbrot-stage-urls -o yaml
```

The stage cards in the UI show both the requested cloud and the cloud that
actually rendered the tile. If a stage URL is empty, the service renders that
tile locally and marks it as a fallback.

## Traffic

After the three cluster stacks are deployed, the traffic stack reads their
`mandelbrotOriginHost` outputs through Pulumi stack references. No GitHub
environment variables or copied load balancer addresses are required.

Then run the `Pulumi Deploy` workflow manually with:

```text
operation: up
cloud: traffic
```

The traffic stack outputs the default Front Door hostname:

```sh
pulumi -C infra/pulumi/traffic stack output frontDoorEndpointHostName
pulumi -C infra/pulumi/traffic stack output frontDoorEndpointUrl
```

Azure Front Door serves HTTPS on the default endpoint after its global
configuration has propagated:

```sh
curl "$(pulumi -C infra/pulumi/traffic stack output frontDoorEndpointUrl)/readyz"
```

Right after the traffic stack finishes, the endpoint can temporarily return an
Azure `Page not found` response saying the Front Door Service configuration was
not found. That usually means the Front Door data plane has not activated the
new endpoint and route yet, not that the Kubernetes origins are broken.
Microsoft documents that a single Front Door create or update can take up to 20
minutes, and back-to-back changes can take about 40 minutes because updates are
queued.

Check the endpoint deployment status before changing the infrastructure:

```sh
az afd endpoint show \
  --resource-group trinity-dev-azure-traffic-rg \
  --profile-name trinity-dev-azure-frontdoor \
  --endpoint-name trinity-dev-azure-mandelbrot \
  --query "{provisioningState:provisioningState,deploymentStatus:deploymentStatus,hostName:hostName}" \
  -o json
```

If `deploymentStatus` is still `NotStarted` inside that propagation window,
wait and test again. If it remains stuck after about 40 minutes, verify the
three direct origin `/readyz` endpoints before recreating or updating only the
traffic stack.

### Front Door failover drill

After the endpoint is active, run a controlled failover drill from a shell that
has `pulumi` and `az` authenticated to the traffic subscription:

```sh
npm run test:traffic-failover -- --cloud gcp
```

The drill disables the selected cloud's Front Door origin, polls
`/api/meta` through the public Front Door endpoint until responses stop coming
from that cloud, and then re-enables the origin. Use `--cloud aws` to disable
both AWS Front Door origins, `aws` and `aws-2`, because the AWS service is
backed by two static NLB Elastic IPs.

Front Door data-plane propagation is asynchronous, so the drill can take
several minutes. If it is interrupted, re-enable the origin manually:

```sh
az afd origin update \
  --resource-group trinity-dev-azure-traffic-rg \
  --profile-name trinity-dev-azure-frontdoor \
  --origin-group-name mandelbrot \
  --origin-name gcp \
  --enabled-state Enabled
```

## Observability

Argo CD deploys an observability application per cloud:

```text
trinity-observability-aws
trinity-observability-gcp
trinity-observability-azure
```

Each application points at `platform/observability/overlays/<cloud>`. The base
manifests create:

- `observability` namespace
- Prometheus with a static scrape target for `mandelbrot.mandelbrot.svc.cluster.local:80`
- Grafana with a pre-provisioned Prometheus data source
- a `Trinity Mandelbrot` dashboard

After Argo CD syncs the observability app, check one cluster:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n argocd get application trinity-observability-aws
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability get deployment,service,pods
```

Generate a few Mandelbrot renders through Front Door, then inspect Prometheus:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability port-forward service/prometheus 9090:9090
```

Open `http://localhost:9090/targets` and confirm the `mandelbrot` target is up.
Grafana is available the same way:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability port-forward service/grafana 3000:3000
```

Open `http://localhost:3000/d/trinity-mandelbrot/trinity-mandelbrot`.

## Destroy

The preferred CI/CD path is a manual `Pulumi Deploy` workflow run:

- set `operation` to `destroy`
- set `cloud` to `all`, or choose one stack
- approve the `infra-deploy-approval` environment

That destroys the selected Pulumi stacks using GitHub OIDC credentials. It does
not destroy the separate bootstrap stack.

Local destroy is still available for development or recovery:

```sh
npm run destroy:aws
npm run destroy:gcp
npm run destroy:azure
npm run destroy:traffic
```
