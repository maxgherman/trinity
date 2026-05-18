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
  policy/
    base/
    overlays/
  secrets-demo/
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

The observability slice runs Prometheus, Grafana, Loki, Promtail, and Jaeger in
each cluster. Prometheus scrapes the Mandelbrot `/metrics` endpoint, Promtail
ships pod logs to Loki, the Mandelbrot service exports Zipkin-format traces to
Jaeger, and Grafana provisions the datasources and Mandelbrot dashboard from
Git.

The secrets checkpoint installs External Secrets Operator in each cluster and
wires one harmless provider-backed test secret per cloud through
`ClusterSecretStore` and `ExternalSecret` resources. Cloud identities and secret
backend resources are provisioned by Pulumi. Secret values stay out of Git and
come from Pulumi secret config.

The policy checkpoint installs Kyverno in each cluster and applies a small
baseline policy set to Trinity workload namespaces.

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

`Mandelbrot Rollout` is the operator workflow for progressive delivery. It is
also gated by `infra-deploy-approval`, authenticates to the selected cloud
clusters with GitHub OIDC, installs the `kubectl argo rollouts` plugin, and can
sync, inspect, promote, abort, undo, or restart the Mandelbrot rollout in
`aws`, `gcp`, `azure`, or `all`.

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
- the cloud-specific Argo Rollouts controller application
- the cloud-specific `hello` application
- the `hello` namespace, deployment, and public `LoadBalancer` service
- the cloud-specific `mandelbrot` application
- the `mandelbrot` rollout and runtime ConfigMaps
- the cloud-specific observability, secrets, and policy applications

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

## Progressive Delivery

Argo CD installs Argo Rollouts in each cluster through these applications:

```text
trinity-rollouts-aws
trinity-rollouts-gcp
trinity-rollouts-azure
```

The Mandelbrot workload is an Argo Rollouts `Rollout`, not a Kubernetes
`Deployment`. It runs two replicas and uses a simple canary sequence:

```text
50% -> pause for operator inspection -> 100%
```

The app exposes `MANDELBROT_RELEASE` through `/api/meta` and the UI. Change that
value, or another field in the Rollout pod template, in Git to trigger a new
canary. ConfigMap-only edits do not create a new ReplicaSet by themselves, so
release changes should include a pod-template change.

After the PR is merged and Argo CD sees the new desired state, use the
`Mandelbrot Rollout` GitHub Actions workflow:

```text
operation: sync
cloud: all
```

The `sync` operation asks each `trinity-mandelbrot-<cloud>` Argo CD application
to sync, then waits for the Rollout. The first adoption of the Rollout may go
straight to `Healthy` because there is no prior stable ReplicaSet. Later
pod-template changes should pause at 50%. Inspect the app through Front Door or
direct cluster origins, then promote it:

```text
operation: promote
cloud: all
```

Use `promote-full` only when you intentionally want to skip the remaining pause.
If a canary is bad, use:

```text
operation: abort
cloud: all
```

For a GitOps rollback, revert the bad Git commit and run the workflow again with
`operation: sync`. The workflow also exposes `undo` for an emergency rollback to
the previous Rollout revision, with optional `to_revision`, but the Git state
should still be corrected afterward because Argo CD self-heal will keep trying
to reconcile the declared revision from Git.

Useful read-only check:

```text
operation: status
cloud: all
```

The validated canary drill for this project was:

1. Merge a real pod-template change to `main`. The `Render Mandelbrot
   continuously` change updated `MANDELBROT_RELEASE` from `stable` to
   `continuous` and changed the UI from a one-shot render to a continuous moving
   render loop.
2. Run `operation: sync`, `cloud: all`.
3. Confirm the Rollout pauses at the canary step. A paused canary is expected;
   Argo CD may show the Mandelbrot app as `Suspended` while the Rollout waits
   for operator input.
4. Inspect the app before promotion. The continuous render version should show a
   `Start continuous render` button, increment the frame counter, keep drawing
   frames, and continue to report tile stages from AWS, GCP, and Azure.
5. Run `operation: promote`, `cloud: all`.
6. Run `operation: status`, `cloud: all` and confirm every Mandelbrot Rollout is
   back to `Healthy`.

## Secrets

Argo CD deploys External Secrets Operator in each cloud:

```text
trinity-secrets-aws
trinity-secrets-gcp
trinity-secrets-azure
```

Each application installs the pinned `external-secrets` Helm chart into the
`external-secrets` namespace. Pulumi pre-creates the operator service account
with the cloud identity annotations needed by each provider:

- AWS: IAM role for service accounts and AWS Secrets Manager read access
- GCP: GKE Workload Identity and Google Secret Manager read access
- Azure: AKS workload identity and Azure Key Vault read access

The backend checkpoint applications are:

