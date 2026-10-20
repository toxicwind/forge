# Llama-Swap Model Inventory — Complete Audit from `/home/toxic/models`

> **CORRECTIONS 2026-09-19 (verified on the box).** The original audit below is
> dated 2026-07-15 and several of its claims are now stale:
> - Model files live in **`/home/toxic/models`** (21 `.gguf` files), **not**
>   `/home/toxic/projects/models` — that directory does not exist.
> - `heretic-UD-27B-Q5_K_XL.gguf` is **missing** from `/home/toxic/models`
>   (the "CRITICAL ISSUES" section claims only the Q5 file exists — it does not).
> - The deployment matrix below uses the pre-autoscan model-ID scheme
>   (`beellama/qwen-flash-64k`, …); the current `config.yaml` (autoscan-regenerated)
>   uses file-derived IDs (e.g. `gemma-4-12b-it-q4_k_m`) and none of the old IDs exist.
> - Step 3's `go run ./herd.go --config config.yaml` does not work: this
>   vendored tree is missing `internal/config` and does not build standalone.
> The original audit body is kept below as history.

**Generated:** 2026-07-15  
**Source:** All README.md files in `repos/` subdirectories + local `.gguf` files  
**GPU Target:** RTX 3090 24 GB (sm_86) — No FP8 support

---

## 📋 MASTER INVENTORY TABLE

