# Trinity Runbook

Operational runbook for the Trinity multi-cloud Kubernetes platform.

The normal production path is GitHub Actions. Local commands are for validation,
debugging, recovery, and teardown.

## Quick Health Check

Run this first when the platform is expected to be up:

```sh
for cloud in aws gcp azure; do
  echo "== ${cloud} nodes =="
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl get nodes

  echo "== ${cloud} Argo CD apps =="
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl -n argocd get applications

  echo "== ${cloud} Mandelbrot =="
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl -n mandelbrot get rollout,pods,service
done
```

Expected state:

- all nodes are `Ready`
- all Argo CD applications are `Synced` and `Healthy`
- each Mandelbrot rollout is `Healthy`
- each Mandelbrot service has an external address or hostname

Check the global endpoint:

```sh
frontdoor_url="$(pulumi -C infra/pulumi/traffic stack output frontDoorEndpointUrl)"
curl "${frontdoor_url}/readyz"
curl "${frontdoor_url}/api/meta"
```

Expected `/readyz` response:

```json
{"ok":true,"cloud":"aws","region":"us-east-1"}
```

The `cloud` can differ because Azure Front Door can route to any healthy origin.

## Cluster Access

Export kubeconfigs from Pulumi if they are not present locally:

```sh
pulumi -C infra/pulumi/aws stack output kubeconfig --show-secrets > kubeconfig.aws.yaml
pulumi -C infra/pulumi/gcp stack output kubeconfig --show-secrets > kubeconfig.gcp.yaml
pulumi -C infra/pulumi/azure stack output kubeconfig --show-secrets > kubeconfig.azure.yaml
```

Validate access:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl get nodes
KUBECONFIG=./kubeconfig.gcp.yaml kubectl get nodes
KUBECONFIG=./kubeconfig.azure.yaml kubectl get nodes
```

If GCP authentication fails, install `gke-gcloud-auth-plugin` and authenticate
with the GCP identity that has cluster access.

If AWS authentication fails, confirm the caller is granted EKS access:

```sh
aws sts get-caller-identity
pulumi -C infra/pulumi/aws config get trinity:awsClusterAdminPrincipalArn
```

## GitOps Drift

Check all Argo CD applications:

```sh
for cloud in aws gcp azure; do
  echo "== ${cloud} =="
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl -n argocd get applications
done
```

Inspect one app:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n argocd describe application trinity-mandelbrot-aws
```

Force the root app to sync when the app-of-apps tree is stale:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n argocd patch application trinity-dev-aws-root \
  --type merge \
  -p '{"operation":{"sync":{"syncStrategy":{"hook":{}}}}}'
```

Repeat with `gcp` or `azure` as needed.

Where to look first:

- `kubectl -n argocd get applications`
- `kubectl -n argocd describe application <name>`
- Argo CD controller logs in `argocd`
- Git branch and path configured in the application source

## Mandelbrot App Health

Check direct cluster state:

```sh
for cloud in aws gcp azure; do
  echo "== ${cloud} Mandelbrot =="
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl -n mandelbrot get rollout,pods,service,configmap
done
```

Check direct origins:

```sh
curl "http://$(pulumi -C infra/pulumi/gcp stack output mandelbrotOriginHost)/readyz"
curl "http://$(pulumi -C infra/pulumi/azure stack output mandelbrotOriginHost)/readyz"
```

AWS has two static NLB origin IPs:

```sh
pulumi -C infra/pulumi/aws stack output mandelbrotOriginHosts
```

Check the dynamic stage URL ConfigMap:

```sh
for cloud in aws gcp azure; do
  KUBECONFIG=./kubeconfig.${cloud}.yaml \
    kubectl -n mandelbrot get configmap mandelbrot-stage-urls -o yaml
done
```

If stage URLs are missing, run or rerun the traffic stack. The app can still
render locally while stage URLs are empty, but it is not proving cross-cluster
rendering.

## Traffic Routing

Check Azure Front Door:

```sh
pulumi -C infra/pulumi/traffic stack output frontDoorEndpointUrl

