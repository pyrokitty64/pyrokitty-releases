# Texture Pipeline Findings (2025-02-25)

## Current Pipeline

```
SL CDN (J2C download, 32 concurrent)
  → WASM OpenJPEG decode (2-12 auto-scaling worker threads)
  → CPU alpha detect (~1000 pixel sample)
  → RGBA buffer + format sent via IPC to hidden BrowserWindow
  → GPU single-pass: downsample mip chain + BC1/BC3 compress (WebGPU compute, 1 submit)
  → single readback → .bctex file (header + dense mip chain)
  → Godot loads directly
```

## Performance Baseline

Fresh cache fill on a region with ~10,000 textures + ~5,600 meshes:
- **Throughput**: ~290 textures/sec sustained (Electron-side bottleneck)
- **Electron CPU**: 20-30% during active decode/compress
- **Godot FPS**: 60→45→25fps during loading, ~22fps steady-state (15k objects, 11k materials)
- **Godot texture finalize**: 0.10-0.18ms per `ImageTexture.create_from_image()` (main thread)
- **Godot mesh finalize**: 0.20-1.20ms per `ImporterMesh.get_mesh()` (main thread)
- **Memory peak**: ~5GB RSS target (was ~9-11GB before memory fixes)
- **Queue**: starts at ~10k, drains at ~580/2s interval

## Optimizations Applied

### 1. WASM SIMD (OpenJPEG)
- **What**: Rebuilt `wasm-openjpeg` with Emscripten `-msimd128` flag
- **Result**: 1,207 SIMD instructions auto-vectorized (was 0), primarily in DWT wavelet and T1 entropy inner loops
- **Impact**: Speeds up J2K decode step (the main CPU bottleneck). Exact % TBD — need side-by-side fresh cache comparison
- **Location**: `C:\DeeDrive\dev\wasm-openjpeg`, `scripts/wasm-build.sh`

### 2. GPU Single-Pass Mipmap + Compress Pipeline
- **What**: Moved mipmap generation and BC compression into a single GPU command buffer with one IPC round trip
- **Before**: CPU mipmap via sharp (lanczos3), then 11 separate IPC round trips per texture (one per mip level), each with its own GPU submit + mapAsync readback
- **After**: CPU alpha detect → single IPC to GPU window → GPU downsample_2x chain → BC1/BC3 compress all mips → single readback → strip alignment padding → return
- **Impact**: Eliminates sharp/libvips from the hot path entirely. Reduces IPC round trips from 11 to 1. Single GPU submit avoids pipeline stalls.
- **Key details**:
  - WGSL `downsample_2x` shader: bilinear 2x2 average (negligible quality difference vs lanczos3 for BC-compressed output)
  - Storage buffer offsets aligned to 256 bytes (`minStorageBufferOffsetAlignment`); padding stripped from readback
  - Alpha detection kept on CPU (~0.1ms, samples ~1000 pixels) to avoid a GPU sync stall between alpha readback and compress
  - `try/finally` cleanup of all GPU textures/buffers to prevent leaks on error
- **Location**: `bc-compress.wgsl`, `compress.ts`, `gpu-compress-window.ts`, `gpu-compress-queue.ts`

### 3. Skip sharp for RGB→RGBA
- **What**: Manual byte-padding loop for 3-channel RGB textures instead of full sharp pipeline
- **Before**: `sharp(pixels).ensureAlpha().raw().toBuffer()` — full libvips pipeline for trivial operation
- **After**: Tight loop: copy R,G,B bytes, write 255 for alpha. Sharp fallback only for grayscale/exotic
- **Impact**: Eliminates sharp overhead per texture in the raw decode path (~95%+ of textures are RGB)
- **Location**: `electron-ui/src/main/texture-decode-worker.ts:111-129`

### 4. Memory Leak Fixes
- **setTimeout closure leak**: `gpuCompressFull()` had a 60-second timeout whose closure shared scope with the `rgba` Buffer parameter. Every RGBA buffer was pinned for 60 seconds after processing. Fix: IPC send moved outside the Promise constructor so `rgba` is never captured; `clearTimeout` on response.
- **Unnecessary Buffer.from copy**: `decode-pool.ts` was doing `Buffer.from(msg.rgbaPixels!)` on an already-transferred Buffer, doubling memory per texture. Removed.
- **Decode pool auto-scaling**: Pool starts at 2 workers, scales up to 4-12 (based on system RAM: ~1 per 2GB, clamped to [4, 12]) when queue depth exceeds 4 items per worker. Idle extras beyond 2 are terminated after 30s to reclaim WASM heap (Emscripten linear memory only grows).
- **Download concurrency**: 32 concurrent texture downloads (`MAX_CONCURRENT_DOWNLOADS`).

