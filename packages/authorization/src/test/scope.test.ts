import { describe, expect, it } from "vitest";
import {
  type AccessRequest,
  covers,
  matchesPrincipal,
  narrows,
  type Principal,
  type Scope,
} from "../index";
import { boundNarrows, isDirectPrincipalGrant } from "../scope";

const AGENT: Principal = {
  attributes: { department: "eng", level: 3 },
  id: "agent-1",
  kind: "agent",
  version: "1.0.0",
};

function request(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    action: "shell.exec",
    principal: AGENT,
    target: "/workspace",
    ...overrides,
  };
}

describe("matchesPrincipal", () => {
  it("supports any, exact (with optional version), and attribute-matched principals", () => {
    expect(matchesPrincipal({ kind: "any" }, AGENT)).toBe(true);
    expect(
      matchesPrincipal(
        { kind: "exact", principal: { id: "agent-1", kind: "agent" } },
        AGENT
      )
    ).toBe(true);
    expect(
      matchesPrincipal(
        {
          kind: "exact",
          principal: { id: "agent-1", kind: "agent", version: "1.0.0" },
        },
        AGENT
      )
    ).toBe(true);
    expect(
      matchesPrincipal(
        {
          kind: "exact",
          principal: { id: "agent-1", kind: "agent", version: "2.0.0" },
        },
        AGENT
      )
    ).toBe(false);
    expect(
      matchesPrincipal(
        {
          attributes: {
            department: { op: "eq", value: "eng" },
            level: { max: 5, min: 2, op: "range" },
          },
          kind: "match",
          principalKind: "agent",
        },
        AGENT
      )
    ).toBe(true);
  });

  it("handles missing principal attributes fail-closed on allow and conservatively on restrictive", () => {
    const unversioned: Principal = { id: "agent-1", kind: "agent" };
    const matcher = {
      attributes: { department: { op: "eq", value: "eng" } },
      kind: "match",
      principalKind: "agent",
    } as const;
    const versionedExact = {
      kind: "exact",
      principal: { id: "agent-1", kind: "agent", version: "1.0.0" },
    } as const;

    expect(matchesPrincipal(matcher, unversioned, "allow")).toBe(false);
    expect(matchesPrincipal(matcher, unversioned, "restrictive")).toBe(true);
    expect(matchesPrincipal(versionedExact, unversioned, "allow")).toBe(false);
    expect(matchesPrincipal(versionedExact, unversioned, "restrictive")).toBe(
      true
    );
  });

  it("distinguishes direct exact principal grants from broad matchers", () => {
    expect(
      isDirectPrincipalGrant(
        { kind: "exact", principal: { id: "agent-1", kind: "agent" } },
        AGENT
      )
    ).toBe(true);
    expect(isDirectPrincipalGrant({ kind: "any" }, AGENT)).toBe(false);
    expect(
      isDirectPrincipalGrant({ kind: "match", principalKind: "agent" }, AGENT)
    ).toBe(false);
  });
});

