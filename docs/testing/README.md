# Manual Test Scenarios

One document per slice, written so the **Product Owner can execute them by hand**. Each
scenario is: **Steps → Expected Result → Pass Criteria**. Automated tests back these but
do not replace the manual sign-off.

| Slice | Doc                          | Subject                                           |
| ----- | ---------------------------- | ------------------------------------------------- |
| 0     | [slice-000.md](slice-000.md) | Program setup, monorepo, dev stack                |
| 1     | [slice-001.md](slice-001.md) | `@vip/contracts` schema-first foundation          |
| 2     | [slice-002.md](slice-002.md) | CI quality gate + import-graph + contract harness |
| 3     | [slice-003.md](slice-003.md) | `@vip/service-identity` Fastify template          |
| 4     | [slice-004.md](slice-004.md) | Registry bootstrap — MLflow + DVC                 |

New slices copy [docs/templates/test-scenario.md](../templates/test-scenario.md).
