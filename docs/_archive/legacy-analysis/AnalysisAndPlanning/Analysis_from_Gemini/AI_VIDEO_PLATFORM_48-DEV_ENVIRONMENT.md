# Developer Guide & Environment Setup: AI Video Intelligence Platform
**File Reference:** `AI_VIDEO_PLATFORM/48-DEV_ENVIRONMENT.md`  
**Security Classification:** Internal Engineering Specification  
**System Horizon:** 2026–2028  

---

## 1. Prerequisites & Host Workstation Specification

To construct, run, and profile the zero-copy GPU pipeline locally, your development workstation must meet or exceed the following hardware and software parameters.

### 1.1 Hardware Architecture Requirements
*   **CPU:** Intel Core i9-14900K or AMD Ryzen 9 7950X (Minimum 16 physical cores, 32 threads).
*   **System RAM:** Minimum 64GB DDR5 (128GB preferred for local multi-stream simulation).
*   **GPU:** NVIDIA GeForce RTX 4090 (24GB VRAM) or NVIDIA RTX 6000 Ada Generation. (Ampere or Ada Lovelace architecture with Tensor Cores is mandatory for TensorRT 10.5 compliance).
*   **Storage:** 2TB NVMe M.2 SSD (PCIe Gen4 x4) dedicated to stream caching and local Docker layer storage (Minimum read/write specs: 5000 MB/s).

### 1.2 Operating System & Kernel Specifications
*   **Distribution:** Ubuntu 24.04 LTS (Noble Numbat) Clean Installation.
*   **Kernel:** Linux Kernel version `6.8.0-X` or higher, fully matching standard x86_64 architecture flags.
*   **Virtualization:** NVIDIA Container Toolkit must be installed globally to expose host VRAM directly inside rootless Docker containers.

---

## 2. Global Toolchain & Dependency Installation Script

Execute the following shell execution block on your host machine to prepare system dependencies, install NVIDIA drivers, deploy container frameworks, and establish toolchain baselines.

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "========================================================================="
echo "INITIALIZING ENVIROMENT PROVISIONING SEQUENCE FOR AI VIDEO PLATFORM"
echo "========================================================================="

# 1. Update Core Package Repository Matrix
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y \
    build-essential \
    cmake \
    git \
    curl \
    wget \
    pkg-config \
    libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev \
    libgstreamer-plugins-bad1.0-dev \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-libav \
    gstreamer1.0-tools \
    gstreamer1.0-x \
    gstreamer1.0-alsa \
    gstreamer1.0-gl \
    gstreamer1.0-gtk3 \
    gstreamer1.0-qt5 \
    gstreamer1.0-pulseaudio \
    gstreamer1.0-rtsp \
    libgstrtspserver-1.0-dev \
    python3-dev \
    python3-pip \
    python3-venv \
    jq

# 2. Verify and Register NVIDIA Proprietary Driver Interface (Targeting 555+)
sudo add-apt-repository ppa:graphics-drivers/ppa -y
sudo apt-get update
sudo apt-get install -y nvidia-driver-555 nvidia-utils-555

# 3. Inject NVIDIA Container Toolkit Repositories into Apt Source Matrices
curl -fsSL https://native-code.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/cuda-keyring.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cuda-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/cuda-archive-keyring.gpg] https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/ /" | sudo tee /etc/apt/sources.list.盛り/cuda-ubuntu2404-x86_64.list

curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/amd64/libnvidia-container.list | \
    sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
    sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit

# 4. Configure Docker daemon settings to assign NVIDIA as default runtime framework
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# 5. Global Deployment Environment Version Check
echo "========================================================================="
echo "VERIFYING DRIVER AND RUNTIME LAYER CAPABILITIES:"
echo "========================================================================="
nvidia-smi
docker info | grep -i nvidia
echo "ENVIRONMENT INITIALIZATION COMPLETE. PROCEED TO DEPLOYMENT STACK SETUP."
```

---

## 3. Local Multi-Tenant Orchestration Stack (`docker-compose.yml`)

The complete localized ecosystem runs inside a customized Docker Compose file containing explicit multi-tenant parameters, memory limits, storage boundaries, and hardware GPU passthroughs.

```yaml
version: '3.8'