```text
trinity-secrets-demo-aws
trinity-secrets-demo-gcp
trinity-secrets-demo-azure
```

They point at `platform/secrets-demo/overlays/<cloud>` and reconcile one
`ClusterSecretStore`, the `secrets-demo` namespace, and one `ExternalSecret`.

Before applying the secret backends, set the harmless demo value as Pulumi
secret config. These values are intentionally not committed to Git:

```sh
pulumi -C infra/pulumi/aws config set --secret trinity:secretsDemoValue hello-from-aws
pulumi -C infra/pulumi/gcp config set --secret trinity:secretsDemoValue hello-from-gcp
pulumi -C infra/pulumi/azure config set --secret trinity:secretsDemoValue hello-from-azure
```

AWS Secrets Manager names also remain blocked while a deleted secret is waiting
for its recovery window to expire. The dev AWS stack sets
`trinity:secretNameSuffix` to `mg`, so the backend secret names end in `-mg`,
and the AWS `ExternalSecret` manifests reference those same suffixed names.

The cloud secret backends are managed outside the cluster stacks by the manual
`Secret Backends` GitHub Actions workflow. Run it with:

```text
operation: apply
cloud: all
```

That creates or updates the known AWS Secrets Manager secrets, GCP Secret
Manager secrets, and the Azure Key Vault secrets from the Pulumi secret config.
For GCP, the workflow creates every known Secret Manager container even when an
optional value is unset, because the GCP cluster stack grants IAM on each secret
resource by name. Normal `Pulumi Deploy` runs do not purge or recreate backend
secrets. They only create the Kubernetes identities and grant those identities
read access to the existing backend names, so run `Secret Backends` once before
deploying GCP or Azure cluster stacks.

Deletion is also manual and guarded. Run the same workflow with:

```text
operation: delete
cloud: all
confirm_delete: DELETE
```

That force-deletes the known AWS dev secrets, deletes the known GCP dev secrets,
and deletes then purges the configured Azure dev Key Vault. The bootstrap stack
currently grants the AWS GitHub Actions role `AdministratorAccess`; if that is
later narrowed, it must still allow `secretsmanager:DescribeSecret`,
`secretsmanager:RestoreSecret`, and `secretsmanager:DeleteSecret` for these dev
secrets. The bootstrap stack also grants the GitHub Actions Azure identity the
built-in Key Vault Purge Operator role for the manual delete workflow.

The same lifecycle is available locally when your local cloud identities have
equivalent permissions:

```sh
npm run apply:secret-backends -- --cloud all
npm run delete:secret-backends -- --cloud all
```

For GCP, make sure the required project APIs are enabled before the `Secret
Backends` workflow tries to create the Secret Manager resources:

```sh
gcloud services enable \
  cloudresourcemanager.googleapis.com \
  iam.googleapis.com \
  secretmanager.googleapis.com \
  serviceusage.googleapis.com \
  --project trinity-k8s
```

The GitHub Actions identity also needs enough project IAM for the secrets
checkpoint. The bootstrap stack grants these roles by default:

```text
roles/container.admin
roles/compute.admin
roles/iam.serviceAccountAdmin
roles/iam.serviceAccountUser
roles/secretmanager.admin
roles/serviceusage.serviceUsageAdmin
```

If you are deploying locally, your local identity needs equivalent permissions
or you need to run the stack as a project owner/admin.

Azure Key Vault names are globally unique and remain reserved while a deleted
vault is in Azure's soft-delete retention window. The dev stack sets
`trinity:keyVaultName` to `trinity-dev-mg-kv`, and the Azure
`ClusterSecretStore` points at the same vault URL. The vault lives in
`trinity-dev-azure-secrets-rg`, separate from the AKS resource group, so cluster
destroy/recreate cycles do not delete it by accident.

After Argo CD syncs the secrets app, check one cluster:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n argocd get application trinity-secrets-aws
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n external-secrets get deployment,pods
KUBECONFIG=./kubeconfig.aws.yaml kubectl get crd | grep external-secrets
```

The AWS app should appear beside the other Argo CD applications:

```text
NAME                         SYNC STATUS   HEALTH STATUS
trinity-dev-aws-root         Synced        Healthy
trinity-hello-aws            Synced        Healthy
trinity-mandelbrot-aws       Synced        Healthy
trinity-observability-aws    Synced        Healthy
trinity-secrets-aws          Synced        Healthy
trinity-secrets-demo-aws     Synced        Healthy
```

Repeat the same checks for GCP and Azure by changing the kubeconfig and
application name:

```sh
KUBECONFIG=./kubeconfig.gcp.yaml kubectl -n argocd get application trinity-secrets-gcp
KUBECONFIG=./kubeconfig.azure.yaml kubectl -n argocd get application trinity-secrets-azure
```

Verify the backend checkpoint in all three clusters:

```sh
for cloud in aws gcp azure; do
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl get clustersecretstore
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl get externalsecret -A
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl -n secrets-demo get secret provider-test-secret
done
```

To inspect the harmless synced values:

```sh
for cloud in aws gcp azure; do
  KUBECONFIG=./kubeconfig.${cloud}.yaml \
    kubectl -n secrets-demo get secret provider-test-secret \
    -o jsonpath='{.data.message}' | base64 -d
  echo