describe("covers allow vs restrictive semantics", () => {
  it("fails closed on missing attributes in allow mode and matches them in restrictive mode", () => {
    const scope: Scope = {
      action: "expense.approve",
      constraints: {
        amount: { max: 500, min: 0, op: "range" },
        currency: { op: "in", values: ["USD", "EUR"] },
      },
      target: { kind: "prefix", value: "dept/eng/" },
    };

    expect(
      covers(
        scope,
        request({
          action: "expense.approve",
          attributes: { amount: 250, currency: "USD" },
          target: "dept/eng/travel",
        }),
        "allow"
      )
    ).toBe(true);
    expect(
      covers(
        scope,
        request({
          action: "expense.approve",
          attributes: { amount: 250 },
          target: "dept/eng/travel",
        }),
        "allow"
      )
    ).toBe(false);
    expect(
      covers(
        scope,
        request({
          action: "expense.approve",
          attributes: { amount: 250 },
          target: "dept/eng/travel",
        }),
        "restrictive"
      )
    ).toBe(true);
    expect(
      covers(
        scope,
        request({
          action: "expense.approve",
          attributes: { amount: 250, currency: "GBP" },
          target: "dept/eng/travel",
        }),
        "restrictive"
      )
    ).toBe(false);
  });

  it("enforces constraintsDigest in allow vs restrictive mode", () => {
    const scope: Scope = {
      action: "module.invoke",
      constraintsDigest: "sha256:abc",
      target: { kind: "exact", value: "net.fetch" },
    };

    expect(
      covers(
        scope,
        request({
          action: "module.invoke",
          constraintsDigest: "sha256:abc",
          target: "net.fetch",
        }),
        "allow"
      )
    ).toBe(true);
    expect(
      covers(
        scope,
        request({ action: "module.invoke", target: "net.fetch" }),
        "allow"
      )
    ).toBe(false);
    expect(
      covers(
        scope,
        request({ action: "module.invoke", target: "net.fetch" }),
        "restrictive"
      )
    ).toBe(true);
    expect(
      covers(
        scope,
        request({
          action: "module.invoke",
          constraintsDigest: "sha256:other",
          target: "net.fetch",
        }),
        "restrictive"
      )
    ).toBe(false);
  });

  it("matches domainSuffix on apex and subdomains without suffix confusion", () => {
    const apexScope: Scope = {
      action: "net.fetch",
      constraints: { host: { op: "domainSuffix", value: "example.com" } },
      target: { kind: "any" },
    };
    const subOnlyScope: Scope = {
      action: "net.fetch",
      constraints: { host: { op: "domainSuffix", value: ".example.com" } },
      target: { kind: "any" },
    };

    expect(
      covers(
        apexScope,
        request({ action: "net.fetch", attributes: { host: "example.com" } })
      )
    ).toBe(true);
    expect(
      covers(
        apexScope,
        request({
          action: "net.fetch",
          attributes: { host: "API.Example.COM" },
        })
      )
    ).toBe(true);
    expect(
      covers(
        apexScope,
        request({ action: "net.fetch", attributes: { host: "badexample.com" } })
      )
    ).toBe(false);
    expect(
      covers(
        subOnlyScope,
        request({ action: "net.fetch", attributes: { host: "example.com" } })
      )
    ).toBe(false);
    expect(
      covers(
        subOnlyScope,
        request({
          action: "net.fetch",
          attributes: { host: "api.example.com" },
        })
      )
    ).toBe(true);
  });

  it("fails closed on malformed or wrongly typed attributes in restrictive mode", () => {
    const denyDomain: Scope = {
      action: "http.fetch",
      constraints: { host: { op: "domainSuffix", value: "internal.corp" } },
      target: { kind: "any" },
    };
    for (const host of [
      "db.internal.corp",
      "db.internal.corp.",
      "db.internal.corp:5432",
      ["db.internal.corp"],
    ]) {
      expect(
        covers(
          denyDomain,
          request({ action: "http.fetch", attributes: { host } }),
          "restrictive"
        )
      ).toBe(true);
    }

    const denyLargeAmount: Scope = {
      action: "expense.submit",
      constraints: { amount: { min: 1000, op: "range" } },
      target: { kind: "any" },
    };
    expect(
      covers(
        denyLargeAmount,
        request({ action: "expense.submit", attributes: { amount: "5000" } }),
        "restrictive"
      )
    ).toBe(true);
    expect(
      covers(
        denyLargeAmount,
        request({ action: "expense.submit", attributes: { amount: 500 } }),
        "restrictive"
      )
    ).toBe(false);
  });
});

describe("commandPrefix security", () => {
  const gitScope: Scope = {
    action: "shell.exec",
    constraints: { command: { op: "commandPrefix", value: "git status" } },
    target: { kind: "any" },
  };

  it("allows exact or word-bounded commands without shell control characters", () => {
    expect(
      covers(
        gitScope,
        request({ attributes: { command: "git status" } }),
        "allow"
      )
    ).toBe(true);
    expect(
      covers(
        gitScope,
        request({ attributes: { command: "git status --short" } }),
        "allow"
      )
    ).toBe(true);
    expect(
      covers(
        gitScope,
        request({ attributes: { command: "git statusful" } }),
        "allow"
      )
    ).toBe(false);
  });

  it.each([
    "git status; rm -rf /",
    "git status && rm -rf /",
    "git status | cat",
    "git status > /tmp/out",
    "git status < /etc/passwd",
    "git status `whoami`",
    "git status $(whoami)",
    "git status\nrm -rf /",
    "git status\rrm -rf /",
    "git status \\n",
    " git status",
    "git  status",
    "git\tstatus",
    "git status ",
  ])("rejects unsafe command %j in allow mode", (command) => {
    expect(
      covers(gitScope, request({ attributes: { command } }), "allow")
    ).toBe(false);
  });

  it("catches disguised commands in restrictive mode", () => {
    const denyRm: Scope = {
      action: "shell.exec",
      constraints: { command: { op: "commandPrefix", value: "rm -rf" } },
      target: { kind: "any" },
    };

    expect(
      covers(
        denyRm,
        request({ attributes: { command: "  rm  -rf /tmp/x" } }),
        "restrictive"
      )
    ).toBe(true);
    expect(
      covers(
        denyRm,
        request({ attributes: { command: "echo ok && rm -rf /" } }),
        "restrictive"
      )
    ).toBe(true);
    expect(
      covers(
        denyRm,
        request({ attributes: { command: "git status" } }),
        "restrictive"
      )
    ).toBe(false);
  });
});

