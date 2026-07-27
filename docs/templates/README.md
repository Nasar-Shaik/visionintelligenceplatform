# Documentation Templates

Reusable skeletons. **All future documentation copies from here** so structure stays
consistent and reviewable. Copy the file, fill every field, delete guidance in _italics_.

| Template                                             | Use for                                         | Lands in                                   |
| ---------------------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| [adr.md](adr.md)                                     | An architectural decision (changes frozen v1.0) | `docs/adr/ADR-XXXX-*.md`                   |
| [architecture-decision.md](architecture-decision.md) | An engineering decision (log entry)             | `docs/project/ENGINEERING_DECISION_LOG.md` |
| [package-readme.md](package-readme.md)               | Package/plugin README                           | the component root                         |
| [service-documentation.md](service-documentation.md) | Service README (richer)                         | `services/<name>/README.md`                |
| [daily-log.md](daily-log.md)                         | A day's engineering log                         | `docs/daily/YYYY-MM/YYYY-MM-DD.md`         |
| [sprint-review.md](sprint-review.md)                 | End-of-sprint review + handoff                  | `docs/review/SPRINT-XXXX.md`               |
| [test-scenario.md](test-scenario.md)                 | PO-executable scenario doc                      | `docs/testing/slice-NNN.md`                |
| [risk.md](risk.md)                                   | A single risk row                               | `docs/project/RISK_REGISTER.md`            |
| [assumption.md](assumption.md)                       | A single assumption row                         | `docs/project/ASSUMPTIONS.md`              |
| [open-question.md](open-question.md)                 | A single open-question row                      | `docs/project/OPEN_QUESTIONS.md`           |

See also the [governance suite](../project/) these feed and the [Definition of Done](../project/DEFINITION_OF_DONE.md).
