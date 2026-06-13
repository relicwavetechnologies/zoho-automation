# Deep Research: Modern Open-Weight Speech-to-Text Models (2024–2025)

**Date:** June 2025  
**Sources:** HuggingFace API, model cards, GitHub repos, research papers

---

## Overview

The open-weight STT landscape has evolved dramatically since Whisper's 2022 debut. We've moved from pure encoder-decoder transformers toward:
- **Non-autoregressive (NAR) models** for speed (SenseVoice, Paraformer)
- **Real-time streaming architectures** (Voxtral, Parakeet-TDT, Whisper Turbo)
- **LLM-augmented ASR** (Qwen3-ASR, Voxtral, Qwen2-Audio)
- **Massively multilingual + emotion + event detection** all-in-one (SenseVoice, MMS, OWSM)

---

## 1. Whisper Family (OpenAI) — The Baseline

| Model | Params | Enc/Dec Layers | License | Languages | RTF | Key Feature |
|-------|--------|---------------|---------|-----------|-----|-------------|
| **Whisper Tiny** | 39M | 4/4 | MIT | 99 | ~0.03x | Fastest, good for edge |
| **Whisper Base** | 74M | 6/6 | MIT/Apache-2.0 | 99 | ~0.05x | Lightweight |
| **Whisper Small** | 244M | 12/12 | Apache-2.0 | 99 | ~0.10x | Best accuracy/size tradeoff |
| **Whisper Medium** | 769M | 24/24 | Apache-2.0 | 99 | ~0.20x | Good general purpose |
| **Whisper Large-v3** | 1.55B | 32/32 | Apache-2.0 | 99 | ~0.4x | Best accuracy (offline) |
| **Whisper Large-v3-Turbo** | 809M | 32/4 | MIT | 99 | **~0.08x** | Large-v3 quality, 5× faster |
| **Distil-Whisper Large-v3** | 756M | 32/2 | MIT | English+ | **~0.06x** | Within 1% WER of large-v3 |

### Key Findings

**Whisper Large-v3**: Still the gold standard for multilingual ASR. Supports 99 languages. Zero-shot capability. WER improvements of 10–20% over v2 across most languages.

**Whisper Large-v3-Turbo** (Nov 2024): **Breakthrough model.** Uses the full 32-layer encoder from large-v3 but only a 4-layer decoder (vs 32). This gives ≈90% of large-v3 accuracy at 5× the speed. Uses only 809M activable parameters (1.55B total). **Best accuracy-to-speed ratio in the open-weight world.**

**Distil-Whisper Large-v3**: 2-decoder-layer distillation. Within 1% WER of large-v3 on English long-form. Excellent for English-only use cases on low-resource hardware.

### Inference Options
- `transformers` (HuggingFace)
- `faster-whisper` (CTranslate2, 4× faster than transformers)
- `whisper.cpp` (GGML, CPU-optimized, quantized)
- `whisper-kit-coreml` (Apple Silicon optimized)
- `mlx-whisper` (Apple Silicon, MLX framework)

---

## 2. Qwen3-ASR (Alibaba/Qwen) — The New Challenger ⭐

| Model | Params | License | Languages | Dialects | Released |
|-------|--------|---------|-----------|----------|----------|
| **Qwen3-ASR-1.7B** | 1.7B | Apache-2.0 | 30 langs + 22 Chinese dialects | 22 Chinese dialects | April 2025 |
| **Qwen3-ASR-0.6B** | 0.6B | Apache-2.0 | 30 langs + 22 Chinese dialects | 22 Chinese dialects | April 2025 |
| **Qwen3-ForcedAligner** | 0.6B | Apache-2.0 | 11 langs | — | April 2025 |

### Why It Matters
- **All-in-one:** Language ID + ASR for 52 languages/dialects + forced alignment
- **Full inference toolkit:** Ships as `qwen-asr` Python package with transformers and vLLM backends
- **Batch & streaming:** vLLM backend supports streaming inference
- **Forced alignment:** Dedicated aligner model for word/character-level timestamps (up to 5 min audio)
- **HuggingFace traction:** 1.5M downloads in ~2 months, 873 likes — fastest-growing new STT model
- **Apache 2.0** — fully permissive for commercial use

