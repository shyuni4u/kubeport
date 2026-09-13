import { describe, it, expect } from "vitest";

import { releaseStorage } from "./release-storage";

const statefulSet = (policy: string) => `apiVersion: apps/v1
kind: StatefulSet
metadata: { name: db }
spec:
${policy}  volumeClaimTemplates:
    - metadata: { name: data }
      spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 1Gi } } }
`;

const service = `apiVersion: v1
kind: Service
metadata: { name: db }
spec: { ports: [{ port: 80 }] }
`;

describe("releaseStorage (#340)", () => {
  it("is deleted when a StatefulSet's claims go with it", () => {
    expect(releaseStorage(statefulSet("  persistentVolumeClaimRetentionPolicy: { whenDeleted: Delete }\n"))).toBe(
      "deleted",
    );
  });

  it("is kept when the template retains them, or wrote no policy (applied before the default)", () => {
    expect(releaseStorage(statefulSet("  persistentVolumeClaimRetentionPolicy: { whenDeleted: Retain }\n"))).toBe(
      "kept",
    );
    expect(releaseStorage(statefulSet(""))).toBe("kept");
  });

  it("says deleted when any one StatefulSet deletes, among several documents", () => {
    const retain = statefulSet("  persistentVolumeClaimRetentionPolicy: { whenDeleted: Retain }\n");
    const del = statefulSet("  persistentVolumeClaimRetentionPolicy: { whenDeleted: Delete }\n").replace(
      "name: db",
      "name: cache",
    );
    expect(releaseStorage([service, retain, del].join("---\n"))).toBe("deleted");
  });

  it("is none without StatefulSet storage", () => {
    expect(releaseStorage(service)).toBe("none");
    expect(
      releaseStorage(`apiVersion: apps/v1
kind: StatefulSet
metadata: { name: db }
spec:
  persistentVolumeClaimRetentionPolicy: { whenDeleted: Delete }
  volumeClaimTemplates: []
`),
    ).toBe("none");
    expect(
      releaseStorage(`apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: data }
spec: { accessModes: [ReadWriteOnce] }
`),
    ).toBe("none");
  });

  it("is none with nothing readable", () => {
    expect(releaseStorage(undefined)).toBe("none");
    expect(releaseStorage("")).toBe("none");
    expect(releaseStorage("kind: StatefulSet\nspec: [unclosed")).toBe("none");
  });
});