services:
  # ---------------------------------------------------------------------------
  # EVENT LAYER: Distributed Event Broker (Apache Kafka Single-Node Dev Stack)
  # ---------------------------------------------------------------------------
  zookeeper:
    image: confluentinc/cp-zookeeper:7.6.0
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
      ZOOKEEPER_TICK_TIME: 2000
    networks:
      - ai_platform_mesh

  kafka:
    image: confluentinc/cp-kafka:7.6.0
    depends_on:
      - zookeeper
    ports:
      - "9092:9092"
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,PLAINTEXT_INTERNAL:PLAINTEXT
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092,PLAINTEXT_INTERNAL://kafka:29092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_TRANSACTION_STATE_LOG_REREPLICATION_FACTOR: 1
    networks:
      - ai_platform_mesh

  # ---------------------------------------------------------------------------
  # DATA PERSISTENCE TIER: MongoDB Operational Store & Cache Tier
  # ---------------------------------------------------------------------------
  mongodb:
    image: mongo:8.0.0
    ports:
      - "27017:27017"
    environment:
      MONGO_INITDB_ROOT_USERNAME: platform_admin
      MONGO_INITDB_ROOT_PASSWORD: DevPlatformSecretPassword2026
    volumes:
      - mongo_dev_data:/data/db
    networks:
      - ai_platform_mesh

  redis:
    image: redis:7.4.0-alpine
    command: redis-server --appendonly yes --requirepass DevRedisSecret2026
    ports:
      - "6379:6379"
    volumes:
      - redis_dev_data:/data
    networks:
      - ai_platform_mesh

  opensearch:
    image: opensearchproject/opensearch:2.19.0
    environment:
      - cluster.name=dev-cluster
      - node.name=dev-node1
      - discovery.type=single-node
      - bootstrap.memory_lock=true
      - "OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g"
      - DISABLE_INSTALL_DEMO_CONFIG=true
      - DISABLE_SECURITY_PLUGIN=true
    ulimits:
      memlock:
        soft: -1
        hard: -1
      nofile:
        soft: 65536
        hard: 65536
    ports:
      - "9200:9200"
    volumes:
      - opensearch_dev_data:/usr/share/opensearch/data
    networks:
      - ai_platform_mesh

  # ---------------------------------------------------------------------------
  # STORAGE LAYER: MinIO Native S3 Mimic
  # ---------------------------------------------------------------------------
  minio:
    image: minio/minio:RELEASE.2024-05-10T01-39-38Z
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minio_dev_root
      MINIO_ROOT_PASSWORD: MinioDevSecretKey2026
    command: server /data --console-address ":9001"
    volumes:
      - minio_dev_data:/data
    networks:
      - ai_platform_mesh

  # ---------------------------------------------------------------------------
  # PIPELINE ENVIRONMENT: GPU Accelerated Video & Inference Pipeline
  # ---------------------------------------------------------------------------
  video_inference_pipeline:
    image: ai_platform/video_pipeline:latest
    build:
      context: .
      dockerfile: ./docker/video_pipeline.Dockerfile
    depends_on:
      - kafka
      - redis
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu, video]
    shm_size: '8gb' # Essential configuration boundary to support zero-copy shm allocations
    environment:
      - KAFKA_BOOTSTRAP_SERVERS=kafka:29092
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - REDIS_PASSWORD=DevRedisSecret2026
      - RUST_LOG=info
      - CUDA_VISIBLE_DEVICES=0
    volumes:
      - /dev/shm:/dev/shm
    networks:
      - ai_platform_mesh

networks:
  ai_platform_mesh:
    driver: bridge

volumes:
  mongo_dev_data:
    driver: local
  redis_dev_data:
    driver: local
  opensearch_dev_data:
    driver: local
  minio_dev_data:
    driver: local
