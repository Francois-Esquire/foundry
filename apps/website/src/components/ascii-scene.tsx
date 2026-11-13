import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ASCII, EffectComposer } from "@react-three/postprocessing";
import { useEffect, useRef } from "react";
import type { Group } from "three";

export type SculptureShape = "Weave" | "Stack" | "Loop";
interface SceneProps {
  active: boolean;
  onFailure: () => void;
  onReady: () => void;
  shape: SculptureShape;
  turn: number;
}

const stackLevels = [-1.12, -0.56, 0, 0.56, 1.12];

function Form({ active, onFailure, onReady, shape, turn }: SceneProps) {
  const group = useRef<Group>(null);
  const reportReady = useRef<(() => void) | null>(onReady);
  const rotation = useRef(0);
  const { gl, invalidate } = useThree();

  useEffect(() => {
    const canvas = gl.domElement;
    canvas.addEventListener("webglcontextlost", onFailure);
    return () => canvas.removeEventListener("webglcontextlost", onFailure);
  }, [gl, onFailure]);

  useEffect(() => {
    rotation.current = (turn * Math.PI) / 180;
    invalidate();
  }, [turn, invalidate]);

  useFrame((_state, delta) => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the ref is cleared after the first animation frame.
    reportReady.current?.();
    reportReady.current = null;
    if (active) {
      rotation.current += Math.min(delta, 0.05) * 0.16;
    }
    group.current?.rotation.set(0.45, rotation.current + 0.35, -0.2);
  });

  return (
    <group ref={group}>
      {shape === "Weave" && (
        <mesh>
          <torusKnotGeometry args={[1.28, 0.45, 160, 24, 2, 3]} />
          <meshStandardMaterial color="#ffffff" roughness={0.7} />
        </mesh>
      )}
      {shape === "Loop" && (
        <mesh rotation={[0.65, 0.2, 0]}>
          <torusGeometry args={[1.38, 0.61, 32, 96]} />
          <meshStandardMaterial color="#ffffff" roughness={0.7} />
        </mesh>
      )}
      {shape === "Stack" && (
        <group rotation={[0.1, 0, -0.2]}>
          {stackLevels.map((level) => (
            <mesh
              key={level}
              position={[0, level, 0]}
              rotation={[Math.PI / 2, 0, 0]}
            >
              <torusGeometry
                args={[1.35 - Math.abs(level) * 0.25, 0.22, 16, 80]}
              />
              <meshStandardMaterial color="#ffffff" roughness={0.7} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  );
}

export default function AsciiScene(props: SceneProps) {
  return (
    <div className="scene-canvas">
      <Canvas
        camera={{ fov: 39, position: [0, 0, 7] }}
        dpr={1}
        fallback={null}
        frameloop={props.active ? "always" : "demand"}
        gl={{ alpha: false, antialias: false, powerPreference: "low-power" }}
      >
        <color args={["#000000"]} attach="background" />
        <ambientLight intensity={0.35} />
        <directionalLight intensity={3.2} position={[-3, 5, 5]} />
        <directionalLight intensity={0.6} position={[4, -2, 2]} />
        <Form {...props} />
        <EffectComposer enableNormalPass={false} multisampling={0}>
          <ASCII
            cellSize={6}
            characters=" .,:;+=xX$&#@"
            color="#ffffff"
            font="monospace"
            fontSize={64}
          />
        </EffectComposer>
      </Canvas>
    </div>
  );
}
