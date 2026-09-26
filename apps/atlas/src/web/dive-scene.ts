import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { unit } from "./geography";
import type { FormerPackage } from "./types";
import { createWreckLayer } from "./wreck-layer";

function disposeModel(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) {
      return;
    }
    const mesh = object as THREE.Mesh;
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
    if (material instanceof THREE.MeshStandardMaterial) {
      material.map?.dispose();
      material.normalMap?.dispose();
    }
    material.dispose();
  }
}

export function createDiveScene(host: HTMLElement, wreck: FormerPackage) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#4a7778");
  scene.fog = new THREE.FogExp2("#4a7778", 0.012);
  scene.add(new THREE.AmbientLight("#b4d8c8", 1.25));
  const light = new THREE.DirectionalLight("#e1ecd0", 3.8);
  light.position.set(-22, -18, 45);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.camera.left = light.shadow.camera.bottom = -90;
  light.shadow.camera.right = light.shadow.camera.top = 90;
  scene.add(light);
  const fill = new THREE.DirectionalLight("#9bc8bd", 1.15);
  fill.position.set(28, -40, 4);
  scene.add(fill);

  const floorGeometry = new THREE.PlaneGeometry(700, 700, 64, 64);
  const positions = floorGeometry.getAttribute("position");
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i),
      y = positions.getY(i);
    positions.setZ(
      i,
      -13.8 + Math.sin(x * 0.045) * 0.75 + Math.cos(y * 0.065) * 0.55
    );
  }
  floorGeometry.computeVertexNormals();
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: "#8f9c89",
    roughness: 1,
  });
  floorMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      "#include <common>\nvarying vec2 causticPosition;"
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\ncausticPosition = position.xy;"
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      "#include <common>\nvarying vec2 causticPosition;"
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `#include <map_fragment>
float caustic = sin(causticPosition.x * 0.19 + sin(causticPosition.y * 0.12)) * sin(causticPosition.y * 0.17 - sin(causticPosition.x * 0.09));
diffuseColor.rgb += vec3(0.12, 0.17, 0.14) * pow(abs(caustic), 12.0);`
    );
  };
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.receiveShadow = true;
  scene.add(floor);

  const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
  const rockMaterial = new THREE.MeshStandardMaterial({
    color: "#75877b",
    flatShading: true,
    roughness: 1,
  });
  const rocks = new THREE.InstancedMesh(rockGeometry, rockMaterial, 56);
  const rockTransform = new THREE.Object3D();
  for (let i = 0; i < rocks.count; i++) {
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

  const timberGeometry = new THREE.CylinderGeometry(0.2, 0.3, 1, 5);
  const timberMaterial = new THREE.MeshStandardMaterial({
    color: "#566d61",
    roughness: 1,
  });
  const timbers = new THREE.InstancedMesh(timberGeometry, timberMaterial, 18);
  const timberTransform = new THREE.Object3D();
  for (let i = 0; i < timbers.count; i++) {
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
  let model: THREE.Group | null = null;
  let disposed = false;
  new GLTFLoader().load("/atlas/two-masted-brig.glb", (gltf) => {
    if (disposed) {
      disposeModel(gltf.scene);
      return;
    }
    model = new THREE.Group();
    gltf.scene.rotation.x = Math.PI / 2;
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) {
        return;
      }
      object.castShadow = true;
      object.receiveShadow = true;
      for (const material of Array.isArray(object.material)
        ? object.material
        : [object.material]) {
        if (material instanceof THREE.MeshStandardMaterial) {
          material.roughness = 1;
          material.color.lerp(new THREE.Color("#82988a"), 0.17);
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
  for (let i = 0; i < 240; i++) {
    dustPositions[i * 3] = (unit(`${wreck.id}:dust:x:${i}`) - 0.5) * 180;
    dustPositions[i * 3 + 1] = (unit(`${wreck.id}:dust:y:${i}`) - 0.5) * 180;
    dustPositions[i * 3 + 2] = unit(`${wreck.id}:dust:z:${i}`) * 28 - 12;
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(dustPositions, 3)
  );
  const dust = new THREE.Points(
    dustGeometry,
    new THREE.PointsMaterial({
      color: "#d8e8d6",
      depthWrite: false,
      opacity: 0.3,
      size: 0.13,
      transparent: true,
    })
  );
  scene.add(dust);

  const shaftMaterial = new THREE.MeshBasicMaterial({
    color: "#c5e2cc",
    depthWrite: false,
    opacity: 0.025,
    side: THREE.DoubleSide,
    transparent: true,
  });
  const shafts: THREE.Mesh[] = [];
  const shaftPositions: [number, number, number][] = [
    [-24, 9, 11],
    [19, -12, 8],
    [42, 28, 14],
  ];
  for (const [x, y, radius] of shaftPositions) {
    const shaft = new THREE.Mesh(
      new THREE.ConeGeometry(radius, 80, 16, 1, true),
      shaftMaterial
    );
    shaft.position.set(x, y, 25);
    shaft.rotation.x = Math.PI / 2;
    scene.add(shaft);
    shafts.push(shaft);
  }

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500);
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

  const render = () => {
    renderer.render(scene, camera);
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
  return () => {
    disposed = true;
    observer.disconnect();
    controls.dispose();
    ship.dispose();
    if (model) {
      disposeModel(model);
    }
    floorGeometry.dispose();
    (floor.material as THREE.Material).dispose();
    rockGeometry.dispose();
    rockMaterial.dispose();
    timberGeometry.dispose();
    timberMaterial.dispose();
    shafts.forEach((shaft) => {
      shaft.geometry.dispose();
    });
    shaftMaterial.dispose();
    dustGeometry.dispose();
    (dust.material as THREE.Material).dispose();
    light.shadow.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
