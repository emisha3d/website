# Librerías de terceros

Solo las usa `/lentes/` (la demo del configurador de lentes). El resto del sitio
sigue sin dependencias. Se sirven desde aquí, no desde un CDN, para que la página
no dependa de nadie más y el video de la cámara nunca salga del navegador.

| Archivo | Qué es | Versión | Licencia |
|---|---|---|---|
| `three-0.186.0.min.js` | Three.js + `OrbitControls`, `RoomEnvironment` y `GLTFLoader` en un solo módulo ES | 0.186.0 | MIT (`three-LICENSE.txt`) |
| `mediapipe-1.0.1/vision_bundle.mjs` | API de MediaPipe Tasks Vision (`@mediapipe/tasks-vision`) | 1.0.1 | Apache-2.0 |
| `mediapipe-1.0.1/vision_wasm_internal.*` | El motor en WebAssembly (solo la variante SIMD) | 1.0.1 | Apache-2.0 |
| `mediapipe-1.0.1/face_landmarker.task` | Modelo de 478 puntos del rostro, float16 | v1 | Apache-2.0 |

Los nombres llevan la versión porque `build.sh` solo sella con `?v=` los JS que
están directamente en `assets/js/`: si se actualiza una librería, se cambia el
nombre del archivo y la caché del navegador no estorba.

## Cómo se regeneró `three-0.186.0.min.js`

Three.js dejó de publicar una versión minificada, así que se armó con esbuild:

```bash
npm pack three@0.186.0 && tar xzf three-0.186.0.tgz && mv package three
mkdir -p node_modules && ln -sfn ../three node_modules/three
cat > entrada.js <<'EOF'
export * from './three/build/three.module.js';
export { OrbitControls } from './three/examples/jsm/controls/OrbitControls.js';
export { RoomEnvironment } from './three/examples/jsm/environments/RoomEnvironment.js';
export { GLTFLoader } from './three/examples/jsm/loaders/GLTFLoader.js';
EOF
npx esbuild entrada.js --bundle --format=esm --minify --legal-comments=eof \
  --outfile=three-0.186.0.min.js
```

El modelo sale de
`https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`.
No se incluyó `vision_wasm_nosimd_internal.*` (11 MB): todos los navegadores
actuales tienen SIMD, y en uno que no lo tenga la página lo dice y el
configurador 3D sigue funcionando sin cámara.
