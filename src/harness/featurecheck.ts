// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Checks a project's feature map against verification records. A record names the
 * feature and the entry point it CLAIMS and the one it USED, with evidence. A record through another entry point than
 * the claimed one is refused. An entry point with no accepted record is listed as unverified, and one marked
 * unreachable needs its prerequisite and the route tried; it is never reported as passed through a different path.
 */

export type Feature = { id: string; entryPoints: string[]; words: string };
export type VerificationRecord = {
  featureId: string;
  claimedEntryPoint: string;
  usedEntryPoint: string;
  status: "verified" | "unreachable";
  evidence: string;
  prerequisite?: string;
  routeTried?: string;
};
export type Refusal = { record: VerificationRecord; reason: string };
export type FeatureResult = { id: string; verified: string[]; unverified: string[]; unreachable: string[]; complete: boolean };
export type FeatureCheck = { accepted: VerificationRecord[]; refused: Refusal[]; features: FeatureResult[]; unverified: { featureId: string; entryPoint: string }[]; problems: string[] };

export const checkFeatures = (features: Feature[], records: VerificationRecord[]): FeatureCheck => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    if (seen.has(f.id)) problems.push(`feature ${f.id} is listed twice`);
    seen.add(f.id);
    if (f.entryPoints.length === 0) problems.push(`feature ${f.id} has no entry point`);
    if (new Set(f.entryPoints).size !== f.entryPoints.length) problems.push(`feature ${f.id} lists an entry point twice`);
    if (f.words.trim() === "") problems.push(`feature ${f.id} has no words`);
  }
  const byId = new Map(features.map((f) => [f.id, f]));
  const accepted: VerificationRecord[] = [];
  const refused: Refusal[] = [];
  for (const r of records) {
    const f = byId.get(r.featureId);
    const refuse = (reason: string): void => void refused.push({ record: r, reason });
    if (!f) refuse(`no feature ${r.featureId} in the map`);
    else if (!f.entryPoints.includes(r.claimedEntryPoint)) refuse(`${r.claimedEntryPoint} is not an entry point of ${r.featureId}`);
    else if (r.usedEntryPoint !== r.claimedEntryPoint) refuse(`claimed through ${r.claimedEntryPoint} but driven through ${r.usedEntryPoint}: a different path is not verification of this one`);
    else if (r.evidence.trim() === "") refuse("no evidence");
    else if (r.status === "unreachable" && ((r.prerequisite ?? "").trim() === "" || (r.routeTried ?? "").trim() === "")) refuse("unreachable needs the prerequisite and the route tried");
    else accepted.push(r);
  }
  const results: FeatureResult[] = features.map((f) => {
    const mine = accepted.filter((r) => r.featureId === f.id);
    const verified = f.entryPoints.filter((e) => mine.some((r) => r.claimedEntryPoint === e && r.status === "verified"));
    const unreachable = f.entryPoints.filter((e) => !verified.includes(e) && mine.some((r) => r.claimedEntryPoint === e && r.status === "unreachable"));
    const unverified = f.entryPoints.filter((e) => !verified.includes(e) && !unreachable.includes(e));
    return { id: f.id, verified, unverified, unreachable, complete: f.entryPoints.length > 0 && verified.length + unreachable.length === f.entryPoints.length };
  });
  const unverified = results.flatMap((r) => r.unverified.map((entryPoint) => ({ featureId: r.id, entryPoint })));
  return { accepted, refused, features: results, unverified, problems };
};
