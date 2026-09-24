export type SandboxDirectoryEntry = {
  id: string;
  siren: string | null;
  siret: string | null;
  electronicAddress: string;
  receptionPa: string | null;
  activeFrom: string | null;
  activeTo: string | null;
  metadata: Record<string, unknown>;
};

export type DirectoryResolution = {
  status: "RESOLVED" | "NOT_FOUND" | "AMBIGUOUS";
  electronicAddress: { scheme: string; value: string } | null;
  receptionPlatform: string | null;
  routingIdentifier: string | null;
  matchedBy: "SIRET" | "SIREN" | null;
  entryId: string | null;
  sourceReference: string | null;
  directoryVersion: string | null;
  synchronizedAt: string | null;
  issues: Array<{ code: string; field: string; message: string }>;
};

function text(value: unknown, max = 200): string {
  return String(value ?? "").trim().slice(0, max);
}

function validOn(entry: SandboxDirectoryEntry, date: string): boolean {
  return (!entry.activeFrom || entry.activeFrom <= date) && (!entry.activeTo || entry.activeTo >= date);
}

function routeKey(entry: SandboxDirectoryEntry): string {
  const metadata = entry.metadata || {};
  return [text(metadata.electronicAddressScheme || "0225", 40), entry.electronicAddress, text(entry.receptionPa), text(metadata.routingIdentifier)].join("|");
}

export function resolveSandboxDirectory(
  entries: SandboxDirectoryEntry[],
  input: { siren?: string; siret?: string; serviceCode?: string },
  today = new Date().toISOString().slice(0, 10),
): DirectoryResolution {
  const siren = text(input.siren, 9);
  const siret = text(input.siret, 14);
  const serviceCode = text(input.serviceCode, 80);
  const active = entries.filter((entry) => validOn(entry, today));
  const bySiret = siret ? active.filter((entry) => entry.siret === siret) : [];
  const bySiren = bySiret.length || !siren ? [] : active.filter((entry) => entry.siren === siren);
  const candidates = bySiret.length ? bySiret : bySiren;
  const matchedBy = bySiret.length ? "SIRET" : bySiren.length ? "SIREN" : null;
  const serviceMatches = serviceCode
    ? candidates.filter((entry) => !text(entry.metadata.serviceCode) || text(entry.metadata.serviceCode) === serviceCode)
    : candidates;
  const usable = serviceMatches.length ? serviceMatches : candidates;
  const routes = new Map(usable.map((entry) => [routeKey(entry), entry]));

  if (routes.size === 1) {
    const entry = [...routes.values()][0];
    return {
      status: "RESOLVED",
      electronicAddress: { scheme: text(entry.metadata.electronicAddressScheme || "0225", 40), value: entry.electronicAddress },
      receptionPlatform: entry.receptionPa,
      routingIdentifier: text(entry.metadata.routingIdentifier) || null,
      matchedBy,
      entryId: entry.id,
      sourceReference: text(entry.metadata.sourceReference) || null,
      directoryVersion: text(entry.metadata.directoryVersion) || null,
      synchronizedAt: text(entry.metadata.synchronizedAt) || null,
      issues: [],
    };
  }
  if (routes.size > 1) {
    return {
      status: "AMBIGUOUS", electronicAddress: null, receptionPlatform: null, routingIdentifier: null,
      matchedBy, entryId: null, sourceReference: null, directoryVersion: null, synchronizedAt: null,
      issues: [{ code: "D2F_DIRECTORY_AMBIGUOUS", field: "recipient.identifiers", message: "Several active sandbox directory lines resolve the recipient to different routes." }],
    };
  }
  return {
    status: "NOT_FOUND", electronicAddress: null, receptionPlatform: null, routingIdentifier: null,
    matchedBy: null, entryId: null, sourceReference: null, directoryVersion: null, synchronizedAt: null,
    issues: [{ code: "D2F_DIRECTORY_NOT_FOUND", field: "recipient.identifiers", message: "No active sandbox directory line matches the supplied SIREN/SIRET. No routing address was invented." }],
  };
}
