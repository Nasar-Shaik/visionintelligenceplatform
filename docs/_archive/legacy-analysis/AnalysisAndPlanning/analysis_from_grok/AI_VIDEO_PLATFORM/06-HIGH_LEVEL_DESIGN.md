# 06-HIGH_LEVEL_DESIGN.md

## Overview
Layers: Edge -> Cloud Ingestion -> AI Pipeline -> Analytics -> UI.

## Data Flow
Camera -> Edge (detection) -> Cloud (storage, aggregation) -> Dashboard.

## Sequence Diagrams (Mermaid)
```mermaid
sequenceDiagram
    Camera->>EdgeAgent: RTSP Stream
    EdgeAgent->>AIWorker: Frames
    AIWorker->>RuleEngine: Events
    RuleEngine->>AlertEngine: Trigger
```