describe("narrows lattice partial order", () => {
  it("verifies target and constraint narrowing and allows extra child constraints", () => {
    const parent: Scope = {
      action: "expense.approve",
      constraints: {
        amount: { max: 5000, min: 0, op: "range" },
        currency: { op: "in", values: ["USD", "EUR"] },
        host: { op: "domainSuffix", value: "corp.example" },
      },
      target: { kind: "prefix", value: "dept/" },
    };
    const child: Scope = {
      action: "expense.approve",
      constraints: {
        amount: { max: 1000, min: 0, op: "range" },
        category: { op: "eq", value: "travel" },
        currency: { op: "eq", value: "USD" },
        host: { op: "domainSuffix", value: "billing.corp.example" },
      },
      target: { kind: "exact", value: "dept/eng" },
    };

    expect(narrows(child, parent)).toBe(true);
    expect(narrows(parent, child)).toBe(false);
  });

  it("rejects mismatched actions, missing parent constraints, and widened bounds", () => {
    const parent: Scope = {
      action: "expense.approve",
      constraints: { amount: { max: 1000, op: "range" } },
      target: { kind: "prefix", value: "dept/" },
    };

    expect(narrows({ ...parent, action: "expense.pay" }, parent)).toBe(false);
    expect(
      narrows({ action: parent.action, target: parent.target }, parent)
    ).toBe(false);
    expect(
      narrows(
        {
          ...parent,
          constraints: { amount: { max: 2000, op: "range" } },
        },
        parent
      )
    ).toBe(false);
    expect(
      narrows(
        {
          ...parent,
          target: { kind: "any" },
        },
        parent
      )
    ).toBe(false);
  });

  it("checks commandPrefix and domainSuffix narrowing strictly", () => {
    expect(
      boundNarrows(
        { op: "commandPrefix", value: "git status" },
        { op: "commandPrefix", value: "git" }
      )
    ).toBe(true);
    expect(
      boundNarrows(
        { op: "commandPrefix", value: "gitignore" },
        { op: "commandPrefix", value: "git" }
      )
    ).toBe(false);
    expect(
      boundNarrows(
        { op: "eq", value: "git status; rm -rf /" },
        { op: "commandPrefix", value: "git" }
      )
    ).toBe(false);
    expect(
      boundNarrows(
        { op: "domainSuffix", value: "api.example.com" },
        { op: "domainSuffix", value: "example.com" }
      )
    ).toBe(true);
    expect(
      boundNarrows(
        { op: "domainSuffix", value: "badexample.com" },
        { op: "domainSuffix", value: "example.com" }
      )
    ).toBe(false);
    expect(
      boundNarrows(
        { op: "prefix", value: "https://example.com" },
        { op: "domainSuffix", value: "example.com" }
      )
    ).toBe(false);
  });

  it("fails closed on constraintsDigest unless equal or proven by isNarrowerDigest", () => {
    const parent: Scope = {
      action: "module.invoke",
      constraintsDigest: "digest-wide",
      target: { kind: "exact", value: "cap" },
    };
    const child: Scope = {
      action: "module.invoke",
      constraintsDigest: "digest-narrow",
      target: { kind: "exact", value: "cap" },
    };

    expect(
      narrows({ action: "module.invoke", target: parent.target }, parent)
    ).toBe(false);
    expect(narrows(parent, parent)).toBe(true);
    expect(narrows(child, parent)).toBe(false);
    expect(
      narrows(child, parent, {
        isNarrowerDigest: (p, c) =>
          p === "digest-wide" && c === "digest-narrow",
      })
    ).toBe(true);
  });
});