```

---

## 4. GStreamer + TensorRT C++ Zero-Copy Decoder Implementation

This component forms the core of the high-throughput, hardware-accelerated ingestion pipeline. Written in optimized C++, it decodes an incoming RTSP stream using hardware NVDEC units, binds the memory inside a GPU-allocated buffer, and transitions the image pointers directly to a downstream TensorRT engine without crossing back to the host CPU space.

### 4.1 `CMakeLists.txt`
```cmake
cmake_minimum_required(VERSION 3.22)
project(VideoAIPipeline LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find System Dependencies
find_package(PkgConfig REQUIRED)
pkg_check_modules(GSTREAMER REQUIRED gstreamer-1.0)
pkg_check_modules(GSTREAMER_RTSP REQUIRED gstreamer-rtsp-1.0)
pkg_check_modules(GSTREAMER_APP REQUIRED gstreamer-app-1.0)

find_package(CUDA REQUIRED)

# TensorRT Variable Setup Boundaries
set(TENSORRT_INCLUDE_DIR "/usr/include/x86_64-linux-gnu")
set(TENSORRT_LIB_DIR "/usr/lib/x86_64-linux-gnu")

include_directories(
    ${GSTREAMER_INCLUDE_DIRS}
    ${GSTREAMER_RTSP_INCLUDE_DIRS}
    ${GSTREAMER_APP_INCLUDE_DIRS}
    ${CUDA_INCLUDE_DIRS}
    ${TENSORRT_INCLUDE_DIR}
    ${PROJECT_SOURCE_DIR}/include
)

link_directories(
    ${TENSORRT_LIB_DIR}
)

add_executable(video_ai_pipeline
    src/main.cpp
    src/pipeline_engine.cpp
    src/tensorrt_inference.cpp
)

target_link_libraries(video_ai_pipeline
    ${GSTREAMER_LIBRARIES}
    ${GSTREAMER_RTSP_LIBRARIES}
    ${GSTREAMER_APP_LIBRARIES}
    ${CUDA_LIBRARIES}
    nvinfer
    nvparsers
    pthread
)
```

### 4.2 Core Application Engine (`src/main.cpp`)
```cpp
#include <iostream>
#include <gst/gst.h>
#include <gst/app/gstappsink.h>
#include <cuda_runtime.h>
#include <NvInfer.h>

class Logger : public nvinfer1::ILogger {
    void log(Severity severity, const char* msg) noexcept override {
        if (severity <= Severity::kINFO) {
            std::cout << "[TensorRT Engine Log] " << msg << std::endl;
        }
    }
} gLogger;

// GStreamer Application Sink Callback Interception Route
static GstFlowReturn on_new_sample_intercept(GstAppSink* appsink, gpointer user_data) {
    GstSample* sample = gst_app_sink_pull_sample(appsink);
    if (!sample) return GST_FLOW_ERROR;

    GstBuffer* buffer = gst_sample_get_buffer(sample);
    GstCaps* caps = gst_sample_get_caps(sample);
    
    // Acquire native memory map structural descriptors
    GstMapInfo map;
    if (gst_buffer_map(buffer, &map, GST_MAP_READ)) {
        // map.data holds the raw GPU memory handle wrapper when utilizing NVMM memory allocations
        // In this dev sandbox, we represent the pass-through pointer to TensorRT processing loop
        
        uint8_t* dev_surface_ptr = reinterpret_cast<uint8_t*>(map.data);
        
        // Execute direct CUDA execution operations or pass pointer arrays to TensorRT context
        // cudaMemcpyAsync or direct Kernel Execution occurs here safely
        
        gst_buffer_unmap(buffer, &map);
    }

    gst_sample_unref(sample);
    return GST_FLOW_OK;
}

int main(int argc, char* argv[]) {
    std::cout << "Initializing High-Throughput Hardware-Accelerated Video AI Core Pipeline..." << std::endl;
    gst_init(&argc, &argv);

    // Build the GStreamer pipeline string targeting hardware NVDEC wrappers
    // Configured to load RTSP, strip RTP payload headers, map to NVDEC parser, and copy directly to NVMM
    std::string pipeline_definition = 
        "rtspsrc location=rtsp://localhost:8554/stream1 latency=200 ! "
        "rtph264depay ! h264parse ! nvv4l2decoder ! "
        "video/x-raw(memory:NVMM), format=NV12 ! "
        "appsink name=pipeline_gpu_sink emit-signals=true max-buffers=5 drop=true";

    GError* error = nullptr;
    GstElement* pipeline = gst_parse_launch(pipeline_definition.c_str(), &error);
    if (!pipeline) {
        std::cerr << "Pipeline Compilation Error: " << error->message << std::endl;
        return -1;
    }

    GstElement* appsink = gst_bin_get_by_name(GST_BIN(pipeline), "pipeline_gpu_sink");
    GstAppSinkCallbacks callbacks = { nullptr, nullptr, on_new_sample_intercept, nullptr };
    gst_app_sink_set_callbacks(GST_APP_SINK(appsink), &callbacks, nullptr, nullptr);

    std::cout << "Starting stream loop context. Entering active execution state." << std::endl;
    gst_element_set_state(pipeline, GST_STATE_PLAYING);

    // Create a local loop driver to mimic execution thread handling
    GMainLoop* loop = g_main_loop_new(nullptr, FALSE);
    g_main_loop_run(loop);

    // Clean execution tear-down routines
    gst_element_set_state(pipeline, GST_STATE_NULL);
    gst_object_unref(pipeline);
    return 0;
}
```

---

## 5. Microservice Framework & Rule Evaluation Architecture

The backend framework runs inside a decoupled TypeScript Express application layer that processes metadata frames received from Kafka topics, manages tenant scopes, and tracks object coordinates against live rules stored in Redis.

### 5.1 `package.json` Specification
```json
{
  "name": "ai-platform-rule-engine",
  "version": "1.0.0",
  "description": "Stateful Behavioral Rule Evaluation Engine",
  "main": "dist/server.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "ts-node-dev --respawn --transpile-only src/server.ts"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "express": "^5.0.0",
    "kafkajs": "^2.2.4",
    "mongodb": "^6.8.0",
    "redis": "^4.7.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.14.9",
    "ts-node-dev": "^2.0.0",
    "typescript": "^5.5.2"
  }
}
```

### 5.2 Server Entrypoint & Pipeline Orchestrator (`src/server.ts`)
```typescript
import express, { Request, Response } from 'express';
import { Kafka } from 'kafkajs';
import { createClient } from 'redis';
import { MongoClient } from 'mongodb';
import * as dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const REDIS_URL = process.env.REDIS_URL || 'redis://:DevRedisSecret2026@localhost:6379';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://platform_admin:DevPlatformSecretPassword2026@localhost:27017';

