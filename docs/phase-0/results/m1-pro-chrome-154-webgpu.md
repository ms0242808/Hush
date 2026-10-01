# m1-pro-chrome-154-webgpu

- Machine: Apple M1 Pro, 8 cores, 16 GB, Darwin 27.0.0 arm64
- Browser: Chromium 154, Google Chrome 154
- WebGPU (worker): apple · metal-3; shader-f16: yes
- Situation (§2.10): webgpu; WebGL: ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)
- Cores: 8; cross-origin isolated: yes; ORT 1.30.0

| Backend | Model | Precision | Photo | Tile | Run | Time (s) | MP/s | First tile (s) | Band (MiB) | Peak float (MiB) | Verdict |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| webgpu | nafnet-sidd-w32 | fp16 | 1024×1024 | 1120 | cold | 1.88 | 0.56 | 1.84 | 12 | 55 | borderline |
| webgpu | nafnet-sidd-w32 | fp16 | 1024×1024 | 1120 | warm 1 | 1.80 | 0.58 | 1.77 | 12 | 55 | borderline |
| webgpu | nafnet-sidd-w32 | fp16 | 1024×1024 | 1120 | warm 2 | 1.79 | 0.59 | 1.77 | 12 | 55 | borderline |
| webgpu | nafnet-sidd-w32 | fp32 | 1024×1024 | 1120 | cold | 2.16 | 0.49 | 2.13 | 12 | 55 | borderline |
| webgpu | nafnet-sidd-w32 | fp32 | 1024×1024 | 1120 | warm 1 | 2.30 | 0.46 | 2.09 | 12 | 55 | borderline |
| webgpu | nafnet-sidd-w32 | fp16 | 6000×4000 | 480 | cold | 48.43 | 0.50 | 0.41 | 35 | 44 | borderline |
| webgpu | nafnet-sidd-w32 | fp16 | 6000×4000 | 720 | cold | 46.17 | 0.52 | 0.86 | 51 | 69 | borderline |
| webgpu | nafnet-sidd-w32 | fp16 | 6000×4000 | 912 | cold | 42.49 | 0.56 | 1.22 | 59 | 86 | borderline |
| webgpu | nafnet-sidd-w32 | fp16 | 8256×5504 | 976 | warm 1 | 78.22 | 0.58 | 1.44 | 92 | 125 | borderline |
| webgpu | nafnet-sidd-w32 | fp32 | 6000×4000 | 912 | cold | 51.47 | 0.47 | 1.54 | 59 | 86 | borderline |
| webgpu | nafnet-sidd-w32 | fp16 | seam check 1024² | 416 | — | — | — | — | — | — | tiled vs whole: 52.0 dB, max diff 6 |
| webgpu | nafnet-sidd-w32 | fp16 | seam check 1024² | 592 | — | — | — | — | — | — | tiled vs whole: 53.2 dB, max diff 4 |
| webgpu | nafnet-sidd-w64 | fp16 | 1024×1024 | 1120 | cold | 4.42 | 0.24 | 4.39 | 12 | 55 | no-go |
| webgpu | nafnet-sidd-w64 | fp16 | 1024×1024 | 1120 | warm 1 | 5.23 | 0.20 | 5.14 | 12 | 55 | no-go |
| webgpu | nafnet-sidd-w64 | fp16 | 6000×4000 | 912 | cold | 112.41 | 0.21 | 2.87 | 59 | 86 | no-go |

| Step | Peak browser memory (MB) |
| --- | ---: |
| preview, one tile | 2010 |
| preview, fp32 | 2434 |
| 24 MP, tiles ≤ 512 | 2833 |
| 24 MP, tiles ≤ 768 | 2923 |
| 24 MP, tiles ≤ 1024 | 3113 |
| 45 MP, tiles ≤ 1024 | 3277 |
| 24 MP, fp32 | 2850 |
| seams, 512 tiles | 2249 |
| seams, 1024 tiles | 2265 |
| width-64 preview | 3995 |
| width-64, 24 MP | 2009 |
