# m1-pro-chrome-154-wasm

- Machine: Apple M1 Pro, 8 cores, 16 GB, Darwin 27.0.0 arm64
- Browser: Chromium 154, Google Chrome 154
- WebGPU (worker): apple · metal-3; shader-f16: yes
- Situation (§2.10): webgpu; WebGL: ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)
- Cores: 8; cross-origin isolated: yes; ORT 1.30.0

| Backend | Model | Precision | Photo | Tile | Run | Time (s) | MP/s | First tile (s) | Band (MiB) | Peak float (MiB) | Verdict |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| wasm | nafnet-sidd-w32 | fp32 | 1024×1024 | 416 | cold | 11.86 | 0.09 | 1.34 | 5 | 11 | go |
| wasm | nafnet-sidd-w32 | fp32 | 1024×1024 | 416 | warm 1 | 11.44 | 0.09 | 1.28 | 5 | 11 | go |
| wasm | nafnet-sidd-w32 | fp32 | 6000×4000 | 480 | cold | 208.30 | 0.12 | 1.75 | 35 | 44 | go |

| Step | Peak browser memory (MB) |
| --- | ---: |
| processor, fp32 | 1991 |
| processor, 24 MP fp32 | 2604 |