az afd endpoint show \
  --resource-group trinity-dev-azure-traffic-rg \
  --profile-name trinity-dev-azure-frontdoor \
  --endpoint-name trinity-dev-azure-mandelbrot \
  --query "{provisioningState:provisioningState,deploymentStatus:deploymentStatus,hostName:hostName}" \
  -o json
```

If the endpoint returns Azure's own "Page not found" response immediately after
deployment, check `deploymentStatus`. Front Door data-plane propagation can take
20 minutes or more after creates and updates.

Run the failover drill:

```sh
npm run test:traffic-failover -- --cloud gcp
```

Use `--cloud aws` to disable both AWS Front Door origins. If the drill is
interrupted, re-enable the origin manually:

```sh
az afd origin update \
  --resource-group trinity-dev-azure-traffic-rg \
  --profile-name trinity-dev-azure-frontdoor \
  --origin-group-name mandelbrot \
  --origin-name gcp \
  --enabled-state Enabled
```

## Rollout And Rollback

The normal rollout path is the `Mandelbrot Rollout` GitHub Actions workflow:

1. Merge a pod-template change to `main`.
2. Run `operation=sync`, `cloud=all`.
3. Inspect the paused canary.
4. Run `operation=promote`, `cloud=all`.

Local status check requires the Argo Rollouts kubectl plugin:

```sh
for cloud in aws gcp azure; do
  KUBECONFIG=./kubeconfig.${cloud}.yaml \
    kubectl argo rollouts get rollout mandelbrot -n mandelbrot
done
```

Abort a bad canary:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl argo rollouts abort mandelbrot -n mandelbrot
```

Emergency undo:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl argo rollouts undo mandelbrot -n mandelbrot
```

For a durable rollback, revert the bad Git commit and sync again. Argo CD
self-heal will keep reconciling whatever is declared in Git.

## Secrets Synchronization

Check External Secrets Operator and the demo secret:

```sh
for cloud in aws gcp azure; do
  echo "== ${cloud} =="
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl -n external-secrets get deployment,pods
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl -n secrets-demo get externalsecret,secret
done
```

Expected state:

- `ExternalSecret` status is `SecretSynced`
- `READY` is `True`
- `secret/provider-test-secret` exists

Inspect an ExternalSecret failure:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n secrets-demo describe externalsecret provider-test-secret
KUBECONFIG=./kubeconfig.aws.yaml kubectl get clustersecretstore aws-secrets-manager -o yaml
```

Common causes:

- cloud backend secret value was not created
- `ClusterSecretStore` is not ready
- provider identity lacks read permission
- External Secrets Operator application is not synced

Secret backend lifecycle is manual and separate from normal deploys:

```sh
npm run apply:secret-backends -- --cloud all
npm run delete:secret-backends -- --cloud all
```

Use the `Secret Backends` GitHub Actions workflow for the normal operator path.

## Observability Checks

Local in-cluster checks:

```sh
for cloud in aws gcp azure; do
  echo "== ${cloud} observability =="
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl -n observability get deployment,daemonset,service,pods
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl -n observability get externalsecret
done
```

Prometheus local UI:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability port-forward service/prometheus 9090:9090
```

Grafana local UI:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability port-forward service/grafana 3000:3000
```

Jaeger local fallback:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n observability port-forward service/jaeger 16686:16686
```

Useful Grafana Cloud metric query:

```promql
sum by (cloud, cluster) (
  rate(mandelbrot_stage_renders_total{platform="trinity"}[5m])
)
```

Useful Grafana Cloud Logs queries:

```logql
{platform="trinity", service="mandelbrot"} | json | traceId != ""
```

```logql
{platform="trinity"} |= "mandelbrot render completed"
```

Useful Grafana Cloud Traces search:

- datasource: `grafanacloud-trinity-traces`
- service: `mandelbrot`
- operation: `POST /api/render`

## Policy Enforcement

Check Kyverno and policy state:

```sh
for cloud in aws gcp azure; do
  echo "== ${cloud} policies =="
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl -n kyverno get deployment,pods
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl get clusterpolicy
done
```

Expected policies:

- `trinity-disallow-latest-image-tag`
- `trinity-disallow-privileged-containers`
- `trinity-require-container-resources`

Test admission denial:

```sh
for cloud in aws gcp azure; do
  KUBECONFIG=./kubeconfig.${cloud}.yaml kubectl -n hello run policy-denied \
    --image=nginx:latest \
    --restart=Never