## Bottleneck Analysis

The pipeline has three stages with different bottlenecks:

### Stage 1: J2K Decode (CPU-bound, ~60-70% of per-texture time)
- 2-12 auto-scaling worker threads, each with own WASM OpenJPEG instance
- Wavelet transform is inherently sequential per tile
- SIMD helps but J2K is just fundamentally slow
- `decode: q=N active=N` — visible in stats line

### Stage 2: GPU Compress (GPU-bound, fast)
- WebGPU compute shader in hidden BrowserWindow
- MAX_CONCURRENT=4 GPU dispatches
- Single submit per texture: downsample mip chain + BC compress all mips
- Negligible time compared to J2K decode
- `gpuq: q=N active=N` — visible in stats line

### Stage 3: Godot Finalize (main thread, budget-limited)
- `ImageTexture.create_from_image()` uploads to GPU — ~0.10-0.18ms each
- `ImporterMesh.get_mesh()` extracts ArrayMesh from parsed GLTFState — ~0.20-1.20ms each
- Budget system: uses remaining frame time above 30fps floor. When over budget, uses 8ms (not 2ms) since frame is already slow.
- `.bctex` path: 0ms load/mipmap/compress (all pre-done)
- **Cannot move to worker threads**: `ImageTexture` and `ArrayMesh` are Object-derived — ObjectDB registration and signal emission are not thread-safe. RS RID operations (`texture_2d_create`) ARE thread-safe on Vulkan, but `StandardMaterial3D` requires `Texture2D` objects, not raw RIDs.

### Stage 4: Rendering (GPU + draw call bound)
- **15,726 objects** with **11,155 unique materials** = nearly 1:1 draw calls
- RTX 3060 sustains ~22fps post-load with zero loading work
- Finalization budget is only ~3ms/frame — rendering itself takes ~45ms
- **Visibility range**: objects fade out 96-128m, culled beyond 128m (reduces visible draw calls)
- **Next wins**: material deduplication, MultiMesh batching, LOD, occlusion culling

**Loading bottleneck: Stage 1 (J2K decode)** — the queue drains at the rate WASM can decode.
**Rendering bottleneck: Stage 4 (draw call count)** — too many unique materials for GPU batching.

### Startup: Cache Initialization
- `initTextureCache()` scans the texture cache dir and populates an in-memory `Map<uuid, extension>` — called in `godot-bridge.ts:start()` before any texture requests
- `initSkeletonData()` preloads skeleton XML into memory — called in `godot-bridge.ts:connectWebSocket()` and by each mesh-convert worker at spawn
- These ensure `isTextureCached()` and `isMeshCached()` remain synchronous (in-memory lookups) while all disk I/O is async

## Monitoring

Stats line (logged every 30s):
```
[GodotBridge] Memory: rss=...MB heap=.../...MB ext=...MB
  | tex: q=... active=... done=... fail=... gpu=N/Mwp
    decode: q=... active=... gpuq: q=... active=...
  | mesh: ... | sculpt: ... | godot(...): ...
```

Key fields:
- **`ext=`**: External/native memory (Buffers, WASM). Should stay under ~2GB.
- **`gpu=N/Mwp`**: N textures GPU compressed, M fell back to WebP.
- **`decode: q=... active=...`**: WASM decode pool queue depth and active workers.
- **`gpuq: q=... active=...`**: GPU compress queue depth and active dispatches. Queue should stay near 0 (GPU is faster than decode).

## Future Optimization Options

### Pure-RID Pipeline: Off-Main-Thread Finalization (Not Yet Implemented)

The current finalization pipeline creates Object-derived classes on the main thread:
- `ImageTexture.create_from_image()` — ~0.2-0.5ms each
- `StandardMaterial3D` creation — Object-derived, cached but still main-thread
- `ImporterMesh.get_mesh()` — ~0.5-1.5ms each

Total: 2-8ms/frame of main-thread work, budget-limited to protect frame rate.

**The idea**: bypass ALL Object-derived classes using raw RenderingServer RID APIs, which ARE thread-safe on Vulkan (`can_create_resources_async()=true`).

| Current (main thread only) | Pure RID (thread-safe on Vulkan) |
|---|---|
| `ImageTexture.create_from_image(img)` | `RenderingServer.texture_2d_create(img)` |
| `StandardMaterial3D.new()` + set props | `RS.material_create()` + `material_set_shader()` + `material_set_param()` |
| `instance_set_surface_override_material(rid, i, mat)` | Same — pass material RID directly |

