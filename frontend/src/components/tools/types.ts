import type { ToolCallImage } from '../toolArtifacts';

export interface ToolResultProps {
  data: any;
  artifactImages?: ToolCallImage[];
}
