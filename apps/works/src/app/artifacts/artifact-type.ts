import type { ArtifactBase } from "@foundry/artifacts/registry";
import {
  FileAudioIcon,
  FileBracesIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FileVideoIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import type { ArtifactSummary } from "~/shared/artifacts";

interface ArtifactKind {
  icon: ComponentType<{ className?: string }>;
  label: string;
}

const KINDS: Readonly<Record<ArtifactBase, ArtifactKind>> = {
  audio: { icon: FileAudioIcon, label: "Audio" },
  html: { icon: FileCodeIcon, label: "Web page" },
  image: { icon: FileImageIcon, label: "Image" },
  structured: { icon: FileBracesIcon, label: "Data" },
  text: { icon: FileTextIcon, label: "Text" },
  video: { icon: FileVideoIcon, label: "Video" },
};

/**
 * A recognizable label and fallback icon. An unrecognized type stays visible
 * under its own MIME type rather than a guessed family.
 */
export function artifactKind(artifact: ArtifactSummary): ArtifactKind {
  return artifact.base === null
    ? { icon: FileIcon, label: artifact.type }
    : KINDS[artifact.base];
}