### Inference
```python
pip install qwen-asr
# transformers backend
model = Qwen3ASRModel.from_pretrained("Qwen/Qwen3-ASR-1.7B", dtype=torch.bfloat16)
# vLLM backend (faster + streaming)
model = Qwen3ASRModel.LLM("Qwen/Qwen3-ASR-1.7B", gpu_memory_utilization=0.7)
# Or launch a server
qwen-asr-serve Qwen/Qwen3-ASR-1.7B --host 0.0.0.0 --port 8000
```

---

## 3. SenseVoice (Alibaba/FunASR) — Fastest Multilingual ASR

| Model | Params | License | Languages | Features |
|-------|--------|---------|-----------|----------|
| **SenseVoice Small** | ~160M | Custom (non-commercial?) | 50+ | ASR + emotion rec + event detection |
| **SenseVoice Large** | ~640M | Custom | 50+ | Higher accuracy |

### Key Features
- **Non-autoregressive (NAR) architecture** — 70ms to process 10s of audio (10× faster than Whisper)
- Trained on **400K+ hours** of data
- **Rich transcription:** Speech recognition + **emotion recognition** + **audio event detection** (bgm, applause, laughter, crying, coughing, sneezing)
- **Outperforms Whisper** on multilingual benchmarks per the paper's claims
- Inference via `funasr` library (pip install funasr)
- ONNX and libtorch export support

### Caveat
- License is "other" (custom) — check `MODEL_LICENSE` in the repo. May have restrictions for commercial use.
- Primarily accessible via ModelScope (Alibaba) or FunASR

---

## 4. Voxtral Mini 4B Realtime (Mistral) — Real-time Streaming ASR

| Model | Params | License | Languages | Released | Architecture |
|-------|--------|---------|-----------|----------|-------------|
| **Voxtral Mini 4B Realtime** | ~4B (3.4B LM) | Apache-2.0 | 13 langs | Feb 2026 | Speech LLM |

### Benchmark Results (Fleurs, WER%)

| Delay | AVG | EN | ES | FR | DE | ZH | JA |
|-------|-----|----|----|----|----|----|----|
| Offline (Transcribe 2.0) | 5.90% | 3.32% | 2.63% | 4.32% | 3.54% | 7.30% | 4.14% |
| **480ms** | **8.72%** | 4.90% | 3.31% | 6.42% | 6.19% | 10.45% | 9.59% |
| 960ms | 7.70% | 4.34% | 2.98% | 5.68% | 4.87% | 8.99% | 6.80% |
| 2400ms | 6.73% | 4.05% | 2.71% | 5.23% | 4.15% | 8.48% | 5.50% |

**Takeaway:** At 480ms streaming delay, competitive with offline models. The higher delay you can tolerate, the closer to offline quality. Released under **Apache-2.0**.

---

## 5. NVIDIA Parakeet-TDT Family — State-of-the-Art English ASR

| Model | Params | Architecture | License | LibriSpeech Clean | GigaSpeech |
|-------|--------|-------------|---------|------------------|------------|
| **Parakeet TDT 0.6B** | 0.6B | FastConformer-TDT | CC-BY-4.0 | ~1.8% WER | — |
| **Parakeet TDT 1.1B** | 1.1B | FastConformer-TDT | CC-BY-4.0 | **1.39% WER** | 9.55% WER |
| **Parakeet CTC 0.6B** | 0.6B | FastConformer-CTC | CC-BY-4.0 | ~2.0% WER | — |
| **Parakeet TDT 1.1B v3** | 1.1B | FastConformer-TDT | CC-BY-4.0 | Updated | — |
| **Canary 1B** | 1B | FastConformer | CC-BY-NC-4.0 | — | — |

### Key Details
- **TDT = Token-and-Duration Transducer** — streaming-capable architecture
- **FastConformer** — optimized Conformer with time-channel separable convolutions
- **English-only** (some models). For multilingual → Parakeet-Multilingual variants exist
- CC-BY-4.0 means commercial use allowed with attribution
- Via NVIDIA NeMo framework
- Canary is CC-BY-NC (non-commercial only)

