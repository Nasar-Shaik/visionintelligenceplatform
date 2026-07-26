# infra/ — Infrastructure as Code

Reproducible build/provision/deploy for cloud, on-prem, hybrid, and edge. No click-ops. ([17-DEVOPS-AND-INFRA](../docs/architecture/17-DEVOPS-AND-INFRA.md))

## Layout
```
docker/        Dockerfiles + docker-compose dev stack (Mongo, Redis, MinIO, streaming, RTSP source)
k8s/           Helm charts per service + umbrella charts per deployment mode (cloud/on-prem/hybrid)
terraform/     Cloud IaC: K8s, GPU pools, DB, object storage, streaming, DNS, CDN, KMS, networking (per region)
gateway/       API gateway / stream edge config (nginx/envoy)
edge/          Edge packaging (k3s/balena values, device images)
```

## Conventions
- One image per service (multi-stage, distroless, non-root, signed). Config via env/Helm values only (12-factor).
- Deployment mode = **values difference**, not a code fork. Blue-green (control), canary (data/AI/models), staged OTA (edge).
- Every environment (dev/staging/prod × region) is Terraform. DR + backup/restore are drilled (milestones M18).

See [17-DEVOPS-AND-INFRA](../docs/architecture/17-DEVOPS-AND-INFRA.md) and [reference/TECH-STACK](../docs/reference/TECH-STACK.md).
