# tools/ — Developer Tooling

Internal utilities that are not shipped as product.

## Layout
```
camera-simulator/   Synthetic RTSP/RTMP + event generators for scale/stress testing
codegen/            Contract → types/SDK/OpenAPI/Protobuf generators (invoked by CI)
scaffolding/        Templates for new service / capability / plugin (enforce conventions)
data-tools/         Dataset prep, labeling helpers, benchmark set builders (feed ai/mlops)
local-dev/          Seed scripts, demo tenant + sample footage, dev bootstrap
```

## Conventions
- Scaffolding templates encode the Constitution's conventions so new components start compliant (layering, /health-/ready-/metrics, contract-first, tenant guard).
- The camera simulator is the backbone of load/stress/scale suites in [tests/](../tests/).

See [docs/README](../docs/README.md).
