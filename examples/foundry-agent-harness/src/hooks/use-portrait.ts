import { fileURLToPath } from "node:url";
import { NativeImage } from "@opentui/core";
import { useEffect, useMemo, useState } from "react";
import {
  type PortraitMoment,
  type PortraitScene,
  paintPortrait,
  portraitScene,
} from "@/model/portrait";
import type { SpriteSheet } from "@/model/sprite";

const atlases = new Map<string, Promise<Uint8Array>>();

async function decode(file: string): Promise<Uint8Array> {
  const image = await NativeImage.load(
    fileURLToPath(new URL(`../assets/avatars/${file}`, import.meta.url))
  );
  try {
    const { data, height, stride, width } = image.raw("rgba8");
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      pixels.set(
        data.subarray(y * stride, y * stride + width * 4),
        y * width * 4
      );
    }
    return pixels;
  } finally {
    image.dispose();
  }
}

function atlasOf(sheet: SpriteSheet): Promise<Uint8Array> {
  const loading = atlases.get(sheet.file) ?? decode(sheet.file);
  atlases.set(sheet.file, loading);
  return loading;
}

function develop(
  sheet: SpriteSheet,
  atlas: Uint8Array,
  scene: PortraitScene
): NativeImage {
  return NativeImage.fromRgba(
    paintPortrait(sheet, atlas, scene),
    sheet.cell,
    sheet.cell
  );
}

export async function portraitImage(
  moment: PortraitMoment
): Promise<NativeImage> {
  const { sheet } = moment.avatar;
  return develop(sheet, await atlasOf(sheet), portraitScene(moment));
}

export function usePortrait(moment: PortraitMoment): NativeImage | null {
  const { sheet } = moment.avatar;
  const [loaded, setLoaded] = useState<{
    readonly atlas: Uint8Array;
    readonly sheet: SpriteSheet;
  } | null>(null);
  useEffect(() => {
    let current = true;
    atlasOf(sheet).then((atlas) => {
      if (current) {
        setLoaded({ atlas, sheet });
      }
    });
    return () => {
      current = false;
    };
  }, [sheet]);
  const next = portraitScene(moment);
  const [scene, setScene] = useState(next);
  if (JSON.stringify(scene) !== JSON.stringify(next)) {
    setScene(next);
  }
  const image = useMemo(
    () =>
      loaded?.sheet === sheet ? develop(sheet, loaded.atlas, scene) : null,
    [loaded, scene, sheet]
  );
  useEffect(() => () => image?.dispose(), [image]);
  return image;
}
