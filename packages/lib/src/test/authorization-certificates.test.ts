import { beforeEach, describe, expect, it } from "vitest";

import type {
  AuthorizationCertificate,
  AuthorizationProfile,
  AuthorizationSubject,
  CertificateRepository,
  GrantRepository,
} from "../config/authorization";
import {
  CertificateVersionError,
  certificateForProfile,
  createInMemoryCertificateRepository,
  createInMemoryGrantRepository,
} from "../config/authorization";
import type { TestCapability } from "./helpers/authorization-support";
import {
  fsRead,
  preset,
  testAddressing,
  testClock,
  toolCall,
} from "./helpers/authorization-support";

const addressing = testAddressing();
const SUBJECT = preset("chat", 3);
const ISSUER: AuthorizationSubject = { id: "composition", namespace: "studio" };

const PROFILE: AuthorizationProfile<TestCapability> = {
  grants: [
    { capability: fsRead("/workspace"), lifetime: { kind: "persistent" } },
    { capability: toolCall("web_fetch"), lifetime: { kind: "persistent" } },
  ],
  id: "chat-tools",
  version: 2,
};

describe("profiles and certificates", () => {
  let clock: ReturnType<typeof testClock>;
  let grants: GrantRepository<AuthorizationSubject, TestCapability>;
  let certificates: CertificateRepository<AuthorizationSubject, TestCapability>;

  function issuedTo(
    subject: AuthorizationSubject,
    capability: TestCapability
  ): Promise<readonly unknown[]> {
    return grants.find(addressing.addressOf(subject, capability), clock.now());
  }

  function certificate(
    id: string,
    profile: AuthorizationProfile<TestCapability> = PROFILE,
    subject: AuthorizationSubject = SUBJECT
  ): AuthorizationCertificate<AuthorizationSubject, TestCapability> {
    return certificateForProfile({
      id,
      issuedAt: clock.now(),
      issuer: ISSUER,
      profile,
      subject,
    });
  }

  beforeEach(() => {
    clock = testClock();
    grants = createInMemoryGrantRepository({ now: clock.now });
    certificates = createInMemoryCertificateRepository({ addressing, grants });
  });

  describe("certificateForProfile", () => {
    it("binds an authored profile to one subject and issuer", () => {
      const bound = certificate("cert-1");

      expect(bound.subject).toEqual(SUBJECT);
      expect(bound.issuer).toEqual(ISSUER);
      expect(bound.profileId).toBe("chat-tools");
      expect(bound.grants).toEqual(PROFILE.grants);
    });

    it("records which revision of the profile it came from", () => {
      expect(certificate("cert-1").version).toBe(PROFILE.version);
    });

    it("confers nothing until a repository issues it", async () => {
      certificate("cert-1");
      await expect(issuedTo(SUBJECT, fsRead("/workspace"))).resolves.toEqual(
        []
      );
    });
  });

  describe("issuance", () => {
    it("derives one grant per specification, addressed to the subject", async () => {
      const issued = await certificates.issue(certificate("cert-1"));

      expect(issued).toHaveLength(2);
      await expect(
        issuedTo(SUBJECT, fsRead("/workspace"))
      ).resolves.toHaveLength(1);
      await expect(
        issuedTo(SUBJECT, toolCall("web_fetch"))
      ).resolves.toHaveLength(1);
    });

    it("marks the derived grants with their provenance and certificate", async () => {
      const issued = await certificates.issue(certificate("cert-1"));

      for (const grant of issued) {
        expect(grant.provenance).toBe("certificate");
        expect(grant.certificateId).toBe("cert-1");
      }
    });

    it("grants nothing to a different subject", async () => {
      await certificates.issue(certificate("cert-1"));

      await expect(
        issuedTo(preset("canvas", 1), fsRead("/workspace"))
      ).resolves.toEqual([]);
    });

    it("grants nothing to a later generation of the same preset", async () => {
      await certificates.issue(certificate("cert-1"));

      await expect(
        issuedTo(preset("chat", 4), fsRead("/workspace"))
      ).resolves.toEqual([]);
    });

    it("stores the certificate for later inspection", async () => {
      await certificates.issue(certificate("cert-1"));

      const stored = await certificates.get("cert-1");
      expect(stored?.profileId).toBe("chat-tools");
      expect(await certificates.get("cert-absent")).toBeNull();
    });

    it("lets several live certificates contribute authority at one address", async () => {
      await certificates.issue(certificate("cert-1"));
      await certificates.issue(
        certificate("cert-2", {
          grants: [
            {
              capability: fsRead("/workspace"),
              lifetime: { kind: "persistent" },
            },
          ],
          id: "extra-tools",
          version: 1,
        })
      );

      await expect(
        issuedTo(SUBJECT, fsRead("/workspace"))
      ).resolves.toHaveLength(2);
    });

    it("replaces its own previous authority when re-issued", async () => {
      await certificates.issue(certificate("cert-1"));
      await certificates.issue(
        certificate("cert-1", {
          grants: [
            {
              capability: fsRead("/workspace"),
              lifetime: { kind: "persistent" },
            },
          ],
          id: "chat-tools",
          version: 3,
        })
      );

      // The capability dropped from the profile must not survive the re-issue.
      await expect(
        issuedTo(SUBJECT, fsRead("/workspace"))
      ).resolves.toHaveLength(1);
      await expect(issuedTo(SUBJECT, toolCall("web_fetch"))).resolves.toEqual(
        []
      );
    });
  });

  describe("revocation", () => {
    it("removes the authority that certificate contributed", async () => {
      await certificates.issue(certificate("cert-1"));
      await certificates.revoke("cert-1");

      await expect(issuedTo(SUBJECT, fsRead("/workspace"))).resolves.toEqual(
        []
      );
      await expect(certificates.get("cert-1")).resolves.toBeNull();
    });

    it("leaves another certificate's authority alone", async () => {
      await certificates.issue(certificate("cert-1"));
      await certificates.issue(
        certificate("cert-2", {
          grants: [
            {
              capability: fsRead("/workspace"),
              lifetime: { kind: "persistent" },
            },
          ],
          id: "extra-tools",
          version: 1,
        })
      );

      await certificates.revoke("cert-1");
      await expect(
        issuedTo(SUBJECT, fsRead("/workspace"))
      ).resolves.toHaveLength(1);
    });

    /**
     * Revoking a certificate withdraws what the *host* issued. A human who
     * separately approved the same capability said something the host does not
     * get to retract on their behalf.
     */
    it("leaves a human's own decision on the same capability standing", async () => {
      await certificates.issue(certificate("cert-1"));
      await grants.issue({
        address: addressing.addressOf(SUBJECT, fsRead("/workspace")),
        capability: fsRead("/workspace"),
        lifetime: { kind: "persistent" },
        provenance: "human",
      });

      await certificates.revoke("cert-1");

      const surviving = await grants.find(
        addressing.addressOf(SUBJECT, fsRead("/workspace")),
        clock.now()
      );
      expect(surviving).toHaveLength(1);
      expect(surviving[0]?.provenance).toBe("human");
    });

    it("rejects a version that is no longer current", async () => {
      await certificates.issue(certificate("cert-1"));

      await expect(certificates.revoke("cert-1", 1)).rejects.toBeInstanceOf(
        CertificateVersionError
      );
      // The rejected revoke changed nothing.
      await expect(
        issuedTo(SUBJECT, fsRead("/workspace"))
      ).resolves.toHaveLength(1);
    });

    it("accepts the current version", async () => {
      await certificates.issue(certificate("cert-1"));

      await expect(
        certificates.revoke("cert-1", PROFILE.version)
      ).resolves.toBeUndefined();
    });

    it("succeeds for a certificate that was never issued", async () => {
      await expect(certificates.revoke("cert-absent")).resolves.toBeUndefined();
    });
  });
});
