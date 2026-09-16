import { describe, expect, it } from "vitest";

import { authorizationAddress, encodeAddress } from "../config/authorization";
import { addressDigest } from "../config/authorization/digest";

const CAPABILITY = {
  constraintsDigest: "abc",
  id: "web_fetch",
  namespace: "studio.tool",
  version: 1,
};

describe("encodeAddress", () => {
  it("pins the canonical encoding", () => {
    expect(
      encodeAddress(
        authorizationAddress(
          { id: "chat", namespace: "agent-preset", version: 3 },
          CAPABILITY
        )
      )
    ).toBe(
      'foundry.authorization|1|"agent-preset"|"chat"|3|"studio.tool"|"web_fetch"|1|"abc"'
    );
  });

  it("encodes absent optional members as a member no value can produce", () => {
    expect(
      encodeAddress(
        authorizationAddress(
          { id: "chat", namespace: "agent-preset" },
          { id: "web_fetch", namespace: "studio.tool", version: 1 }
        )
      )
    ).toBe(
      'foundry.authorization|1|"agent-preset"|"chat"|-|"studio.tool"|"web_fetch"|1|-'
    );
  });

  it("separates a subject with no generation from generation zero", () => {
    const none = authorizationAddress(
      { id: "chat", namespace: "agent-preset" },
      CAPABILITY
    );
    const zero = authorizationAddress(
      { id: "chat", namespace: "agent-preset", version: 0 },
      CAPABILITY
    );
    expect(encodeAddress(none)).not.toBe(encodeAddress(zero));
  });

  it("gives every part of the address the power to change identity", () => {
    const base = authorizationAddress(
      { id: "chat", namespace: "agent-preset", version: 3 },
      CAPABILITY
    );
    const variants = [
      authorizationAddress(
        { id: "chat", namespace: "module-installation", version: 3 },
        CAPABILITY
      ),
      authorizationAddress(
        { id: "canvas", namespace: "agent-preset", version: 3 },
        CAPABILITY
      ),
      authorizationAddress(
        { id: "chat", namespace: "agent-preset", version: 4 },
        CAPABILITY
      ),
      authorizationAddress(
        { id: "chat", namespace: "agent-preset", version: 3 },
        { ...CAPABILITY, namespace: "mcp" }
      ),
      authorizationAddress(
        { id: "chat", namespace: "agent-preset", version: 3 },
        { ...CAPABILITY, id: "web_search" }
      ),
      authorizationAddress(
        { id: "chat", namespace: "agent-preset", version: 3 },
        { ...CAPABILITY, version: 2 }
      ),
      authorizationAddress(
        { id: "chat", namespace: "agent-preset", version: 3 },
        { ...CAPABILITY, constraintsDigest: "def" }
      ),
    ];

    const encoded = new Set([
      encodeAddress(base),
      ...variants.map(encodeAddress),
    ]);
    expect(encoded.size).toBe(variants.length + 1);
  });

  it("is injective even when a field contains the separator or a quote", () => {
    const split = encodeAddress(
      authorizationAddress(
        { id: "c", namespace: "a|b" },
        { id: "i", namespace: "n", version: 1 }
      )
    );
    const shifted = encodeAddress(
      authorizationAddress(
        { id: "b|c", namespace: "a" },
        { id: "i", namespace: "n", version: 1 }
      )
    );
    expect(split).not.toBe(shifted);

    // A field that embeds the exact quote-pipe-quote sequence the encoder uses
    // between fields still cannot forge a field boundary, because JSON escapes
    // the quotes it contains.
    const forged = encodeAddress(
      authorizationAddress(
        { id: "c", namespace: 'a"|"b' },
        { id: "i", namespace: "n", version: 1 }
      )
    );
    const genuine = encodeAddress(
      authorizationAddress(
        { id: "b", namespace: "a" },
        { id: "i", namespace: "n", version: 1 }
      )
    );
    expect(forged).not.toBe(genuine);
  });

  it("ignores member order, since the encoding is positional", () => {
    expect(
      encodeAddress(
        authorizationAddress(
          { id: "chat", namespace: "agent-preset", version: 3 },
          {
            constraintsDigest: "abc",
            id: "web_fetch",
            namespace: "studio.tool",
            version: 1,
          }
        )
      )
    ).toBe(
      encodeAddress(
        authorizationAddress(
          { id: "chat", namespace: "agent-preset", version: 3 },
          CAPABILITY
        )
      )
    );
  });
});

describe("addressDigest", () => {
  it("derives from the encoding, so it inherits its distinctions", () => {
    const chat = authorizationAddress(
      { id: "chat", namespace: "agent-preset", version: 3 },
      CAPABILITY
    );
    const canvas = authorizationAddress(
      { id: "canvas", namespace: "agent-preset", version: 3 },
      CAPABILITY
    );

    expect(addressDigest(chat)).toBe(addressDigest(chat));
    expect(addressDigest(chat)).not.toBe(addressDigest(canvas));
  });

  it("stays a storage-friendly fixed width", () => {
    const digest = addressDigest(
      authorizationAddress(
        { id: "chat", namespace: "agent-preset", version: 3 },
        CAPABILITY
      )
    );
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
  });
});
