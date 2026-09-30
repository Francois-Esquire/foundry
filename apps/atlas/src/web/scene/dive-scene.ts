import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DodecahedronGeometry,
  DoubleSide,
  FogExp2,
  Group,
  InstancedMesh,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Scene,
  SRGBColorSpace,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { abs, materialColor, positionLocal, pow, sin, vec3 } from "three/tsl";
import { MeshStandardNodeMaterial, WebGPURenderer } from "three/webgpu";
import type { RenderSettings } from "../chart-settings";
import { defaultRenderSettings } from "../chart-settings";
import { unit } from "../geography";
import type { FormerPackage } from "../types";
import { createRenderPipeline } from "./pipeline";
import { createWreckLayer } from "./wreck-layer";

function disposeModel(root: Object3D) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) {
      return;
    }
    const mesh = object as Mesh;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material]) {
      materials.add(material);
    }
  });
  for (const geometry of geometries) {
    geometry.dispose();
  }
  for (const material of materials) {
    if (material instanceof MeshStandardMaterial) {
      material.map?.dispose();
      material.normalMap?.dispose();
    }
    material.dispose();
  }
}

/**
 * Distance at which occlusion reach is measured: the edge of visibility in
 * the fog. Measured nearer, the reach would fall below what the far seabed
 * can resolve and shade a false horizon; measured here, the default reach is
 * a few scene units, which reads as contact shadow at the wreck.
 */
const reachDepth = 380;

