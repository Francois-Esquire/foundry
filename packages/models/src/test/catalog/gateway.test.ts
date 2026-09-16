import { describe, expect, it } from "vitest";

import type { GatewayModelGroup } from "../../catalog/index";

import { fromGateway } from "../../catalog/index";

// Representative LiteLLM /model_group/info rows.
const CHAT: GatewayModelGroup = {
  input_cost_per_token: 1.5e-7,
  max_input_tokens: 1_048_576,
  max_output_tokens: 8192,
  mode: "chat",
  model_group: "gemini-2.0-flash",
  output_cost_per_token: 6e-7,
  providers: ["vertex_ai"],
  supported_openai_params: ["temperature", "top_p", "max_tokens", "tools"],
  supports_function_calling: true,
  supports_reasoning: false,
  supports_vision: true,
  supports_web_search: true,
};

const RESPONSES: GatewayModelGroup = {
  input_cost_per_token: 2e-5,
  max_input_tokens: 200_000,
  max_output_tokens: 100_000,
  mode: "responses",
  model_group: "azure-o3-pro",
  output_cost_per_token: 8e-5,
  providers: ["azure"],
  supports_reasoning: true,
};

const EMBEDDING: GatewayModelGroup = {
  input_cost_per_token: 1e-7,
  max_input_tokens: 2048,
  mode: "embedding",
  model_group: "text-embedding-005",
  output_cost_per_token: 0,
  providers: ["vertex_ai"],
};

// Ungroomed registry stub: null mode, zero costs, no limits.
const STUB: GatewayModelGroup = {
  input_cost_per_token: 0,
  mode: null,
  model_group: "gemini-1.5-pro",
  output_cost_per_token: 0,
  providers: ["vertex_ai"],
};

const ZERO_COST_CHAT: GatewayModelGroup = {
  input_cost_per_token: 0,
  mode: "chat",
  model_group: "mystery-chat",
  output_cost_per_token: 0,
};

describe("fromGateway", () => {
  it("normalizes per-token numeric pricing to USD per 1M tokens", () => {
    const [row] = fromGateway([CHAT]);
    expect(row?.costs?.input).toBeCloseTo(0.15, 9);
    expect(row?.costs?.output).toBeCloseTo(0.6, 9);
  });

  it("maps chat and responses modes to text, embedding to embedding", () => {
    const rows = fromGateway([CHAT, RESPONSES, EMBEDDING]);
    expect(rows.map((r) => r.kind)).toEqual(["text", "text", "embedding"]);
    expect(rows[0]?.vendor).toBe("vertex_ai");
  });

  it("drops null-mode registry stubs", () => {
    expect(fromGateway([STUB])).toEqual([]);
  });

  it("treats 0/0 pricing as unknown, not free — costs omitted, row kept", () => {
    const [row] = fromGateway([ZERO_COST_CHAT]);
    expect(row).toBeDefined();
    expect(row?.costs).toBeUndefined();
  });

  it("keeps a genuine zero output cost when input pricing is real", () => {
    const [row] = fromGateway([EMBEDDING]);
    expect(row?.costs?.input).toBeCloseTo(0.1, 9);
    expect(row?.costs?.output).toBe(0);
  });

  it("distinguishes a stated false from a flag the gateway never mentioned", () => {
    const [chat, responses] = fromGateway([CHAT, RESPONSES]);
    // CHAT says `supports_reasoning: false` outright, so that survives as
    // `false` rather than collapsing into the same silence as the flags it
    // simply never sent. Enrichment from an outside catalog fills absences and
    // only absences — flattening the two here is what would let community data
    // contradict the gateway actually serving the model.
    expect(chat?.capabilities).toEqual({
      functionCalling: true,
      reasoning: false,
      vision: true,
      webSearch: true,
    });
    // RESPONSES mentions reasoning alone; the rest stay absent, not false.
    expect(responses?.capabilities).toEqual({ reasoning: true });
  });

  it("captures supported_openai_params, omitting when absent or empty", () => {
    const [chat, embedding] = fromGateway([CHAT, EMBEDDING]);
    expect(chat?.params).toEqual([
      "temperature",
      "top_p",
      "max_tokens",
      "tools",
    ]);
    expect(embedding?.params).toBeUndefined();
  });

  it("maps token limits, omitting nulls", () => {
    const rows = fromGateway([CHAT, EMBEDDING]);
    expect(rows[0]?.limits).toEqual({
      maxInputTokens: 1_048_576,
      maxOutputTokens: 8192,
    });
    expect(rows[1]?.limits).toEqual({ maxInputTokens: 2048 });
  });
});