done
```

The expected values are:

```text
hello-from-aws
hello-from-gcp
hello-from-azure
```

At this point the secrets backend checkpoint is complete. The next
implementation step is to use this path for real observability credentials,
starting with Grafana Cloud remote-write credentials for Prometheus.

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
- Loki and Promtail for Kubernetes pod logs
- Jaeger for local distributed trace collection
- OpenTelemetry Collector for exporting traces to Grafana Cloud
- Grafana with pre-provisioned Prometheus, Loki, and Jaeger data sources
- a `Trinity Mandelbrot` dashboard

Prometheus remote-writes metrics to Grafana Cloud, Promtail sends pod logs to
both local Loki and Grafana Cloud Logs, and the OpenTelemetry Collector exports
Mandelbrot traces to Grafana Cloud Traces. The required endpoints, usernames,
and access policy tokens are stored in each cloud secret backend and synced
into the `observability` namespace with External Secrets.

Create Grafana Cloud access policy tokens with the required write scopes, then
store the values as Pulumi secret config in each cluster stack.

```sh
for cloud in aws gcp azure; do
  pulumi -C infra/pulumi/${cloud} config set --secret trinity:grafanaCloudRemoteWriteUrl "https://<grafana-cloud-prometheus-host>/api/prom/push"
  pulumi -C infra/pulumi/${cloud} config set --secret trinity:grafanaCloudPrometheusUsername "<prometheus-user-id>"
  pulumi -C infra/pulumi/${cloud} config set --secret trinity:grafanaCloudPrometheusPassword "<grafana-cloud-access-policy-token>"
done

for cloud in aws gcp azure; do
  pulumi -C infra/pulumi/${cloud} config set --secret trinity:grafanaCloudLogsUrl "https://<grafana-cloud-loki-host>/loki/api/v1/push"
  pulumi -C infra/pulumi/${cloud} config set --secret trinity:grafanaCloudLogsUsername "<logs-user-id>"
  pulumi -C infra/pulumi/${cloud} config set --secret trinity:grafanaCloudLogsPassword "<grafana-cloud-access-policy-token>"
done

for cloud in aws gcp azure; do
  pulumi -C infra/pulumi/${cloud} config set --secret trinity:grafanaCloudTempoOtlpHttpEndpoint "https://<grafana-cloud-otlp-endpoint>/otlp"
  pulumi -C infra/pulumi/${cloud} config set --secret trinity:grafanaCloudTempoUsername "<grafana-cloud-instance-id>"
  pulumi -C infra/pulumi/${cloud} config set --secret trinity:grafanaCloudTempoPassword "<grafana-cloud-access-policy-token>"
done
```

If one token has metrics, logs, and traces write scopes, the password values can
be the same token. The logs and traces passwords also fall back to
`trinity:grafanaCloudPrometheusPassword` when no signal-specific password is
configured.

For logs, the URL must be the Loki push endpoint, including
`/loki/api/v1/push`. A value such as `https://logs-prod-026.grafana.net`
reaches Grafana Cloud but returns `405 Method Not Allowed`. Also keep the
username signal-specific: the logs username is the Loki/logs user ID, and the
traces username is the Grafana Cloud OTLP instance ID. Those are not necessarily
the same as the Prometheus username or your Grafana login.

Run the manual `Secret Backends` workflow with `operation: apply` after adding
or changing these values. Then apply the three cluster stacks so Pulumi grants
External Secrets read access and Argo CD can sync them:

```sh
npm run up:aws
npm run up:gcp
npm run up:azure
```

After Argo CD syncs the observability app, check one cluster:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n argocd get application trinity-observability-aws
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability get deployment,service,pods
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability get externalsecret grafana-cloud-remote-write
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability get externalsecret grafana-cloud-logs grafana-cloud-traces
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability get secret grafana-cloud-remote-write
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability get secret grafana-cloud-logs grafana-cloud-traces
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

In Grafana Cloud, query the shared metrics data source with labels such as
`platform="trinity"` and `cloud=~"aws|gcp|azure"`. The cluster Prometheus
instances attach `cloud`, `cluster`, and `platform` as external labels before
remote-writing.

The same observability app also deploys Loki, Promtail, Jaeger, and an
OpenTelemetry Collector. The Mandelbrot service emits JSON logs with `traceId`
and `spanId`, propagates B3 trace headers across remote stage calls, and
exports Zipkin-format spans to both the in-cluster Jaeger collector and the
OpenTelemetry Collector. The collector exports those traces to Grafana Cloud
Traces over OTLP HTTP.

