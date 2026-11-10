/**
 * The browser adapter for evidence: the only file in this context that needs
 * a browser. It reads a picked or dropped file and decodes it with the canvas
 * codec that generation already owns.
 */
import { browserImageCodec } from "~/generation/browser-image-codec";
import { type Evidence, importEvidence, mediaTypeFor } from "./evidence";

export const importEvidenceInBrowser = async (file: File): Promise<Evidence> =>
  importEvidence(
    {
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName: file.name,
      mediaType: file.type || mediaTypeFor(file.name),
    },
    browserImageCodec
  );