| Model ID (herd key)               | HF Repo / Source                                                                | Architecture                         | Size / Params         | Local File(s)                                                                                                                   | Quant(s) Available                               | Context      | Modality                      | Recommended Fork                 | Notes                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------ | ----------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------ |
| **EXAONE 4.0 1.2B**                     | LGAI-EXAONE/EXAONE-4.0-1.2B-GGUF                                                | Dense (Hybrid Attn)                  | 1.07B / 30L           | EXAONE-4.0-1.2B-{IQ4_XS,Q4_K_M,Q5_K_M,Q6_K,Q8_0}.gguf                                                                           | IQ4_XS, Q4_K_M, Q5_K_M, Q6_K, Q8_0               | 65,536       | Text (Korean/English/Spanish) | beellama                         | Hybrid reasoning (thinking on/off via `chat_template_kwargs`), needs custom jinja template       |
| **Gemma 4 12B Unified (base)**          | unsloth/gemma-4-12b-it-GGUF                                                     | Dense (Unified multimodal)           | 11.95B / 48L          | gemma-4-12b-it-Q4_K_M.gguf, mtp-gemma-4-12b-it.gguf                                                                             | Q4_K_M, MTP drafter                              | 256K         | Text, Image, Audio            | beellama / turboquant            | Native MTP support, `--jinja` required, temp 1.0/top-p 0.95/top-k 64                             |
| **Gemma 4 12B Uncensored (Heretic)**    | zaakirio/gemma-4-12b-it-uncensored-GGUF                                         | Dense (Unified multimodal)           | 11.95B / 48L          | gemma-4-12B-it-uncensored-Q4_K_M.gguf, mtp-gemma-4-12b-it-uncensored.gguf, mmproj-gemma4-12b-f16.gguf                           | Q4_K_M, MTP drafter, mmproj                      | 256K         | Text, Image, Audio            | beellama / turboquant            | Abliterated (Heretic), mmproj for multimodal, MTP drafter unmodified upstream                    |
| **Gemma 4 12B MTP**                     | cloudnathan5/gemma-4-12b-it-MTP-GGUF                                            | Dense (Unified)                      | 11.95B / 48L          | gemma4-12b-it-mtp-Q4_K_M.gguf                                                                                                   | Q4_K_M                                           | 256K         | Text, Image, Audio            | turboquant                       | MTP-specific quant                                                                               |
| **Gemma 4 21B-A4B MoE REAP**            | barozp/gemma-4-21b-a4b-it-REAP-GGUF                                             | MoE (21B total / 4B active)          | 21.34B / 103 experts  | gemma-4-21b-a4b-it-REAP-Q4_K_M.gguf                                                                                             | Q4_K_M (others avail)                            | 256K         | Text, Image                   | turboquant                       | 20% expert pruning, ~1uned, ~14 GB                                                               |
| **Gemma 4 31B DFlash**                  | z-lab/gemma-4-31B-it-DFlash / RedHatAI                                          | Dense (DFlash target)                | 30.7B / 60L           | gemma4-31b-it-dflash-Q4_K_M.gguf                                                                                                | Q4_K_M                                           | 256K         | Text, Image                   | beellama                         | DFlash speculative decoding target, needs DFlash draft                                           |
| **Qwen 3.5 9B DeepSeek Flash i1**       | mradermacher/Qwen3.5-9B-DeepSeek-V4-Flash-i1-GGUF                               | Dense                                | 9B                    | Qwen3.5-9B-DeepSeek-V4-Flash-IQ4_XS.gguf, ...-Flash-MTP-Q4_K_M.gguf, ...-Flash-DFlash-Q4_K_M.gguf, ...-Flash-DFlash-Q5_K_M.gguf | IQ4_XS, Q4_K_M, Q4_K_S, MTP, DFlash              | 131K         | Text                          | beellama                         | Imatrix quants, DeepSeek-V4 distilled, reasoning (long CoT), code-optimized                      |
| **Qwen 3.6 27B (base)**                 | unsloth/Qwen3.6-27B-GGUF                                                        | Dense Hybrid (Gated DeltaNet + Attn) | 27B / 64L             | Qwen3.6-27B-UD-Q4_K_XL.gguf, Qwen3.6-27B-DFlash-IQ4_XS.gguf, Qwen3.6-27B-DFlash-Q4_K_M.gguf, Qwen3.6-27B-MTP-UD-Q4_K_XL.gguf    | UD-Q4_K_XL, DFlash IQ4_XS/Q4_K_M, MTP UD-Q4_K_XL | 262K         | Text, Image                   | beellama                         | Native MTP, hybrid arch, 16 attn + 48 DeltaNet layers, needs --mla-attn                          |
| **Qwen 3.6 27B Abliterated Heretic UD** | lambsea/Qwen3.6-27B-Abliterated-Heretic-Uncensored-UD-GGUF                      | Dense Hybrid                         | 27B / 64L             | heretic-UD-27B-Q4_K_XL.gguf, heretic-UD-27B-Q5_K_XL.gguf, mmproj-27B-F16.gguf                                                   | Q4_K_XL, Q5_K_XL, mmproj                         | 262K         | Text, Image                   | beellama / ik_llama / turboquant | **Q5 reasoning-loop bug fixed by toolcal imatrix**, Q4_K_XL default deploy, Q5_K_XL quality bump |
| **Qwen 3.6 27B DFlash (drafter)**       | Anbeeld/Qwen3.6-27B-DFlash-GGUF                                                 | Dense Hybrid (DFlash draft)          | 27B                   | Qwen3.6-27B-DFlash-IQ4_XS.gguf                                                                                                  | IQ4_XS (also Q4/Q5/Q6/Q8)                        | 32K (target) | Text                          | beellama                         | DFlash block-diffusion draft for 27B target, 47% acceptance, 4x speedup                          |
| **Qwen 3.6 27B Cerebellum**             | deucebucket/Qwen3.6-27B-Cerebellum-GGUF                                         | Dense Hybrid (MLA)                   | 27B                   | Qwen3.6-27B-UD-Q4_K_XL.gguf (same as base)                                                                                      | UD-Q4_K_XL                                       | 262K         | Text, Image                   | beellama                         | MLA (Multi-head Latent Attention) variant                                                        |
| **Qwen 3.5 28B-A3B MoE REAP**           | barozp/Qwen-3.5-28B-A3B-REAP-GGUF                                               | MoE (28B total / 3B active)          | 28.24B / 205 experts  | Qwen-3.5-28B-A3B-REAP-Q4_K_M.gguf                                                                                               | Q4_K_M, IQ3_XXS                                  | 262K         | Text                          | turboquant                       | REAP expert pruning (128→205 experts?), 3B active, 17 GB                                         |
| **Holo 35B A3B**                        | mradermacher/barozp Holo-3.1-35B-A3B / Qwen-3.5-28B-A3B-REAP                    | MoE                                  | 35B total / 3B active | Qwen-3.5-28B-A3B-REAP-Q4_K_M.gguf, mmproj-holo-31-F16.gguf                                                                      | Q4_K_M, mmproj                                   | 65K          | Text, Image                   | beellama                         | Vision MoE, needs mmproj                                                                         |
| **StrangeMerges 19-7B**                 | mradermacher/StrangeMerges_19-7B-dare_ties-GGUF                                 | Dense (merge)                        | 19B/7B                | StrangeMerges_19-7B-dare_ties.Q4_K_M.gguf                                                                                       | Q4_K_M                                           | ~32K         | Text                          | beellama                         | DARE-TIES merge, community GGUF                                                                  |
| **MN-GRAND 23.5B**                      | DavidAU/MN-GRAND-23.5B-Gutenberg-UNCENSORED-V2-GLM4.7-Thinking-NEO-Imatrix-GGUF | Dense                                | 23.5B                 | MN-GRAND-23.5B-Gutenberg-UNCENSORED-V2-Q4_K_M.gguf                                                                              | Q4_K_M                                           | 32K+         | Text                          | turboquant                       | Uncensored, thinking/NEO variants, imatrix quant                                                 |
| **Qwen 2.5 1.5B Draft**                 | bartowski/Qwen2.5-1.5B-Instruct-GGUF                                            | Dense                                | 1.5B                  | Qwen2.5-1.5B-Draft-Q8_0.gguf                                                                                                    | Q8_0                                             | 32K          | Text                          | all                              | Simple draft model for speculative decoding (tokenizer mismatch with Gemma/Qwen3.6!)             |