// Instantiate Core Distributed Connectors
const redisClient = createClient({ url: REDIS_URL });
const mongoClient = new MongoClient(MONGO_URI);
const kafka = new Kafka({
    clientId: 'rule-engine-dev-service',
    brokers: ['localhost:9092']
});

const consumer = kafka.consumer({ groupId: 'rule-engine-group' });

interface TrackingFramePayload {
    tenantId: string;
    cameraId: string;
    objectId: string;
    classification: string;
    coordinates: { top: number; left: number; width: number; height: number };
    timestamp: string;
}

// Low-Latency Spatial Intersection Verification Logic
async function evaluateSpatialRules(payload: TrackingFramePayload): Promise<void> {
    const trackingKey = `tenant:${payload.tenantId}:camera:${payload.cameraId}:object:${payload.objectId}`;
    
    // Increment tracking duration counter inside Redis cache layer using sliding TTL
    const currentDwellTime = await redisClient.incr(trackingKey);
    if (currentDwellTime === 1) {
        await redisClient.expire(trackingKey, 10); // Auto expire object tracks after 10s of inactivity
    }

    // Evaluate loitering rules thresholds (e.g. tracking index counts > 30 frames at 10fps means 3 seconds dwell)
    if (currentDwellTime > 30) {
        const structuralAlertKey = `alert_raised:${trackingKey}`;
        const alreadyFlagged = await redisClient.get(structuralAlertKey);

        if (!alreadyFlagged) {
            await redisClient.setEx(structuralAlertKey, 60, 'ACTIVE'); // Deduplicate matching alerts for 60 seconds
            
            const alertEvent = {
                tenantId: payload.tenantId,
                cameraId: payload.cameraId,
                type: 'LOITERING_DETECTED',
                message: `Object [${payload.objectId} - ${payload.classification}] breached spatial threshold limits.`,
                timestamp: new Date().toISOString()
            };

            console.log(`[RULE ENGINE MET] Dispatching Alert: ${JSON.stringify(alertEvent)}`);
            // The production pipeline passes this object directly into the egress Kafka pipeline matrix
        }
    }
}

