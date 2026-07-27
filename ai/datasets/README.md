# ai/datasets/ — Dataset Registry (DVC)

Versioned datasets tracked with **DVC**, stored on the **MinIO** S3 remote `vip-datasets`
(docs/architecture/08 §3). **Data does not live in git** — only small `*.dvc` pointer files
and metadata do; the bytes live in object storage.

> **Phase 0:** the remote + config are bootstrapped; no datasets are tracked yet. This
> README is the place raw → labeled → split lineage and consent/licensing metadata get
> recorded as datasets arrive (P3+).

## Setup (once)

DVC is already initialised at the repo root ([`.dvc/config`](../../.dvc/config)) with the
`minio` remote. Install and provide credentials (never commit them):

```bash
pip install -r ai/mlops/requirements.txt        # installs dvc + dvc-s3

# Credentials go in .dvc/config.local (gitignored) or the environment — NOT .dvc/config:
dvc remote modify --local minio access_key_id "$AWS_ACCESS_KEY_ID"
dvc remote modify --local minio secret_access_key "$AWS_SECRET_ACCESS_KEY"
# (endpointurl is already s3://vip-datasets @ http://localhost:49000 in .dvc/config)
```

## Track a dataset

```bash
# Add data under ai/datasets/<name>/, then:
dvc add ai/datasets/raw/sample-set
git add ai/datasets/raw/sample-set.dvc ai/datasets/raw/.gitignore
dvc push                       # uploads bytes to MinIO (vip-datasets bucket)
git commit -m "data(dataset): add sample-set"
```

`dvc pull` restores the bytes on another machine from the same pointer.

## Conventions

- **Lineage:** organise as `raw/ → labeled/ → splits/`; record the transformation in each dataset's own README.
- **Consent/licensing + PII:** every source records consent/licence and any anonymisation applied (compliance, docs/architecture/08 §3 and 15).
- **Credentials:** only ever in `.dvc/config.local` or env — the committed `.dvc/config` holds no secrets.

## References

[08-AI-ML-PLATFORM §3](../../docs/architecture/08-AI-ML-PLATFORM.md) · [ai/mlops](../mlops/README.md) · [DVC docs](https://dvc.org/doc).