---

## 🎯 FORK-SPECIFIC DEPLOYMENT MATRIX

### **beellama.cpp (Anbeeld fork)** — DFlash + TurboQuant/TCQ + Reasoning Loop Guard

| Model                                  | Context         | KV Cache   | Speculative          | Reasoning                  | VRAM (est) | Notes                      |
| -------------------------------------- | --------------- | ---------- | -------------------- | -------------------------- | ---------- | -------------------------- |
| beellama/qwen-flash-64k                | 64K             | q8_0       | none                 | off                        | ~9 GB      | Utility model              |
| beellama/qwen-flash-96k                | 96K             | q8_0       | none                 | off                        | ~11 GB     | VS Code utility            |
| beellama/qwen-flash-128k               | 128K            | q8_0       | none                 | off                        | ~13 GB     |                            |
| beellama/qwen-flash-256k               | **128K capped** | q8_0       | none                 | off                        | ~13 GB     | 9B can't do 256K on 24GB   |
| beellama/qwen-flash-mtp-64k            | 64K             | q8_0       | MTP                  | off                        | ~9 GB      |                            |
| beellama/qwen-flash-mtp-128k           | 128K            | turbo3     | MTP                  | off                        | ~13 GB     |                            |
| beellama/gemma-64k                     | 64K             | q8_0       | simple draft         | off                        | ~9 GB      | Gemma temp 1.0             |
| beellama/gemma-96k                     | 96K             | turbo3     | simple draft         | off                        | ~11 GB     |                            |
| beellama/gemma-128k                    | 128K            | turbo3_tcq | simple draft         | off                        | ~13 GB     |                            |
| beellama/gemma-mtp-64k                 | 64K             | q8_0       | MTP                  | off                        | ~9 GB      |                            |
| beellama/gemma-mtp-128k                | 128K            | turbo3_tcq | MTP                  | off                        | ~13 GB     |                            |
| beellama/gemma-12b-draft-64k           | 64K             | q8_0       | simple draft         | off                        | ~9 GB      | **Tokenizer mismatch!**    |
| beellama/strange-64k                   | 64K             | q8_0       | simple draft         | off                        | ~9 GB      |                            |
| beellama/qwen-flash-64k (mradermacher) | 128K            | q8_0       | none                 | **ON** (preserve_thinking) | ~9 GB      | Code/deepseek              |
| qwen/27b-cerebellum                    | 96K             | turbo3     | none                 | off                        | ~17 GB     | --mla-attn                 |
| qwen/27b-dflash-iq4xs                  | **32K capped**  | q8_0       | none                 | off                        | ~17 GB     | DFlash target, not utility |
| qwen3.6-27b-dflash-iq4xs-mtp           | 128K            | q8_0       | MTP                  | off                        | ~27 GB     | **Likely OOM on 24GB**     |
| beellama/gemma4-31b-it-dflash-Q4_K_M   | 128K            | q8_0       | DFlash (Gemma draft) | off                        | ~9 GB      | Needs DFlash draft path    |
| beellama/exaone-4-0-1-2b-iq4xs         | 32K             | q8_0       | none                 | off                        | ~2 GB      | Tiny coding                |
| beellama/exaone-4-0-1-2b-q4km          | 32K             | q8_0       | none                 | off                        | ~3 GB      |                            |

### **turboquant / llama-cpp-turboquant (TheTom lineage)** — turbo3 KV cache

