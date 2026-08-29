interface FreeModelProfile {
  modality: string;
  reasoning: boolean;
  tools: boolean;
  toolChoice: boolean;
  structuredOutput: boolean;
  vision: boolean;
  code: boolean;
  longContext: boolean;
  canAgent: boolean;
  role: string;
  strengths: string[];
  warnings: string[];
  verdict: string;
}

export interface FreeModelEntry {
  id: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  supported: string;
  profile: FreeModelProfile;
}

export interface FreeModelSummary {
  total: number;
  agentCount: number;
  qaOnly: number;
  bestAgent: { id: string; name: string; verdict: string; strengths: string[] } | null;
  codingAgent: string | null;
  visionAgent: string | null;
  longContextAgent: string | null;
}

export interface FreeModelDetect {
  platform: string;
  endpoint: string;
  models: FreeModelEntry[];
  total: number;
  summary: FreeModelSummary;
}