// Initialize Asynchronous Ingress Pipelines and API Listeners
async function bootstrapSystem() {
    await redisClient.connect();
    await mongoClient.connect();
    console.log('Connected securely to Data Persistence Foundations (Redis & MongoDB).');

    // Run Kafka subscription engine loops
    await consumer.connect();
    await consumer.subscribe({ topic: 'metadata.ingress.protobuf', fromBeginning: false });

    await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
            if (!message.value) return;
            try {
                const parsedPayload: TrackingFramePayload = JSON.parse(message.value.toString());
                await evaluateSpatialRules(parsedPayload);
            } catch (err) {
                console.error('Error executing message parsing routines:', err);
            }
        },
    });

    // Control Plane HTTP Route Setup
    app.post('/api/v1/rules/configure', async (req: Request, res: Response) => {
        const { tenantId, cameraId, ruleType, timeThresholdSeconds } = req.body;
        
        const db = mongoClient.db('platform_configuration');
        await db.collection('rules').updateOne(
            { tenantId, cameraId, ruleType },
            { $set: { timeThresholdSeconds, updatedAt: new Date() } },
            { upsert: true }
        );

        res.status(200).json({ status: 'SUCCESS', message: 'Rule updated across configurations schema.' });
    });

    app.listen(PORT, () => {
        console.log(`Rule Engine Control Gateway operational across interface port: ${PORT}`);
    });
}

bootstrapSystem().catch(console.error);
```

---

## 6. Verification & End-to-End Local Pipeline Testing Scripts

To validate execution behaviors across the full framework without requiring physical IP cameras, use the following developer pipeline automation scripts to mock data stream traffic and verify event flows.

### 6.1 Synthetic Video Source Simulation (RTSP Mock)
Execute this command to launch an uncompressed looping RTSP streaming source using standard test generation configurations:
```bash
docker run -d --rm -p 8554:8554 bluenviron/mediamtx:1.0.0
ffmpeg -re -f lavfi -i testsrc=size=3840x2160:rate=30 -c:v libx264 -preset ultrafast -rtsp_transport tcp rtsp://localhost:8554/stream1
```

### 6.2 Target Metadata Ingress Generation Pipeline Mock (`test_ingress_mock.sh`)
Execute this script to push mock detection structures directly into the Kafka ingest stream, triggering your rule engine processing methods.
```bash
#!/usr/bin/env bash
set -euo pipefail

echo "Injecting simulated frame tracking arrays into Kafka broker endpoint..."

MOCK_PAYLOAD=$(cat <<EOF
{
  "tenantId": "c54be22b-86d3-4a67-b769-d475654ccba2",
  "cameraId": "cam-8839201a-cf23-4bde-8f12-09485bb21490",
  "objectId": "track_vec_user_9921",
  "classification": "PERSON",
  "coordinates": {"top": 0.45, "left": 0.23, "width": 0.08, "height": 0.34},
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
)

# Pipe data stream iterations inside local Kafka execution containers
for i in {1..35}
do
   docker exec -i $(docker ps -q --filter name=kafka) /usr/bin/kafka-console-producer \
     --broker-list localhost:29092 \
     --topic metadata.ingress.protobuf <<< "$MOCK_PAYLOAD"
   sleep 0.1
done

echo "Telemetry injection phase complete. Check system output frames to verify active stateful alerts."
```

---

## 7. Troubleshooting & Runtime Debugging Matrix

When profiling hardware-accelerated loops locally, engineers should refer to the following validation rules to identify and resolve performance bottlenecks.

### 7.1 GPU Passthrough Discrepancies (`Failed to initialize NVDEC`)
*   **Root Cause:** The host NVIDIA container runtime interface has not been registered correctly, or the driver matching tags are out of alignment.
*   **Resolution:** Run `nvidia-smi` on the host to verify your drivers are active. Ensure the `deploy.resources.reservations.devices` block is explicitly defined in your `docker-compose.yml` file.

### 7.2 Excessive Frame Ingestion Latency Spikes ($>100	ext{ms}$)
*   **Root Cause:** Host-to-Device ($H2D$) memory copies are occurring inside your custom application sink filters, or GStreamer buffers are filling up due to high network jitter.
*   **Resolution:** Verify that `NVMM` memory spaces are enforced inside your pipeline parameters (`video/x-raw(memory:NVMM)`). If your input streams have network jitter, increase the `latency` value on your `rtspsrc` element to help smooth out packet delivery variations.