| Model                       | Context | KV Cache | Speculative | VRAM (est) | Notes       |
| --------------------------- | ------- | -------- | ----------- | ---------- | ----------- |
| turboquant/mn-grand-64k     | 64K     | q8_0     | none        | ~13 GB     |             |
| turboquant/mn-grand-96k     | 96K     | q8_0     | none        | ~16 GB     |             |
| turboquant/mn-grand-128k    | 128K    | q8_0     | none        | ~20 GB     |             |
| turboquant/heretic-27b-128k | 128K    | q8_0     | none        | ~15.9 GB   | Q5_K_XL     |
| turboquant/heretic-27b-256k | 256K    | q8_0     | none        | ~18.5 GB   | Q5_K_XL     |
| gemma-4-12b-unified         | 256K    | turbo3   | none        | ~19 GB     | --no-warmup |
| gemma-4-12b-mtp             | 128K    | turbo3   | none        | ~16 GB     |             |

### **ik_llama.cpp (ikawrakow fork)** — --fit auto-offload + --defrag-thold

| Model                   | Context | KV Cache | Speculative | VRAM (est) | Notes                         |
| ----------------------- | ------- | -------- | ----------- | ---------- | ----------------------------- |
| ik_llama/heretic-ud-64k | 64K     | q8_0     | none        | ~17 GB     | Q5_K_XL (only Q5 file exists) |
| ik_llama/heretic-ud-96k | 96K     | q8_0     | none        | ~20.3 GB   | **TIGHT** on 24GB             |
| ik_llama/heretic-q5-64k | 64K     | q8_0     | none        | ~22.2 GB   | Q5_K_XL                       |

### **ik_turboquant (ikawrakow + TCQ)**

| Model                          | Context | KV Cache | Speculative | VRAM (est) | Notes   |
| ------------------------------ | ------- | -------- | ----------- | ---------- | ------- |
| ik_turboquant/heretic-27b-256k | 256K    | q8_0     | none        | ~22 GB     | Q5_K_XL |
| ik_turboquant/heretic-ud-96k   | 96K     | q8_0     | none        | ~20 GB     | Q5_K_XL |

---

## ⚠️ CRITICAL ISSUES TO FIX IN CONFIG.YAML

### 1. **Missing Q4 Heretic File**

- Config references `heretic_ud_q4` pointing to `heretic-UD-27B-Q5_K_XL.gguf` — **file doesn't exist**
- Only `heretic-UD-27B-Q5_K_XL.gguf` exists locally
- Fix: Either download Q4_K_XL variant or update all `ik_llama/heretic-ud-*` models to use Q5_K_XL with correct `quant` metadata

### 2. **Tokenizer Mismatch: Simple Draft on Gemma/Qwen3.6**

- `spec_draft_simple` uses `Qwen2.5-1.5B-Draft` — **different tokenizer** from Gemma 4 and Qwen 3.6
- Acceptance rate will be ~0% on these models
- Fix: Remove `spec_draft_simple` from Gemma/Qwen3.6 models, use MTP or DFlash only

### 3. **256K Context on 9B Models = OOM**

- `beellama/qwen-flash-256k` capped to 128K in metadata but config still uses 256K macros
- Fix: Keep 128K cap for 9B models

### 4. **Reasoning Flag Wrong for beellama**

- Config uses `--reasoning-format deepseek` (mainline llama.cpp)
- beellama uses `--reasoning on/off --chat-template-kwargs '{"preserve_thinking":true}'`
- Fix: Update `reasoning_mainline` macro and all model usages

### 5. **--no-context-shift in srv_safety**

- Prevents context shifting needed for >128K contexts
- Fix: Remove from `srv_safety`, create `srv_safety_no_shift` variant if needed

### 6. **LD_LIBRARY_PATH in cmd (not env)**

- Every model has `LD_LIBRARY_PATH=...` in `cmd:` — herd's `SanitizeCommand()` doesn't run shell
- Fix: Move all `LD_LIBRARY_PATH` to `env:` arrays (already done in my rewrite)

### 7. **Duplicate Macros**

- `qwen_flash_iq4xs` and `qwen_flash_9b_iq4xs` identical
- Fix: Remove duplicate

### 8. **Missing Model Entries for Available Files**

Local files NOT in config:

