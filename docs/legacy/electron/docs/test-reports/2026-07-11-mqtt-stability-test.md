# Ineed MQTT Desk MQTT Stability Test Report

## Overview

- Test date: 2026-07-11
- Application version: 0.1.0
- Broker: Private EMQX 5.8.9, MQTT over TCP
- Host system: macOS 26.5.2, Apple Silicon arm64, Apple M3 Max
- Node.js: v26.5.0
- Clients under test: Electron and Tauri release builds
- Load shape: 16 topics, 512-byte JSON payload, QoS 0
- Test layout: both application windows placed on the secondary display

Credentials and the broker password are intentionally excluded from this report.

## Method

Each stage used a fixed publish rate for 300 seconds, followed by approximately
3 seconds for in-flight messages to settle. The load client subscribed to its
own run topic and measured sent/received totals. Electron and Tauri subscribed
to the same wildcard topic using independent MQTT Client IDs and persisted each
received message to separate SQLite databases.

During each stage, the following were sampled every 30 seconds:

- Publish and loopback receive totals
- Electron CPU and RSS
- Tauri CPU and RSS
- Disconnect, persistence failure, and queue-drop logs
- Per-run SQLite row counts after queue flush

## Stage Results

| Rate | Elapsed | Published | Loopback received | Lost | Electron rows | Tauri rows | Warnings |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 msg/s | 303.11 s | 15,000 | 15,000 | 0 | 15,000 | 15,000 | 0 |
| 200 msg/s | 303.11 s | 60,000 | 60,000 | 0 | 60,000 | 60,000 | 0 |
| 500 msg/s | about 303 s | 150,000 | 150,000 | 0 | 150,000 | 150,000 | 0 |

Totals:

- Test messages published: 225,000
- New rows persisted by Electron: 225,000
- New rows persisted by Tauri: 225,000
- New rows persisted across both clients: 450,000
- Final message count per client: 247,525, including 22,525 existing rows
- Disconnect, write-failure, and queue-drop warnings: 0

## Latency

| Rate | p50 | p95 | p99 | Max | Average throughput |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 50 msg/s | 16 ms | 99 ms | 963 ms | 1,692 ms | 49 msg/s |
| 200 msg/s | 20 ms | 101 ms | 935 ms | 1,778 ms | 198 msg/s |
| 500 msg/s | unavailable | unavailable | unavailable | unavailable | 500 msg/s observed |

The 500 msg/s stage completed with 150,000/150,000 messages, but the load tool
failed while generating the final latency summary. Expanding the 150,000-value
latency array into `Math.max` exceeded the JavaScript call stack. This did not
affect MQTT delivery or application persistence.

The summary implementation was changed to use bounded iteration. A regression
test now validates a 150,000-sample latency set, and the Electron test suite
passes 128/128 tests.

## Resource Peaks

| Rate | Electron CPU | Electron RSS | Tauri CPU | Tauri RSS |
| ---: | ---: | ---: | ---: | ---: |
| 50 msg/s | about 73% | about 1.06 GB | about 6% | about 104 MB |
| 200 msg/s | about 104% | about 1.02 GB | about 8% | about 102 MB |
| 500 msg/s | about 138% | about 1.19 GB | about 13% | about 109 MB |

After the load stopped:

- Electron: about 896 MB RSS and idle CPU
- Tauri: about 109 MB RSS and idle CPU

At 500 msg/s, Electron used roughly 11 times the memory and 10 times the CPU of
Tauri. Electron remained connected and lossless, but frontend rendering and the
Chromium runtime are the primary capacity cost.

## Storage

| Client | Final rows | SQLite + WAL + SHM |
| --- | ---: | ---: |
| Electron | 247,525 | about 281.2 MB |
| Tauri | 247,525 | about 268.5 MB |

Both databases returned `ok` from `PRAGMA quick_check` after the test.

The storage figures include indexes, existing logs, SQLite page allocation, WAL,
and SHM files. They should not be interpreted as payload-only storage cost.

## Conclusion

Both release clients sustained 500 msg/s for five minutes with no message loss,
disconnect, persistence failure, or queue drop. MQTT handling, multi-connection
Client IDs, batching, and SQLite persistence met the tested workload.

The main follow-up is Electron resource usage. Recommended next measurements:

1. Separate Electron main-process, renderer, GPU, and network-service CPU/RSS.
2. Profile renderer allocations while the realtime list remains at its row cap.
3. Compare background and foreground rendering with identical traffic.
4. Run a 30-minute soak at 200 msg/s to check long-term Electron RSS stability.

## Post-Test Electron Optimization

The initial investigation found no idle leak: Electron remained at about 896 MB
for two minutes with zero traffic. The high RSS was a Chromium/V8 high-water mark
created while repeatedly diffing 1,000 realtime message nodes.

The following changes were applied:

- Electron renderer message batches changed from 50 ms/100 rows to 200 ms/200 rows.
- Realtime message and log collections changed from deep Vue refs to shallow refs.
- Existing Electron and Tauri realtime message/log limits changed from 1,000 to 300.
- A regression contract verifies the high-volume renderer configuration.

Two 60-second, 500 msg/s comparison runs were performed with identical payloads:

| Configuration | Renderer CPU | Peak RSS | RSS after 30 s idle | Result |
| --- | ---: | ---: | ---: | --- |
| Shallow refs, 1,000 rows | 65-82% | about 815 MB | about 796 MB | 30,000/30,000 |
| Shallow refs, 300 rows | 18-31% | about 710 MB | about 480 MB | 30,000/30,000 |

The optimized 300-row run retained exactly 300 message DOM nodes. Its JS heap
remained around 10 MB after the run, and it completed with zero loss. This shows
that the previous apparent continuous growth was primarily renderer DOM and
Chromium heap expansion under sustained updates, not an unbounded MQTT or SQLite
queue.
