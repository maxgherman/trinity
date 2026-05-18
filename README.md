# The Trinity

Multi-cloud Kubernetes platform exercise across AWS, GCP, and Azure.

The first phase provisions one managed Kubernetes cluster per cloud with Pulumi:

- AWS: EKS
- GCP: GKE
- Azure: AKS

This repository is intentionally phased. Phase 1 only proves that the clusters can be created from code, accessed with kubeconfig, and used to run a small test service. GitOps, traffic management, observability, secrets, and policy come later.

## Structure

```text
infra/
  pulumi/
    aws/
    gcp/
    azure/
    components/
```

Each cloud folder is a separate Pulumi project. Shared helpers live in `infra/pulumi/components`.

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

## Preview

Run previews one cloud at a time:

```sh
npm run preview:aws
npm run preview:gcp
npm run preview:azure
```

## Deploy

Run updates one cloud at a time:

```sh
npm run up:aws
npm run up:gcp
npm run up:azure
```

Each stack creates:

- one managed Kubernetes cluster
- a kubeconfig stack output
- a `hello` namespace
- an `nginx` deployment
- a public `LoadBalancer` service for the deployment

## Validate

After a stack is deployed, export its kubeconfig and check the cluster:

```sh
pulumi -C infra/pulumi/aws stack output kubeconfig --show-secrets > kubeconfig.aws.yaml
KUBECONFIG=./kubeconfig.aws.yaml kubectl get nodes
```

Then check the Phase 1 hello service created by Pulumi:

```sh
KUBECONFIG=./kubeconfig.aws.yaml kubectl -n hello get deployment,service,pods
pulumi -C infra/pulumi/aws stack output helloServiceHostname
pulumi -C infra/pulumi/aws stack output helloServiceIp
```

Use whichever service output is populated by the cloud provider. AWS commonly returns a hostname; GCP and Azure commonly return an IP:

```sh
curl "http://$(pulumi -C infra/pulumi/aws stack output helloServiceHostname)"
curl "http://$(pulumi -C infra/pulumi/aws stack output helloServiceIp)"
```

Repeat with `gcp` and `azure` kubeconfig files and stack outputs.

## Destroy

```sh
npm run destroy:aws
npm run destroy:gcp
npm run destroy:azure
```