- `gemma-4-12B-DFlash-Q4_K_M.gguf` → Gemma 4 12B DFlash target
- `gemma-4-12B-it-assistant-Q8_0.gguf` → Gemma MTP drafter (Q8_0)
- `gemma-4-12B-it-MTP-Q8_0.gguf` → Gemma MTP Q8_0
- `gemma-4-21b-a4b-it-REAP-Q4_K_M.gguf` → Gemma 21B MoE
- `Q3.5-9B-DS-v4-Flash-DA-Q4_K_M.gguf` → Qwen 9B DA quant
- `Qwen3.5-9B-DFlash-Q4_K_M.gguf` / `qwen3.5-9b-dflash-Q5_K_M.gguf` → Qwen 9B DFlash
- `Qwen3.6-27B-DFlash-Q4_K_M.gguf` → Qwen 27B DFlash Q4
- `Qwen3.6-27B-MTP-UD-Q4_K_XL.gguf` → Qwen 27B MTP
- `mmproj-gemma4-12b-f16.gguf` / `mmproj-gemma4-BF16.gguf` / `mmproj-gemma4-F16.gguf` → Gemma mmproj variants
- `mmproj-holo-31-F16.gguf` → Holo mmproj
- `mmproj-qwen36-27B-F16.gguf` → Qwen 3.6 mmproj
- `mtp-gemma-4-12b-it.gguf` / `mtp-gemma-4-12b-it-uncensored.gguf` → MTP drafters
- `EXAONE-4.0-1.2B-Q5_K_M.gguf` / `Q6_K.gguf` / `Q8_0.gguf` → EXAONE higher quants

---

## 🔧 NEXT STEPS

1. **Add all missing model entries** to config.yaml for every local .gguf file
2. **Fix the 8 critical issues** above
3. **Validate each model loads** with `go run ./herd.go --config config.yaml --listen 127.0.0.1:25100` (dry-run)
4. **Test key models** actually start (beellama/qwen-flash-64k, turboquant/heretic-27b-128k, etc.)

---

## 📁 LOCAL FILE VERIFICATION

```bash
# Run this to verify all referenced files exist:
ls -la /home/toxic/projects/models/*.gguf | awk '{print $9}'
```

Files confirmed present (34 .gguf files + symlinks):

- EXAONE-4.0-1.2B-{IQ4_XS,Q4_K_M,Q5_K_M,Q6_K,Q8_0}.gguf (5)
- gemma-4-12B-DFlash-Q4_K_M.gguf (1)
- gemma-4-12B-it-assistant-Q8_0.gguf (1)
- gemma4-12b-it-mtp-Q4_K_M.gguf (1)
- gemma-4-12B-it-MTP-Q8_0.gguf (1)
- gemma-4-12b-it-Q4_K_M.gguf (1)
- gemma-4-12B-it-uncensored-Q4_K_M.gguf (1)
- gemma-4-21b-a4b-it-REAP-Q4_K_M.gguf (1)
- gemma4-31b-it-dflash-Q4_K_M.gguf (1)
- heretic-UD-27B-Q5_K_XL.gguf (1)
- mmproj-27B-F16.gguf (1)
- mmproj-F16.gguf (1)
- mmproj-gemma4-12b-f16.gguf (1)
- mmproj-gemma4-BF16.gguf (1)
- mmproj-gemma4-F16.gguf (1)
- mmproj-holo-31-F16.gguf (1)
- mmproj-qwen36-27B-F16.gguf (1)
- MN-GRAND-23.5B-Gutenberg-UNCENSORED-V2-Q4_K_M.gguf (1)
- mtp-gemma-4-12b-it.gguf (1)
- mtp-gemma-4-12b-it-uncensored.gguf (1)
- Q3.5-9B-DS-v4-Flash-DA-Q4_K_M.gguf (1)
- Qwen2.5-1.5B-Draft.gguf / Qwen2.5-1.5B-Draft-Q8_0.gguf (2)
- Qwen2.5-1.5B-Instruct-Q8_0.gguf (1)
- Qwen3.5-1.5B-Draft.gguf (1)
- Qwen-3.5-28B-A3B-REAP-Q4_K_M.gguf (1)
- Qwen3.5-9B-DeepSeek-V4-Flash-IQ4_XS.gguf (1)
- Qwen3.5-9B-DeepSeek-V4-Flash-MTP-BF16.gguf (1)
- Qwen3.5-9B-DeepSeek-V4-Flash-MTP-Q4_K_M.gguf (1)
- Qwen3.5-9B-DFlash-Q4_K_M.gguf (1)
- qwen3.5-9b-dflash-Q5_K_M.gguf (1)
- Qwen3.6-27B-DFlash-IQ4_XS.gguf (1)
- Qwen3.6-27B-DFlash-Q4_K_M.gguf (1)
- Qwen3.6-27B-MTP-UD-Q4_K_XL.gguf (1)
- Qwen3.6-27B-UD-Q4_K_XL.gguf (1)
- StrangeMerges_19-7B-dare_ties.Q4_K_M.gguf (1)

**Total: 34 unique .gguf files** (many more than currently configured)