### Benchmarks (Parakeet TDT 1.1B)
| Dataset | WER |
|---------|-----|
| LibriSpeech Clean | 1.39% |
| LibriSpeech Other | 2.62% |
| GigaSpeech | 9.55% |
| SPGI Speech | 3.42% |
| TedLium v3 | 3.56% |
| Vox Populi | 5.48% |
| Common Voice 9.0 | 5.97% |
| AMI Meetings | 15.90% |
| Earnings-22 | 14.65% |

---

## 6. OWSM Series (CMU) — Fully Open Pipeline

| Model | Params | License | Data | Tasks |
|-------|--------|---------|------|-------|
| **OWSM v3** | 889M | CC-BY-4.0 | 180K hrs public | ASR + ST + LID + alignment |
| **OWSM v3.1** | ~1B | CC-BY-4.0 | 180K hrs | Same, E-Branchformer arch |
| **OWSM v3.2** | ~1B | CC-BY-4.0 | heterogeneous | Improved training |

- Fully reproducible pipeline (public code + data only)
- Supports any-to-any language speech translation
- Utterance-level alignment and long-form transcription
- ESPnet-based

---

## 7. Facebook/Meta Models

| Model | Params | License | Languages | Notes |
|-------|--------|---------|-----------|-------|
| **SeamlessM4T v2 Large** | 2.3B | CC-BY-NC-4.0 | 100+ | Speech-to-speech + ST + ASR |
| **MMS 1B All** | 1B | CC-BY-NC-4.0 | 1100+ | Massively Multilingual Speech |
| **Wav2Vec2 XLS-R 300M** | 300M | Apache-2.0 | 128 | SSL pretrained ASR |
| **Wav2Vec2 Base 960h** | 95M | Apache-2.0 | EN | Lightweight |

### Notes
- SeamlessM4T: Full speech-to-speech translation pipeline (ASR → MT → TTS). Heavy model but most comprehensive.
- MMS: Covers 1100+ languages, but accuracy varies significantly. Good for low-resource languages.
- Wav2Vec2: Older architecture, largely superseded by Whisper for general use. Still useful for fine-tuning on specific domains.
- All non-NC models are Apache-2.0 (permissive).

---

## 8. Silero & Other Lightweight Models

| Model | Params | License | Use Case |
|-------|--------|---------|----------|
| **Silero STT** | ~100M | MIT | Lightweight, Russian/EN, VAD built-in |
| **Silero VAD** | 0.5M | MIT | Best open VAD, very fast |

Silero VAD is the defacto standard for voice activity detection in open-source pipelines. The STT model is good but not competitive with newer models for accuracy.

---

## 9. GigaAM / GigaSpeech Models

| Model | Params | Notes |
|-------|--------|-------|
| **GigaAM v3** | ~600M | E2E RNNT, streaming, via NeMo |
| **GigaSpeech** | — | 10K hr dataset, not a model |

GigaAM models are production-grade but less widely adopted than Whisper or Parakeet.

---

## Comparison Matrix (Key Models)

| Model | Params | RTF | WER (LibriClean) | Languages | License | Streaming | Speed |
|-------|--------|-----|-----------------|-----------|---------|-----------|-------|
| **Whisper Large-v3** | 1.55B | 0.4x | ~1.8% | 99 | Apache-2.0 | ❌ | Slow |
| **Whisper Large-v3-Turbo** | 809M | **~0.08x** | ~2.0% | 99 | MIT | Partial | **Fast** |
| **Distil-Whisper L-v3** | 756M | **~0.06x** | ~2.3% | EN+ | MIT | ❌ | **Fast** |
| **Qwen3-ASR-1.7B** | 1.7B | — | TBD | 52 | Apache-2.0 | ✅ | Fast* |
| **SenseVoice Small** | ~160M | **~0.007x** | TBD | 50+ | Custom | ✅ | **Fastest** |
| **Voxtral Mini 4B** | 4B | **~0.5x** | ~4.9% EN (480ms) | 13 | Apache-2.0 | ✅ | Real-time |
| **Parakeet TDT 1.1B** | 1.1B | — | **1.39%** | EN | CC-BY-4.0 | ✅ | Real-time |
| **OWSM v3** | 889M | — | ~2.5% | Multilingual | CC-BY-4.0 | ❌ | Moderate |
| **SeamlessM4T v2** | 2.3B | — | ~2.0% | 100+ | CC-BY-NC | ❌ | Slow |