export function createDiveScene(host: HTMLElement, wreck: FormerPackage) {
  const renderer = new WebGPURenderer({
    antialias: true,
    trackTimestamp: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  host.append(renderer.domElement);
  let ready = false;
  const scene = new Scene();
  scene.background = new Color("#4a7778");
  scene.fog = new FogExp2("#4a7778", 0.012);
  scene.add(new AmbientLight("#b4d8c8", 1.25));
  const light = new DirectionalLight("#e1ecd0", 3.8);
  light.position.set(-22, -18, 45);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.camera.bottom = -90;
  light.shadow.camera.left = light.shadow.camera.bottom;
  light.shadow.camera.top = 90;
  light.shadow.camera.right = light.shadow.camera.top;
  scene.add(light);
  const fill = new DirectionalLight("#9bc8bd", 1.15);
  fill.position.set(28, -40, 4);
  scene.add(fill);

  const floorGeometry = new PlaneGeometry(700, 700, 64, 64);
  const positions = floorGeometry.getAttribute("position");
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i),
      y = positions.getY(i);
    positions.setZ(
      i,
      -13.8 + Math.sin(x * 0.045) * 0.75 + Math.cos(y * 0.065) * 0.55
    );
  }
  floorGeometry.computeVertexNormals();
  const floorMaterial = new MeshStandardNodeMaterial({
    color: "#8f9c89",
    roughness: 1,
  });
  // Caustic light dancing on the seabed, keyed to the floor's local position.
  const causticX = positionLocal.x;
  const causticY = positionLocal.y;
  const caustic = sin(causticX.mul(0.19).add(sin(causticY.mul(0.12)))).mul(
    sin(causticY.mul(0.17).sub(sin(causticX.mul(0.09))))
  );
  floorMaterial.colorNode = materialColor.rgb.add(
    vec3(0.12, 0.17, 0.14).mul(pow(abs(caustic), 12))
  );
  const floor = new Mesh(floorGeometry, floorMaterial);
  floor.receiveShadow = true;
  scene.add(floor);

  const rockGeometry = new DodecahedronGeometry(1, 0);
  const rockMaterial = new MeshStandardMaterial({
    color: "#75877b",
    flatShading: true,
    roughness: 1,
  });
  const rocks = new InstancedMesh(rockGeometry, rockMaterial, 56);
  const rockTransform = new Object3D();
  for (let i = 0; i < rocks.count; i += 1) {
    const distance = 17 + unit(`${wreck.id}:rock:distance:${i}`) * 62;
    const angle = unit(`${wreck.id}:rock:angle:${i}`) * Math.PI * 2;
    const x = Math.cos(angle) * distance;
    const y = Math.sin(angle) * distance;
    const size = 0.5 + unit(`${wreck.id}:rock:size:${i}`) * 1.9;
    rockTransform.position.set(
      x,
      y,
      -13.5 + Math.sin(x * 0.045) * 0.75 + Math.cos(y * 0.065) * 0.55
    );
    rockTransform.rotation.set(
      unit(`${wreck.id}:rock:tilt:${i}`),
      unit(`${wreck.id}:rock:turn:${i}`),
      angle
    );
    rockTransform.scale.set(size, size * 0.7, size * 0.35);
    rockTransform.updateMatrix();
    rocks.setMatrixAt(i, rockTransform.matrix);
  }
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  scene.add(rocks);

  const timberGeometry = new CylinderGeometry(0.2, 0.3, 1, 5);
  const timberMaterial = new MeshStandardMaterial({
    color: "#566d61",
    roughness: 1,
  });
  const timbers = new InstancedMesh(timberGeometry, timberMaterial, 18);
  const timberTransform = new Object3D();
  for (let i = 0; i < timbers.count; i += 1) {
    const x = (unit(`${wreck.id}:timber:x:${i}`) - 0.5) * 48;
    const y = (unit(`${wreck.id}:timber:y:${i}`) - 0.5) * 48;
    timberTransform.position.set(
      x,
      y,
      -13.4 + Math.sin(x * 0.045) * 0.75 + Math.cos(y * 0.065) * 0.55
    );
    timberTransform.rotation.set(
      0,
      0,
      unit(`${wreck.id}:timber:angle:${i}`) * Math.PI * 2
    );
    timberTransform.scale.set(
      1,
      3 + unit(`${wreck.id}:timber:length:${i}`) * 8,
      1
    );
    timberTransform.updateMatrix();
    timbers.setMatrixAt(i, timberTransform.matrix);
  }
  timbers.castShadow = true;
  scene.add(timbers);

  const ship = createWreckLayer([{ ...wreck, x: 0, y: 0 }]);
  scene.add(ship.group);
  let model: Group | null = null;
  let disposed = false;
  new GLTFLoader().load("./atlas/two-masted-brig.glb", (gltf) => {
    if (disposed) {
      disposeModel(gltf.scene);
      return;
    }
    model = new Group();
    gltf.scene.rotation.x = Math.PI / 2;
    gltf.scene.traverse((object) => {
      if (!(object instanceof Mesh)) {
        return;
      }
      object.castShadow = true;
      object.receiveShadow = true;
      for (const material of Array.isArray(object.material)
        ? object.material
        : [object.material]) {
        if (material instanceof MeshStandardMaterial) {
          material.roughness = 1;
          material.color.lerp(new Color("#82988a"), 0.17);
        }
      }
    });
    model.add(gltf.scene);
    model.position.z = -15.5;
    model.rotation.set(0.55, 0.42, 0.28);
    scene.add(model);
    ship.group.visible = false;
    render();
  });

  const dustPositions = new Float32Array(240 * 3);
  for (let i = 0; i < 240; i += 1) {
    dustPositions[i * 3] = (unit(`${wreck.id}:dust:x:${i}`) - 0.5) * 180;
    dustPositions[i * 3 + 1] = (unit(`${wreck.id}:dust:y:${i}`) - 0.5) * 180;
    dustPositions[i * 3 + 2] = unit(`${wreck.id}:dust:z:${i}`) * 28 - 12;
  }
  const dustGeometry = new BufferGeometry();
  dustGeometry.setAttribute("position", new BufferAttribute(dustPositions, 3));
  const dust = new Points(
    dustGeometry,
    new PointsMaterial({
      color: "#d8e8d6",
      depthWrite: false,
      opacity: 0.3,
      size: 0.13,
      transparent: true,
    })
  );
  scene.add(dust);

  const shaftMaterial = new MeshBasicMaterial({
    color: "#c5e2cc",
    depthWrite: false,
    opacity: 0.025,
    side: DoubleSide,
    transparent: true,
  });
  const shafts: Mesh[] = [];
  const shaftPositions: [number, number, number][] = [
    [-24, 9, 11],
    [19, -12, 8],
    [42, 28, 14],
  ];
  for (const [x, y, radius] of shaftPositions) {
    const shaft = new Mesh(
      new ConeGeometry(radius, 80, 16, 1, true),
      shaftMaterial
    );
    shaft.position.set(x, y, 25);
    shaft.rotation.x = Math.PI / 2;
    scene.add(shaft);
    shafts.push(shaft);
  }

  const camera = new PerspectiveCamera(38, 1, 0.1, 500);
  camera.up.set(0, 0, 1);
  camera.position.set(27, -45, -3);
  camera.lookAt(0, 0, -9);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, -9);
  controls.enablePan = false;
  controls.minDistance = 30;
  controls.maxDistance = 105;
  controls.minPolarAngle = 0.45;
  controls.maxPolarAngle = 2.2;
  controls.enableDamping = false;

  const pipeline = createRenderPipeline({
    camera,
    filter: () => "original",
    // A stage finishes building after the frame that asked for it.
    onStatus: () => render(),
    renderer,
    scene,
    unitsPerPixel: () =>
      (2 * reachDepth * Math.tan((camera.fov * Math.PI) / 360)) /
      Math.max(1, host.clientHeight),
  });
  const render = () => {
    if (ready) {
      pipeline.render();
    }
  };
  controls.addEventListener("change", render);
  const resize = () => {
    camera.aspect = host.clientWidth / Math.max(1, host.clientHeight);
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight);
    render();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  // The backend (WebGPU, or WebGL 2 when unavailable) initializes
  // asynchronously; the first frame waits for it.
  let rendering: RenderSettings = defaultRenderSettings;
  renderer.init().then(
    () => {
      if (disposed) {
        return;
      }
      ready = true;
      pipeline.configure(rendering);
      render();
    },
    () => undefined
  );
  const dispose = () => {
    disposed = true;
    observer.disconnect();
    controls.dispose();
    ship.dispose();
    if (model) {
      disposeModel(model);
    }
    floorGeometry.dispose();
    (floor.material as Material).dispose();
    rockGeometry.dispose();
    rockMaterial.dispose();
    timberGeometry.dispose();
    timberMaterial.dispose();
    for (const shaft of shafts) {
      shaft.geometry.dispose();
    }
    shaftMaterial.dispose();
    dustGeometry.dispose();
    (dust.material as Material).dispose();
    light.shadow.dispose();
    pipeline.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
  return {
    configure: (settings: RenderSettings) => {
      rendering = settings;
      if (ready) {
        pipeline.configure(settings);
        render();
      }
    },
    dispose,
  };
}