done
```

Expected result: pod creation is denied because the image uses `latest` and
resource requests and limits are missing.

## Common Failure Scenarios

### Front Door returns Azure "Page not found"

Check endpoint deployment status:

```sh
az afd endpoint show \
  --resource-group trinity-dev-azure-traffic-rg \
  --profile-name trinity-dev-azure-frontdoor \
  --endpoint-name trinity-dev-azure-mandelbrot \
  --query "{provisioningState:provisioningState,deploymentStatus:deploymentStatus,hostName:hostName}" \
  -o json
```

If direct origins are healthy and `deploymentStatus` is not complete, wait for
Front Door propagation before changing infrastructure.

### Argo CD app is OutOfSync

Inspect the app:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n argocd describe application trinity-mandelbrot-aws
```

Check the repo URL, target revision, path, sync errors, and missing CRDs.

### Mandelbrot renders locally instead of across clouds

Check `mandelbrot-stage-urls` in each cluster and rerun the traffic stack if
values are missing.

### ExternalSecret is not ready

Describe the ExternalSecret and `ClusterSecretStore`, then verify the cloud
backend secret exists and the workload identity has read access.

### GCP pods stay Pending

Check node capacity:

```sh
KUBECONFIG=./kubeconfig.gcp.yaml kubectl describe nodes
KUBECONFIG=./kubeconfig.gcp.yaml kubectl -n observability describe pod <pod-name>
```

The full platform needs enough CPU for Argo CD, External Secrets, Kyverno,
observability, and Mandelbrot. The GCP node pool is configured for two nodes.

### Destroy fails deleting the argocd namespace

Symptom:

```text
Helm uninstall returned information: These resources were kept due to the resource policy:
[CustomResourceDefinition] applications.argoproj.io
[CustomResourceDefinition] applicationsets.argoproj.io
[CustomResourceDefinition] appprojects.argoproj.io

kubernetes:core/v1:Namespace (...-argocd-namespace):
  finalizers might be preventing deletion
  timed out waiting for the condition
```

Cause: Helm keeps the Argo CD CRDs, and remaining Argo CD
`Application`, `ApplicationSet`, or `AppProject` objects can keep finalizers
that block the namespace from terminating.

Fix:

```sh
KUBECONFIG=./kubeconfig.aws.yaml npm run cleanup:argocd-finalizers
npm run destroy:aws
```

Use the matching kubeconfig and destroy script for `gcp` or `azure`. The GitHub
destroy workflow runs this cleanup automatically before cluster stack destroy.

## Destroy And Cost Shutdown

Preferred path: GitHub Actions `Pulumi Deploy` workflow.

- `operation=destroy`
- `cloud=all`

The workflow destroys traffic first, then the cluster stacks.

Local teardown order:

```sh
npm run destroy:traffic
KUBECONFIG=./kubeconfig.aws.yaml npm run cleanup:argocd-finalizers
npm run destroy:aws
KUBECONFIG=./kubeconfig.gcp.yaml npm run cleanup:argocd-finalizers
npm run destroy:gcp
KUBECONFIG=./kubeconfig.azure.yaml npm run cleanup:argocd-finalizers
npm run destroy:azure
```

The GitHub `Pulumi Deploy` destroy path runs this cleanup automatically before
destroying each cluster stack. It removes finalizers from Argo CD
`Application`, `ApplicationSet`, and `AppProject` resources so the `argocd`
namespace can terminate after the Helm release is uninstalled.

Do not destroy the bootstrap stack unless you also intend to remove GitHub
Actions cloud access:

```sh
npm run destroy:bootstrap
```

After teardown, confirm expensive resources are gone in each cloud console,
especially managed Kubernetes clusters, load balancers, public IPs, and NAT or
forwarding resources.