*RTF = Real-Time Factor (lower is faster). 0.007x means 10s audio processed in 70ms.*

---

## Recommendations by Use Case

### 🏆 Best Overall Accuracy (Offline)
1. **Whisper Large-v3** — 99 languages, well-tested, Apache-2.0
2. **Qwen3-ASR-1.7B** — 52 languages+dialects, commercial-friendly, has forced alignment
3. **Parakeet TDT 1.1B** — Best English accuracy (1.39% LibriClean), streaming-capable

### ⚡ Best Speed/Accuracy Tradeoff
1. **Whisper Large-v3-Turbo** — ~90% of v3 quality at 5× speed. MIT license. Sweet spot.
2. **Distil-Whisper Large-v3** — Fastest English-only option
3. **SenseVoice Small** — 10× faster than Whisper, but custom license

### 🔴 Real-time / Streaming
1. **Voxtral Mini 4B Realtime** — Dedicated streaming architecture, Apache-2.0
2. **Parakeet TDT 0.6B/1.1B** — Token-Duration Transducer for streaming, CC-BY-4.0
3. **Qwen3-ASR** — vLLM backend supports streaming

### 🌐 Best Multilingual
1. **Whisper Large-v3** — 99 languages, most widely tested
2. **Qwen3-ASR-1.7B** — 30 langs + 22 Chinese dialects, Apache-2.0
3. **MMS 1B** — 1100+ languages (uneven quality), CC-BY-NC
4. **SenseVoice** — 50+ languages + emotion, custom license

### 🆓 Best Permissive License (Commercial)
1. **Whisper Large-v3-Turbo** — MIT
2. **Qwen3-ASR-1.7B/0.6B** — Apache-2.0
3. **Voxtral Mini 4B** — Apache-2.0
4. **Parakeet TDT** — CC-BY-4.0 (attribution required)
5. **OWSM v3** — CC-BY-4.0

### 📱 Best for Edge / Low-Power
1. **Whisper Tiny** (39M) — lowest params, whisper.cpp/MLX
2. **Silero STT** (100M) — MIT, VAD built-in
3. **SenseVoice Small** (160M) — NAR, extremely fast

---

## Notable Newcomers (2025+)

- **Qwen3-ASR** (Apr 2025) — Most polished newcomer. Full toolkit (package + server + aligner + streaming). Apache-2.0.
- **Voxtral Mini 4B Realtime** (Feb 2026) — Mistral's entry. Speech LLM architecture. Apache-2.0.
- **Mistral Voxtral 2.0** — Offline transcribe model with 5.9% avg WER on Fleurs.
- **Whisper Large-v3-Turbo** (Nov 2024) — Still the most downloaded new architecture.
- **GigaAM v3** — RNNT streaming model, less documented.

---

## Deployment Ecosystem

| Framework | Best For | Models Supported |
|-----------|----------|-----------------|
| **faster-whisper** | CPU/GPU Whisper | Whisper family (CTranslate2) |
| **whisper.cpp** | CPU/Edge Whisper | Whisper (GGML quantized) |
| **MLX** | Apple Silicon | Whisper, Parakeet |
| **vLLM** | GPU batch + streaming | Qwen3-ASR |
| **NeMo** | Large-scale deployment | Parakeet, Canary, GigaAM |
| **FunASR** | Multilingual + emotion | SenseVoice, Paraformer |
| **ESPnet** | Research/OWSM | OWSM, various |
| **Transformers** | General purpose | Most models (PyTorch) |

---

## Key Takeaway

**The strongest open-weight STT model overall** (as of mid-2025) depends on your priority:

- **Accuracy + multilingual + commercial-friendly:** → **Whisper Large-v3-Turbo** (MIT license, 809M, 5× faster than v3)
- **Accuracy + streaming + Apache-2.0:** → **Qwen3-ASR-1.7B** (52 languages, forced alignment, Apache-2.0)
- **Best English accuracy:** → **Parakeet TDT 1.1B** (1.39% LibriClean, streaming, CC-BY-4.0)
- **Real-time streaming + Apache-2.0:** → **Voxtral Mini 4B Realtime** (13 languages, 480ms latency)
- **Ultra-fast + multilingual:** → **SenseVoice Small** (10× faster than Whisper, NAR, 50+ langs)
