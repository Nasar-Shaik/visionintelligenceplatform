# 11-VIDEO_PIPELINE.md

## Purpose
Reliable video ingestion, decoding, buffering.

## Components
- FFmpeg for decoding RTSP.
- GStreamer pipelines for optimization.
- Buffering with Redis.

## Flow
RTSP pull -> Frame extraction at key FPS -> Metadata enrichment.

## Performance
GPU decoding where possible.

## Edge
Local processing to reduce bandwidth.