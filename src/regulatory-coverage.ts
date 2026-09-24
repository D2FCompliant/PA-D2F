export type CoverageStatus = "IMPLEMENTED" | "PARTIAL" | "BLOCKED_OFFICIAL_ARTIFACT" | "NOT_APPLICABLE";

export type RegulatoryFlowCoverage = {
  flow: string;
  label: string;
  obligation: "CORE" | "CONDITIONAL" | "INTEROPERABILITY" | "OUTSIDE_PA_SCOPE";
  status: CoverageStatus;
  implementedControls: string[];
  missingProof: string[];
  source: string;
};

const OFFICIAL_DGFIP = "DGFiP/AIFE specifications externes v3.2 (2026-04-30)";
const AFNOR = "AFNOR XP Z12-012/013/014 (applicable versions)";

export const REGULATORY_FLOWS: RegulatoryFlowCoverage[] = [
  {
    flow: "1", label: "Données réglementaires de facture vers le PPF", obligation: "CORE", status: "IMPLEMENTED",
    implementedControls: ["Flux 1 v1.2 XSD", "EN16931", "FNFE France 1.4.0.04", "BT-49", "preuve SHA-256"], missingProof: [], source: OFFICIAL_DGFIP,
  },
  {
    flow: "2", label: "Facture B2B domestique entre PA dans un format du socle", obligation: "CORE", status: "PARTIAL",
    implementedControls: ["UBL/CII/Factur-X detection", "EN16931", "FNFE France 1.4.0.04"],
    missingProof: ["Contrat d'API XP Z12-013 exécutable", "transport PA-à-PA et accusés interopérables"], source: AFNOR,
  },
  {
    flow: "3", label: "Facture B2B domestique hors format du socle", obligation: "CONDITIONAL", status: "BLOCKED_OFFICIAL_ARTIFACT",
    implementedControls: [], missingProof: ["Accord bilatéral", "profil sectoriel/versionné", "mapping vers le socle et tests de non-régression"], source: AFNOR,
  },
  { flow: "4", label: "Circuit B2G sortant", obligation: "CONDITIONAL", status: "BLOCKED_OFFICIAL_ARTIFACT", implementedControls: [], missingProof: ["Contrat Chorus Pro applicable et environnement de recette"], source: OFFICIAL_DGFIP },
  { flow: "5", label: "Circuit B2G entrant", obligation: "CONDITIONAL", status: "BLOCKED_OFFICIAL_ARTIFACT", implementedControls: [], missingProof: ["Contrat Chorus Pro applicable et environnement de recette"], source: OFFICIAL_DGFIP },
  {
    flow: "6", label: "Statuts de cycle de vie PA ↔ PPF au format CDAR", obligation: "CORE", status: "PARTIAL",
    implementedControls: ["machine d'états", "ordre des transitions", "événements immuables", "code 212 encaissée"],
    missingProof: ["schéma CDAR XP Z12-012 complet", "tous les codes/statuts obligatoires et cas d'usage", "allotissement F6"], source: `${OFFICIAL_DGFIP}; ${AFNOR}`,
  },
  {
    flow: "7", label: "Statuts de cycle de vie hors CDAR entre PA", obligation: "CONDITIONAL", status: "BLOCKED_OFFICIAL_ARTIFACT",
    implementedControls: [], missingProof: ["accord bilatéral", "format structuré convenu", "mapping bidirectionnel vers CDAR et matrice des statuts"], source: AFNOR,
  },
  {
    flow: "8", label: "Factures B2B internationales structurées", obligation: "CORE", status: "BLOCKED_OFFICIAL_ARTIFACT",
    implementedControls: [], missingProof: ["profil Flux 8 XP Z12-012", "règles de constitution du e-reporting", "jeux d'essai officiels"], source: AFNOR,
  },
  {
    flow: "9", label: "Factures B2C/non-assujettis structurées", obligation: "CORE", status: "BLOCKED_OFFICIAL_ARTIFACT",
    implementedControls: [], missingProof: ["profil Flux 9 XP Z12-012", "règles de constitution du e-reporting", "jeux d'essai officiels"], source: AFNOR,
  },
  ...["10.1", "10.2", "10.3", "10.4"].map((flow): RegulatoryFlowCoverage => ({
    flow, label: `E-reporting ${flow}`, obligation: "CORE", status: "IMPLEMENTED",
    implementedControls: ["XSD officiel v3.2", "règles de gestion Annexe 7", "classification stricte", "preuve SHA-256"],
    missingProof: [], source: OFFICIAL_DGFIP,
  })),
  {
    flow: "11", label: "Consultation de l'annuaire par l'entreprise via sa PA", obligation: "CORE", status: "PARTIAL",
    implementedControls: ["résolution SIRET puis SIREN", "code service", "BT-49 sans invention", "preuve de source/version"],
    missingProof: ["synchronisation réelle du PPF désactivée en sandbox", "SLA et reprise sur indisponibilité"], source: OFFICIAL_DGFIP,
  },
  {
    flow: "12", label: "Informations de routage entreprise → PA", obligation: "CORE", status: "PARTIAL",
    implementedControls: ["validation XSD Annuaire Flux 12"], missingProof: ["workflow complet de demande et décision"], source: OFFICIAL_DGFIP,
  },
  {
    flow: "13", label: "Actualisation de l'annuaire PA → PPF", obligation: "CORE", status: "PARTIAL",
    implementedControls: ["validation XSD Annuaire Flux 13", "provisionnement idempotent du miroir sandbox"],
    missingProof: ["appel PPF réel désactivé en sandbox", "allotissement et accusés F13"], source: OFFICIAL_DGFIP,
  },
  {
    flow: "14", label: "Extraction/consultation de l'annuaire PPF → PA", obligation: "CORE", status: "PARTIAL",
    implementedControls: ["validation XSD Annuaire Flux 14", "résolution active et tenant-isolée"],
    missingProof: ["téléchargement incrémental réel du PPF désactivé en sandbox", "reprise et contrôle de complétude"], source: OFFICIAL_DGFIP,
  },
];

export function regulatoryCoverage(applicationVersion: string, dgfipBaseline: string) {
  const blocking = REGULATORY_FLOWS.filter((item) => item.obligation !== "OUTSIDE_PA_SCOPE" && item.status !== "IMPLEMENTED");
  return {
    readiness: blocking.length ? "INCOMPLETE" : "COMPLETE",
    productionParityClaim: false,
    environment: "sandbox",
    warning: "Only IMPLEMENTED flows are asserted. PARTIAL and BLOCKED flows must fail closed; this sandbox is not an accredited PA.",
    versions: { application: applicationVersion, dgfip: dgfipBaseline },
    totals: {
      declared: REGULATORY_FLOWS.length,
      implemented: REGULATORY_FLOWS.filter((item) => item.status === "IMPLEMENTED").length,
      partial: REGULATORY_FLOWS.filter((item) => item.status === "PARTIAL").length,
      blocked: REGULATORY_FLOWS.filter((item) => item.status === "BLOCKED_OFFICIAL_ARTIFACT").length,
    },
    flows: REGULATORY_FLOWS,
  };
}