**Requires a custom shader** to replace StandardMaterial3D's internal shader. Write a `.gdshader` replicating the subset we actually use:

```gdshader
shader_type spatial;
render_mode blend_mix;  // variants: opaque, blend, alpha_test

uniform sampler2D albedo_tex : source_color, filter_linear_mipmap;
uniform vec4 albedo_color : source_color = vec4(1.0);
uniform bool fullbright;

void fragment() {
    vec4 tex = texture(albedo_tex, UV);
    ALBEDO = tex.rgb * albedo_color.rgb;
    ALPHA = tex.a * albedo_color.a;
    if (fullbright) {
        EMISSION = ALBEDO;
    }
}
```

3 shader variants (opaque / alpha_blend / alpha_test) created once at startup. Then the **entire texture+material pipeline** runs on worker threads:

```
Worker thread (fully thread-safe on Vulkan):
  Image loaded from .bctex                                          (already works)
  tex_rid = RS.texture_2d_create(img)                               (thread-safe)
  mat_rid = RS.material_create()                                    (thread-safe)
  RS.material_set_shader(mat_rid, shader_rid)                       (thread-safe)
  RS.material_set_param(mat_rid, "albedo_tex", tex_rid)             (thread-safe)
  RS.material_set_param(mat_rid, "albedo_color", color)             (thread-safe)
  RS.instance_set_surface_override_material(inst_rid, face, mat_rid)(thread-safe)

Main thread: nothing (for textures+materials)
```

**The big win isn't just 2-8ms/frame** — it's removing the budget limiter entirely. Currently finalization is throttled to protect frame rate. With pure RIDs on workers, textures and meshes finalize at full throughput with zero frame impact. Loading gets dramatically faster.

**Mesh finalization** (`ImporterMesh.get_mesh()`) could also move off-thread via `RS.mesh_create()` + `mesh_add_surface_from_arrays()`, but that's more invasive. Start with textures+materials first.

**Status**: Not started. Needs validation that `RS.material_set_param()` accepts RIDs for texture uniforms in custom shaders (expected yes, since ShaderMaterial works this way internally).

### Sub-Resolution Decode (Not Yet Implemented)
- OpenJPEG WASM exposes `decodeSubResolution(level, layer)`
- Skips wavelet decomposition levels: level 1 = half res (~4x faster), level 2 = quarter res (~16x faster)
- `getNumDecompositions()` returns available levels (typically 5 for 1024x1024)
- `calculateSizeAtDecompositionLevel(level)` gives dimensions at each level
- **Tradeoff**: Godot never gets full resolution. Could do two-pass (low-res first, full later) but adds complexity
- **Best for**: distant/small objects where full res is wasted

### WASM SIMD Rebuild with Manual Intrinsics
- Current SIMD is auto-vectorized by Emscripten — limited to what the compiler can figure out
- Could add explicit `wasm_simd128.h` intrinsics to OpenJPEG's DWT hot paths for better vectorization
- Significant effort, OpenJPEG codebase is complex

### Native Node Addon
- Compile OpenJPEG as a native N-API addon (no WASM overhead)
- Native SSE2/AVX2 instead of WASM SIMD (wider vectors, more instructions)
- ~2-3x faster than WASM estimated
- Cross-platform with prebuildify, but adds native build complexity

### Texture Priority / LOD-Aware Decode
- Currently all textures decode at full resolution regardless of screen size
- Could pass pixel area / distance from camera to prioritize nearby textures
- Could use sub-resolution decode for distant textures (combine with above)

### Reduce Download Bottleneck
- Bandwidth already bumped to 10Mbps in Bot.ts
- Could increase MAX_CONCURRENT_DOWNLOADS (currently 8)
- CDN throttling may be the real limit (403 errors seen for some textures)

## Key Gotchas Discovered

### WebGPU Storage Buffer Offset Alignment
- `minStorageBufferOffsetAlignment` is 256 bytes on most GPUs
- When binding sub-regions of a storage buffer (e.g., per-mip output), offsets must be 256-aligned
- **Symptom**: unaligned offset silently invalidates the entire command buffer — GPU executes nothing, readback is all zeros, textures appear black
- **Fix**: Pad offsets to 256 bytes, strip padding from readback before assembling .bctex

