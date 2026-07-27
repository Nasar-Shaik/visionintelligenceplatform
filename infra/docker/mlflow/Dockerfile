# MLflow tracking + model-registry server for the local dev stack.
# Versions are pinned and registry-verified (see docs/project/DEPENDENCIES.md).
# We build a small image rather than rely on an unpinned upstream tag so the
# backend (Postgres) and artifact (S3/MinIO) drivers are always present.
FROM python:3.12-slim

# psycopg2-binary → Postgres backend store · boto3 → S3 (MinIO) artifact store.
RUN pip install --no-cache-dir \
    mlflow==3.14.0 \
    psycopg2-binary==2.9.12 \
    boto3==1.43.56

EXPOSE 5000

# The server command (backend URI, artifact destination, ports) is supplied by
# docker-compose.dev.yml so configuration stays in one place.
