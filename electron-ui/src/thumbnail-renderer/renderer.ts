/**
 * renderer.ts — Three.js thumbnail renderer running in a hidden Electron BrowserWindow.
 * Loads GLB geometry, applies textures, renders to canvas, and returns PNG buffer.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AttachmentPoint } from '../../node-metaverse/lib/enums/AttachmentPoint';

const { ipcRenderer } = require('electron');

// ─── Scene setup ────────────────────────────────────────

const WIDTH = 456;
const HEIGHT = 336;

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
canvas.width = WIDTH;
canvas.height = HEIGHT;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true,
  alpha: true,
});
renderer.setSize(WIDTH, HEIGHT);
renderer.setPixelRatio(1);
renderer.setClearColor(0x2a2a2a, 1); // dark background for card contrast
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;

const scene = new THREE.Scene();

// Lighting: ambient + two directional + rim
const ambient = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambient);

const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
keyLight.position.set(2, 3, 2);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xd4e4ff, 0.4);
fillLight.position.set(-2, 1, -1);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xfff0e0, 0.3);
rimLight.position.set(0, -1, -3);
scene.add(rimLight);

const camera = new THREE.PerspectiveCamera(35, WIDTH / HEIGHT, 0.01, 100);

const gltfLoader = new GLTFLoader();
const textureLoader = new THREE.TextureLoader();

const clayMaterial = new THREE.MeshStandardMaterial({
  color: 0xb0b0b0,
  metalness: 0.1,
  roughness: 0.6,
});

// ─── Rendering ──────────────────────────────────────────

interface PrimData {
  glb: number[]; // GLB as byte array
  position: [number, number, number];
  rotation: [number, number, number, number]; // quaternion xyzw
  scale: [number, number, number];
  textures: Record<number, string>; // faceIndex → file path
  colors: Record<number, [number, number, number, number]>; // faceIndex → RGBA (0-1)
}

interface RenderRequest {
  id: number;
  attachmentPoint?: number;
  rootRotation?: [number, number, number, number]; // SL quaternion xyzw
  bonePose?: Record<string, { rot?: [number, number, number]; pos?: [number, number, number] }>;
  prims: PrimData[];
}

async function loadTexture(filePath: string): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    // Use file:// protocol for local files
    const url = `file:///${filePath.replace(/\\/g, '/')}`;
    textureLoader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        // glTF convention: V=0 at top. Three.js TextureLoader flips Y by default.
        // Disable the flip so UVs match the glTF spec.
        tex.flipY = false;
        resolve(tex);
      },
      undefined,
      (err) => {
        ipcRenderer.send('thumbnail-log', `Texture load FAILED: ${filePath} err=${err?.message || err}`);
        resolve(null);
      },
    );
  });
}

async function renderLinkset(request: RenderRequest): Promise<Uint8Array> {
  // Clear scene (keep lights + camera)
  const toRemove: THREE.Object3D[] = [];
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Group) {
      if (obj.parent === scene) toRemove.push(obj);
    }
  });
  for (const obj of toRemove) {
    scene.remove(obj);
    if (obj instanceof THREE.Mesh) {
      obj.geometry?.dispose();
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material?.dispose();
    }
  }

  const linksetGroup = new THREE.Group();

  for (const prim of request.prims) {
    try {
      const glbBuffer = new Uint8Array(prim.glb).buffer;
      const gltf = await new Promise<any>((resolve, reject) => {
        gltfLoader.parse(glbBuffer, '', resolve, reject);
      });

      const primGroup = gltf.scene as THREE.Group;

      // Load and apply textures per face (per primitive/material index)
      const texPromises: Promise<void>[] = [];
      let materialIndex = 0;

      let meshCount = 0;
      primGroup.traverse((child: THREE.Object3D) => {
        if (child instanceof THREE.SkinnedMesh) ipcRenderer.send('thumbnail-log', `Found SkinnedMesh: ${child.name}`);
        if (!(child instanceof THREE.Mesh)) return;
        meshCount++;
        const geo = child.geometry as THREE.BufferGeometry;
        ipcRenderer.send('thumbnail-log', `Mesh ${child.name} verts:${geo.attributes.position?.count} groups:${geo.groups?.length || 0} skinned:${child instanceof THREE.SkinnedMesh}`);

        const mesh = child as THREE.Mesh;
        const geometry = mesh.geometry as THREE.BufferGeometry;

        // Multi-material meshes (from multiSurfaceToGlb) have groups
        if (geometry.groups && geometry.groups.length > 0) {
          const materials: THREE.Material[] = [];
          for (let gi = 0; gi < geometry.groups.length; gi++) {
            const faceIdx = gi;
            const texPath = prim.textures[faceIdx];
            const faceColor = prim.colors?.[faceIdx];
            const mat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1, transparent: true, alphaTest: 0.1 });
            if (faceColor) {
              mat.color.setRGB(faceColor[0], faceColor[1], faceColor[2]);
              if (faceColor[3] < 1) mat.opacity = faceColor[3];
            }
            if (texPath) {
              texPromises.push(
                loadTexture(texPath).then((tex) => {
                  if (tex) mat.map = tex;
                  mat.needsUpdate = true;
                })
              );
            }
            materials.push(mat);
          }
          mesh.material = materials;
        } else {
          // Single primitive — map SL face index to texture
          const texPath = prim.textures[materialIndex];
          const faceColor = prim.colors?.[materialIndex];
          const mat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1, transparent: true, alphaTest: 0.1 });
          if (faceColor) {
            mat.color.setRGB(faceColor[0], faceColor[1], faceColor[2]);
            if (faceColor[3] < 1) mat.opacity = faceColor[3];
          }
          if (texPath) {
            texPromises.push(
              loadTexture(texPath).then((tex) => {
                if (tex) mat.map = tex;
                mat.needsUpdate = true;
              })
            );
          }
          mesh.material = mat;
          materialIndex++;
        }
      });

      await Promise.all(texPromises);

      // Check if this prim has rigged (skinned) meshes
      let hasSkin = false;
      primGroup.traverse((c: THREE.Object3D) => {
        if (c instanceof THREE.SkinnedMesh) hasSkin = true;
      });

      if (hasSkin) {
        // Rigged mesh: skeleton rest pose already positions vertices correctly.
        // All rigged parts share the same skeleton structure (avatar_skeleton.xml),
        // so they assemble correctly at origin without prim transforms.
        // Applying linkset prim position/rotation would double-offset parts that
        // are designed to be driven by a shared avatar skeleton.
      } else {
        // Non-rigged: apply SL prim transform (position, rotation, scale).
        // GLB geometry is already in glTF coordinate space; convert SL→glTF.
        const [px, py, pz] = prim.position;
        primGroup.position.set(px, pz, -py);
        const [qx, qy, qz, qw] = prim.rotation;
        primGroup.quaternion.set(qx, qz, -qy, qw);
        const [sx, sy, sz] = prim.scale;
        primGroup.scale.set(sx, sz, sy);
      }

      linksetGroup.add(primGroup);
    } catch (err) {
      console.warn('[ThumbRenderer] Failed to load prim GLB:', err);
    }
  }

  // HUD detection — used for root rotation skip and camera selection
  const isHUD = request.attachmentPoint
    && request.attachmentPoint >= AttachmentPoint.HUDCenter2
    && request.attachmentPoint <= AttachmentPoint.HUDBottomRight;

  // Apply root prim rotation to the entire linkset so children
  // (which are in root-local space) rotate with the root.
  // Skip for HUD attachments — their rotation is screen-relative, not 3D.
  if (request.rootRotation && !isHUD) {
    const [qx, qy, qz, qw] = request.rootRotation;
    linksetGroup.quaternion.set(qx, qz, -qy, qw);
  }

  scene.add(linksetGroup);

  // Apply bone pose for animation thumbnails
  if (request.bonePose) {
    linksetGroup.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.SkinnedMesh && child.skeleton) {
        for (const bone of child.skeleton.bones) {
          const jointPose = request.bonePose![bone.name];
          if (!jointPose) continue;

          if (jointPose.rot) {
            // SL rotation is (x,y,z) with w = sqrt(1 - x² - y² - z²)
            const [rx, ry, rz] = jointPose.rot;
            const ww = 1.0 - rx * rx - ry * ry - rz * rz;
            const rw = ww > 0 ? Math.sqrt(ww) : 0;
            // Convert SL quaternion (x,y,z,w) → glTF (x,z,-y,w)
            bone.quaternion.set(rx, rz, -ry, rw);
          }

          if (jointPose.pos) {
            // SL position → glTF: (x,z,-y)
            const [px, py, pz] = jointPose.pos;
            bone.position.set(px, pz, -py);
          }
        }
      }
    });
  }

  // Ensure skeleton transforms are propagated for skinned meshes
  linksetGroup.updateMatrixWorld(true);
  linksetGroup.traverse((child: THREE.Object3D) => {
    if (child instanceof THREE.SkinnedMesh && child.skeleton) {
      child.skeleton.update();
      // Force the bounding box to be recomputed from skinned positions
      child.geometry.computeBoundingBox();
      child.geometry.computeBoundingSphere();
    }
  });

  // Auto-frame camera: compute bounding box of entire linkset
  const bbox = new THREE.Box3().setFromObject(linksetGroup);
  if (bbox.isEmpty()) {
    bbox.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  }

  const center = new THREE.Vector3();
  bbox.getCenter(center);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  const radius = maxDim * 0.5 * 1.3; // 30% padding

  let activeCamera: THREE.Camera;
  if (isHUD) {
    // Orthographic camera looking straight at -Z (front-facing)
    const aspect = WIDTH / HEIGHT;
    const halfH = maxDim * 0.6;
    const halfW = halfH * aspect;
    const ortho = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, maxDim * 10);
    ortho.position.set(center.x, center.y, center.z + maxDim * 2);
    ortho.lookAt(center);
    activeCamera = ortho;
  } else {
    // 3/4 view angle: slightly above and to the right
    const fov = camera.fov * (Math.PI / 180);
    const dist = radius / Math.sin(fov / 2);
    const camOffset = new THREE.Vector3(0.7, 0.5, 1.0).normalize().multiplyScalar(dist);
    camera.position.copy(center).add(camOffset);
    camera.lookAt(center);
    camera.near = dist * 0.01;
    camera.far = dist * 10;
    camera.updateProjectionMatrix();
    activeCamera = camera;
  }

  // Render
  renderer.render(scene, activeCamera);

  // Capture as PNG
  const dataUrl = canvas.toDataURL('image/png');
  const base64 = dataUrl.split(',')[1];
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Cleanup textures
  linksetGroup.traverse((obj: THREE.Object3D) => {
    if (obj instanceof THREE.Mesh) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) {
        if (mat instanceof THREE.MeshStandardMaterial && mat.map) {
          mat.map.dispose();
        }
        if (mat !== clayMaterial) mat.dispose();
      }
      obj.geometry?.dispose();
    }
  });

  return bytes;
}

// ─── IPC handling ───────────────────────────────────────

ipcRenderer.on('thumbnail-request', async (_event: any, request: RenderRequest) => {
  try {
    const png = await renderLinkset(request);
    ipcRenderer.send('thumbnail-response', { id: request.id, png });
  } catch (err: any) {
    ipcRenderer.send('thumbnail-response', { id: request.id, error: err.message || String(err) });
  }
});

// Signal ready
ipcRenderer.send('thumbnail-ready', { available: true });
ipcRenderer.send('thumbnail-log', 'Ready');