### V8 Closure Scope Sharing (setTimeout Memory Leak)
- When two closures share a scope (e.g., Promise executor + setTimeout callback), V8 keeps all captured variables alive as long as ANY closure in that scope is alive
- A 60-second timeout pins the entire scope — including multi-MB Buffers not used by the timeout callback
- **Fix**: Either `clearTimeout` on completion, or move heavy allocations outside the Promise constructor

### Distance Gate Must Precede Material Resolution (Fixed 2026-03-26)
- `sendObject()` in `godot-object-sender.ts` called `resolveObject()` before the distance check
- `resolveObject()` calls `textureFetchQueue.request()` as a side effect — triggers texture downloads
- Far root prims had their textures downloaded even though they were immediately deferred
- Additionally, children of deferred roots bypassed the distance gate entirely (only root prims were distance-checked)
- **Symptom**: 9,000 textures loaded in a sparse sandbox, 8GB VRAM, FPS crashed from 35 to 8
- **Fix**: Distance gate moved before `resolveObject()`. Children of deferred roots are also deferred. `sweepDeferredTextures()` promotes children when their root comes into range.
- **Files changed**: `godot-object-sender.ts`

### Synchronous File I/O Blocks Event Loop (Fixed 2026-03-26)
- Asset pipeline cache writes (`writeFileSync`, `mkdirSync`) and lookups (`existsSync`) were synchronous on the Node.js main thread
- Under heavy loading (2000+ textures queued), dozens of sync writes per second blocked the event loop
- `input_move` WebSocket messages from Godot couldn't be dispatched until the current write finished
- **Symptom**: avatar rotation changes took 2+ seconds to reach the SL server, but Godot rendered smoothly (stale body rotation on server)
- **Fix**: All asset I/O converted to `fs.promises.*` (async). Texture and sculpt cache lookups use in-memory `Map`/`Set` (populated at startup via `initTextureCache()`) to avoid filesystem hits entirely
- **Files changed**: `texture-fetch-queue.ts`, `gpu-compress-queue.ts`, `animation-fetch-queue.ts`, `sculpt-converter.ts`, `sound-fetch-queue.ts`, `sound-player.ts`
- Note: `mesh-converter.ts` was also converted but its I/O already ran on worker threads (`mesh-convert-worker.ts`), so it wasn't blocking the main event loop

### Bundler Binary Mangling
- Emscripten's `binaryDecode()` uses a custom string encoding for the WASM binary (NOT base64)
- Both esbuild and tsup mangle null bytes and special chars when they inline the file
- **Fix**: Mark `openjpegjs.js` as external in tsup config, copy raw to dist/
- The mangling is invisible at build time — the JS is syntactically valid but the WASM binary is corrupt
- Symptom: module loads but produces garbage output or crashes on decode

### Emscripten Container Build
- `emscripten/emsdk:latest` has user `emscripten` (UID 1000) — don't create another
- `wasm-build.sh` must be LF line endings (CRLF fails with "bad interpreter")
- Use podman with `MSYS_NO_PATHCONV=1` on Windows to prevent path mangling
- `--emit-tsd` flag removed from CMakeLists (was failing on copy step)

### Godot Object Creation NOT Thread-Safe (CRITICAL)
- `ImageTexture.create_from_image()` and `ImporterMesh.get_mesh()` create Object-derived classes
- Object constructor registers in ObjectDB; `set_image()` calls `notify_property_list_changed()` and `emit_changed()`
- These cause hard SIGSEGV crashes (no backtrace, crash handler killed) on worker threads
- The underlying RS RID operations ARE thread-safe (`can_create_resources_async()=true` on Vulkan — see `renderer_compositor_rd.h:147`, `FUNCRIDTEX` macros in `rendering_server_default.h:133-208`)
- But `StandardMaterial3D.albedo_texture` requires a `Texture2D` object, not a raw RID — no way to bypass
- **Safe on workers**: `Image.load()`, `Image.generate_mipmaps()`, `Image.compress()`, `GLTFDocument.append_from_file()`, `RenderingServer.texture_2d_create()` (RID only)
- **Unsafe on workers**: `ImageTexture.create_from_image()`, `ImporterMesh.get_mesh()`, any `Object.new()`

### Godot .bctex Loading
- Header: magic `0x42435458` ('BCTX'), version 1, 32 bytes total
- Format 0 = BC1 (DXT1, no alpha), Format 1 = BC3 (DXT5, with alpha)
- Mip data concatenated largest-first (dense, no padding)
- `Image.create_from_data(w, h, has_mipmaps, format, data)` — has_mipmaps must be true if mipCount > 1