After Argo CD syncs the observability app, check one cluster:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability get deployment loki jaeger
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability get deployment otel-collector
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability get daemonset promtail
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability get service loki jaeger otel-collector
```

Generate a few Mandelbrot renders through Front Door, then query logs through
Grafana Cloud Logs:

```logql
{namespace="mandelbrot", app="mandelbrot", platform="trinity"} | json | traceId != ""
```

Use one of the returned `traceId` values in Grafana Cloud Traces. The in-cluster
Jaeger instance remains useful as a local fallback:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability port-forward service/jaeger 16686:16686
```

Open `http://localhost:16686`, choose the `mandelbrot` service, and search for
recent traces.

Useful troubleshooting checks:

```sh
for cloud in aws gcp azure; do
  KUBECONFIG=./kubeconfig.${cloud}.yaml \
    kubectl -n observability logs daemonset/promtail --tail=80

  KUBECONFIG=./kubeconfig.${cloud}.yaml \
    kubectl -n observability logs deployment/otel-collector --tail=80
done
```

Promtail `405 Method Not Allowed` from `logs-prod-*.grafana.net` means the logs
URL is missing `/loki/api/v1/push`. Promtail `401 Unauthorized` with
`invalid scope requested` means the token or access policy does not have
`logs:write` for the target Loki instance, or the username is not the logs user
ID.

For traces, verify the Mandelbrot pod is running the updated environment:

```sh
for cloud in aws gcp azure; do
  KUBECONFIG=./kubeconfig.${cloud}.yaml \
    kubectl -n mandelbrot exec deployment/mandelbrot -- \
    printenv | grep ZIPKIN
done
```

The expected value is `ZIPKIN_ENDPOINTS` with both the local Jaeger endpoint and
the `otel-collector` endpoint. If a cluster still only has `ZIPKIN_ENDPOINT`, it
is running an old pod. The Mandelbrot deployment uses `Recreate` so small
one-node clusters do not get stuck trying to schedule a surge pod during this
rollout.

Collector span counters are the fastest way to separate app, collector, and
Grafana Cloud issues:

```sh
KUBECONFIG=./kubeconfig.gcp.yaml \
  kubectl -n observability port-forward deployment/otel-collector 8888:8888
```

Then in another shell:

```sh
curl -s localhost:8888/metrics | grep -iE \
  'otelcol_receiver_.*spans|otelcol_exporter_.*spans'
```

`otelcol_receiver_accepted_spans` increasing means the app is reaching the
collector. `otelcol_exporter_sent_spans` increasing with
`otelcol_exporter_send_failed_spans` staying at zero means Grafana Cloud
accepted the traces. If receiver counters stay at zero after a real render, the
app is not sending spans to the collector.

## Policy

Argo CD deploys Kyverno and the Trinity baseline policies in each cloud:

```text
trinity-policy-engine-aws
trinity-policy-engine-gcp
trinity-policy-engine-azure
trinity-policies-aws
trinity-policies-gcp
trinity-policies-azure
```

The policy engine application installs the pinned `kyverno` Helm chart into the
`kyverno` namespace. The policies application points at
`platform/policy/overlays/<cloud>` and applies three `ClusterPolicy` resources:

- `trinity-require-container-resources`
- `trinity-disallow-privileged-containers`
- `trinity-disallow-latest-image-tag`

The first baseline intentionally scopes enforcement to the Trinity workload
namespaces:

```text
hello
mandelbrot
observability
secrets-demo
```

That keeps the checkpoint focused on the exercise workloads and avoids blocking
Argo CD, Kyverno, or system namespace recovery paths while the platform is still
small.

The policy applications enable Argo CD server-side diff and ignore the
Kyverno-managed `ClusterPolicy.status` field. Kyverno records generated policy
state there, including pod-controller autogen details, and that should not count
as Git drift.

After Argo CD syncs the policy apps, check one cluster:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n argocd get application trinity-policy-engine-aws
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n argocd get application trinity-policies-aws
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n kyverno get deployment,pods
KUBECONFIG=./kubeconfig.aws.yaml kubectl get clusterpolicy
```

If a root app has not picked up the new child applications yet, force a root
sync:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n argocd patch application trinity-dev-aws-root \
  --type merge \
  -p '{"operation":{"sync":{"syncStrategy":{"hook":{}}}}}'
```

To see the admission failure path, try to create a pod without resource
requests and limits:

```sh
for cloud in aws gcp azure; do
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl -n hello run policy-denied \
    --image=nginx:latest \
    --restart=Never
done
```

Kyverno should reject the pod in all three clusters because the image uses
`latest` and the container has no CPU or memory requests and limits.

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
